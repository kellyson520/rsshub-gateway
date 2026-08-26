import { createHash, createHmac, randomUUID } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import path from 'node:path';

const VERSION = 1;
const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;

function normalizedLaneIds(value) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map((laneId) => String(laneId || '').trim())
    .filter(Boolean))].sort();
}

function normalizedCredentials(credentials = {}) {
  const entries = credentials instanceof Headers
    ? [...credentials.entries()]
    : Object.entries(credentials || {});
  return entries
    .map(([name, value]) => [String(name || '').trim().toLowerCase(), String(value || '').trim()])
    .filter(([name, value]) => name && value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}=${value}`)
    .join('\n');
}

function fingerprintFor(source, credentials, secret) {
  return createHmac('sha256', secret)
    .update(`${String(source || '').trim().toLowerCase()}\n${normalizedCredentials(credentials)}`)
    .digest('hex');
}

function proxyIdentityHash(value) {
  return value ? createHash('sha256').update(String(value)).digest('hex') : '';
}

function chooseLane(fingerprint, laneIds, unhealthyLanes) {
  const candidates = laneIds.filter((laneId) => !unhealthyLanes.has(laneId));
  if (!candidates.length) {
    const error = new Error('no healthy session lane is available');
    error.code = 'SESSION_LANE_UNAVAILABLE';
    throw error;
  }
  return candidates.reduce((best, laneId) => {
    if (!best) return laneId;
    const laneScore = createHash('sha256').update(`${fingerprint}\n${laneId}`).digest('hex');
    const bestScore = createHash('sha256').update(`${fingerprint}\n${best}`).digest('hex');
    return laneScore > bestScore ? laneId : best;
  }, '');
}

function validRecord(record, now, maxAgeMs) {
  return record
    && typeof record.fingerprint === 'string'
    && /^[a-f0-9]{64}$/.test(record.fingerprint)
    && typeof record.source === 'string'
    && record.source
    && typeof record.laneId === 'string'
    && record.laneId
    && Number.isFinite(record.createdAt)
    && Number.isFinite(record.updatedAt)
    && record.updatedAt <= now
    && now - record.updatedAt <= maxAgeMs;
}

export {
  VERSION,
  DEFAULT_MAX_AGE_MS,
  fingerprintFor,
  normalizedLaneIds,
  normalizedCredentials,
  chooseLane,
  proxyIdentityHash,
  validRecord,
};

export function createSessionAffinity({
  root = process.env.GATEWAY_CACHE_DIR || '/var/cache/rsshub-gateway',
  file = process.env.SESSION_AFFINITY_FILE,
  secret,
  laneIds = [],
  now = () => Date.now(),
  maxAgeMs = DEFAULT_MAX_AGE_MS,
} = {}) {
  if (!secret) throw new Error('session affinity secret is required');
  const targetFile = path.resolve(file || path.join(root, 'session-affinity.json'));
  const records = new Map();
  const unhealthyLanes = new Set();
  let configuredLaneIds = normalizedLaneIds(laneIds);
  let persistChain = Promise.resolve();

  function activeLaneIds() {
    return normalizedLaneIds(typeof laneIds === 'function' ? laneIds() : configuredLaneIds);
  }

  async function writeRecords() {
    const payload = JSON.stringify({ version: VERSION, records: [...records.values()] });
    const directory = path.dirname(targetFile);
    const temporary = `${targetFile}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
      await fsp.writeFile(temporary, payload, { encoding: 'utf8', mode: 0o600 });
      await fsp.chmod(temporary, 0o600);
      await fsp.rename(temporary, targetFile);
      await fsp.chmod(targetFile, 0o600);
    } catch {
      await fsp.rm(temporary, { force: true }).catch(() => {});
    }
  }

  function persist() {
    persistChain = persistChain.then(writeRecords, writeRecords);
    return persistChain;
  }

  async function load() {
    let payload;
    try {
      payload = JSON.parse(await fsp.readFile(targetFile, 'utf8'));
    } catch {
      return;
    }
    if (payload?.version !== VERSION || !Array.isArray(payload.records)) return;
    const current = now();
    for (const record of payload.records) {
      if (!validRecord(record, current, maxAgeMs)) continue;
      records.set(record.fingerprint, {
        fingerprint: record.fingerprint,
        source: record.source,
        laneId: record.laneId,
        proxyIdentityHash: typeof record.proxyIdentityHash === 'string' ? record.proxyIdentityHash : '',
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      });
    }
  }

  const ready = load();

  function publicRecord(record) {
    return {
      fingerprint: record.fingerprint,
      laneId: record.laneId,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  async function resolve(source, credentials, { proxyIdentity } = {}) {
    await ready;
    const normalizedSource = String(source || '').trim().toLowerCase();
    if (!normalizedSource) throw new Error('session affinity source is required');
    const fingerprint = fingerprintFor(normalizedSource, credentials, secret);
    const lanes = activeLaneIds();
    const existing = records.get(fingerprint);
    const current = now();
    const canRetain = existing
      && existing.source === normalizedSource
      && lanes.includes(existing.laneId)
      && !unhealthyLanes.has(existing.laneId);
    if (canRetain) return publicRecord(existing);

    const record = {
      fingerprint,
      source: normalizedSource,
      laneId: chooseLane(fingerprint, lanes, unhealthyLanes),
      proxyIdentityHash: proxyIdentityHash(proxyIdentity),
      createdAt: existing?.createdAt || current,
      updatedAt: current,
    };
    records.set(fingerprint, record);
    await persist();
    return publicRecord(record);
  }

  async function markLaneUnhealthy(laneId) {
    await ready;
    const normalizedLaneId = String(laneId || '').trim();
    if (!normalizedLaneId) return 0;
    unhealthyLanes.add(normalizedLaneId);
    const lanes = activeLaneIds();
    const current = now();
    let migrated = 0;
    for (const record of records.values()) {
      if (record.laneId !== normalizedLaneId) continue;
      let replacement;
      try {
        replacement = chooseLane(record.fingerprint, lanes, unhealthyLanes);
      } catch {
        // No healthy lane remains: stop instead of leaving the table half-migrated.
        break;
      }
      if (replacement === record.laneId) continue;
      record.laneId = replacement;
      record.updatedAt = current;
      migrated += 1;
    }
    if (migrated) await persist();
    return migrated;
  }

  function setLaneIds(nextLaneIds) {
    configuredLaneIds = normalizedLaneIds(nextLaneIds);
  }

  return {
    resolve,
    markLaneUnhealthy,
    setLaneIds,
    flush: () => persistChain,
    file: targetFile,
  };
}
