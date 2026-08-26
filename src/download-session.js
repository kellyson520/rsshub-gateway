import { randomUUID } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import path from 'node:path';

const VERSION = 1;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_SESSIONS = 64;
const CHUNK_STATUSES = new Set(['pending', 'done']);

function validChunk(chunk) {
  return Boolean(
    chunk
    && typeof chunk === 'object'
    && Number.isInteger(chunk.index)
    && chunk.index >= 0
    && Number.isFinite(chunk.start)
    && Number.isFinite(chunk.end)
    && Number.isFinite(chunk.size)
    && typeof chunk.url === 'string'
    && CHUNK_STATUSES.has(chunk.status)
    && Number.isFinite(chunk.updatedAt),
  );
}

function validSession(session, now) {
  return Boolean(
    session
    && typeof session === 'object'
    && typeof session.id === 'string'
    && session.id
    && typeof session.target === 'string'
    && session.target
    && Number.isFinite(session.size)
    && Number.isFinite(session.chunkSize)
    && Number.isFinite(session.createdAt)
    && Number.isFinite(session.expiresAt)
    && session.expiresAt > now
    && Array.isArray(session.chunks)
    && session.chunks.length > 0
    && session.chunks.every(validChunk),
  );
}

export {
  validChunk,
  validSession,
  DEFAULT_TTL_MS,
  DEFAULT_MAX_SESSIONS,
};

export function createDownloadSessionStore({
  now = Date.now,
  ttlMs = DEFAULT_TTL_MS,
  maxSessions = DEFAULT_MAX_SESSIONS,
  file,
} = {}) {
  const sessions = new Map();
  const targetFile = file ? path.resolve(file) : null;
  let persistChain = Promise.resolve();

  function purgeExpired() {
    const timestamp = now();
    for (const [id, session] of sessions) {
      if (session.expiresAt <= timestamp) sessions.delete(id);
    }
  }

  async function writeRecords() {
    const payload = JSON.stringify({ version: VERSION, sessions: [...sessions.values()] });
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
    if (!targetFile) return Promise.resolve();
    persistChain = persistChain.then(writeRecords, writeRecords);
    return persistChain;
  }

  async function load() {
    if (!targetFile) return;
    let payload;
    try {
      payload = JSON.parse(await fsp.readFile(targetFile, 'utf8'));
    } catch {
      return;
    }
    if (payload?.version !== VERSION || !Array.isArray(payload.sessions)) return;
    const current = now();
    for (const record of payload.sessions) {
      if (!validSession(record, current)) continue;
      sessions.set(record.id, {
        id: record.id,
        target: record.target,
        size: record.size,
        chunkSize: record.chunkSize,
        createdAt: record.createdAt,
        expiresAt: record.expiresAt,
        doneBytes: record.chunks
          .filter((chunk) => chunk.status === 'done')
          .reduce((total, chunk) => total + chunk.size, 0),
        chunks: record.chunks.map((chunk) => ({
          index: chunk.index,
          start: chunk.start,
          end: chunk.end,
          size: chunk.size,
          url: chunk.url,
          status: chunk.status,
          updatedAt: chunk.updatedAt,
        })),
      });
    }
  }

  const ready = load();

  async function create({ id, target, size, chunkSize, chunks }) {
    await ready;
    purgeExpired();
    const timestamp = now();
    const session = {
      id: String(id || ''),
      target: String(target || ''),
      size: Number(size),
      chunkSize: Number(chunkSize),
      createdAt: timestamp,
      expiresAt: timestamp + ttlMs,
      doneBytes: 0,
      chunks: chunks.map((chunk) => ({
        index: Number(chunk.index),
        start: Number(chunk.start),
        end: Number(chunk.end),
        size: Number(chunk.size),
        url: String(chunk.url || ''),
        status: 'pending',
        updatedAt: timestamp,
      })),
    };
    if (!session.id) throw new Error('download session id is required');
    sessions.set(session.id, session);
    while (sessions.size > maxSessions) {
      const oldest = [...sessions.values()].sort((left, right) => left.createdAt - right.createdAt)[0];
      sessions.delete(oldest.id);
    }
    await persist();
    return session;
  }

  async function get(id) {
    await ready;
    purgeExpired();
    return sessions.get(String(id || ''));
  }

  async function revoke(idOrTarget) {
    await ready;
    purgeExpired();
    const query = String(idOrTarget || '').trim();
    if (!query) return { revoked: 0 };
    let count = 0;
    if (sessions.has(query)) {
      sessions.delete(query);
      count += 1;
    }
    for (const [id, session] of sessions) {
      if (session.target === query) {
        sessions.delete(id);
        count += 1;
      }
    }
    if (count > 0) {
      await persist();
    }
    return { revoked: count };
  }

  async function markChunkDone(id, index) {
    if (!Number.isInteger(index) || index < 0) return false;
    await ready;
    const session = await get(id);
    if (!session) return false;
    const chunk = session.chunks.find((entry) => entry.index === index);
    if (!chunk || chunk.status === 'done') return false;
    chunk.status = 'done';
    chunk.updatedAt = now();
    session.doneBytes += chunk.size;
    await persist();
    return true;
  }

  async function stats() {
    await ready;
    purgeExpired();
    let totalBytes = 0;
    let doneBytes = 0;
    for (const session of sessions.values()) {
      totalBytes += session.size;
      doneBytes += session.doneBytes;
    }
    return { sessions: sessions.size, totalBytes, doneBytes };
  }

  return {
    create,
    get,
    revoke,
    markChunkDone,
    stats,
    flush: () => persistChain,
    file: targetFile,
  };
}
