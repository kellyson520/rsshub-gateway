import { randomUUID } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import path from 'node:path';
import {
  atomicWriteJson,
  buildDownloadSession,
  CHUNK_STATUSES,
  DEFAULT_DOWNLOAD_SESSION_TTL_MS as DEFAULT_TTL_MS,
  DEFAULT_MAX_DOWNLOAD_SESSIONS as DEFAULT_MAX_SESSIONS,
  DOWNLOAD_SESSION_VERSION as VERSION,
  isValidChunkRecord as validChunk,
  isValidSessionRecord as validSession,
  restoreDownloadSessionRecord,
  safeJsonParse,
} from './http-utils.js';

export {
  validChunk,
  validSession,
  DEFAULT_TTL_MS,
  DEFAULT_MAX_SESSIONS,
  VERSION,
  buildDownloadSession,
  restoreDownloadSessionRecord,
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
    try {
      await atomicWriteJson(targetFile, { version: VERSION, sessions: [...sessions.values()] }, { mode: 0o600, dirMode: 0o700 });
    } catch {
      // Best-effort persistence.
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
      const content = await fsp.readFile(targetFile, 'utf8');
      payload = safeJsonParse(content, null);
    } catch {
      return;
    }
    if (payload?.version !== VERSION || !Array.isArray(payload.sessions)) return;
    const current = now();
    for (const record of payload.sessions) {
      if (!validSession(record, current)) continue;
      const restored = restoreDownloadSessionRecord(record);
      if (restored) sessions.set(restored.id, restored);
    }
  }

  const ready = load();

  async function create({ id, target, size, chunkSize, chunks }) {
    await ready;
    purgeExpired();
    const timestamp = now();
    const session = buildDownloadSession({ id, target, size, chunkSize, chunks, now: timestamp, ttlMs });
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
