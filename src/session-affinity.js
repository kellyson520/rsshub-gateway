import { randomUUID } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_CACHE_ROOT } from './options.js';
import {
  atomicWriteJson,
  chooseLane,
  DEFAULT_SESSION_AFFINITY_MAX_AGE_MS as DEFAULT_MAX_AGE_MS,
  DEFAULT_SESSION_AFFINITY_VERSION as VERSION,
  fingerprintFor,
  isValidAffinityRecord as validRecord,
  normalizedCredentials,
  normalizedLaneIds,
  proxyIdentityHash,
  safeJsonParse,
} from './http-utils.js';

export {
  VERSION,
  DEFAULT_MAX_AGE_MS,
  DEFAULT_CACHE_ROOT,
  fingerprintFor,
  normalizedLaneIds,
  normalizedCredentials,
  chooseLane,
  proxyIdentityHash,
  validRecord,
};

export function createSessionAffinity({
  root = process.env.GATEWAY_CACHE_DIR || DEFAULT_CACHE_ROOT,
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
    try {
      await atomicWriteJson(targetFile, { version: VERSION, records: [...records.values()] }, { mode: 0o600, dirMode: 0o700 });
    } catch {
      // Best-effort persistence.
    }
  }

  function persist() {
    persistChain = persistChain.then(writeRecords, writeRecords);
    return persistChain;
  }

  async function load() {
    let payload;
    try {
      const content = await fsp.readFile(targetFile, 'utf8');
      payload = safeJsonParse(content, null);
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
