const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_SESSIONS = 64;

export function createDownloadSessionStore({
  now = Date.now,
  ttlMs = DEFAULT_TTL_MS,
  maxSessions = DEFAULT_MAX_SESSIONS,
} = {}) {
  const sessions = new Map();

  function purgeExpired() {
    const timestamp = now();
    for (const [id, session] of sessions) {
      if (session.expiresAt <= timestamp) sessions.delete(id);
    }
  }

  function create({ id, target, size, chunkSize, chunks }) {
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
    return session;
  }

  function get(id) {
    purgeExpired();
    return sessions.get(String(id || ''));
  }

  function markChunkDone(id, index) {
    const session = get(id);
    if (!session) return false;
    const chunk = session.chunks.find((entry) => entry.index === Number(index));
    if (!chunk || chunk.status === 'done') return false;
    chunk.status = 'done';
    chunk.updatedAt = now();
    session.doneBytes += chunk.size;
    return true;
  }

  function stats() {
    purgeExpired();
    let totalBytes = 0;
    let doneBytes = 0;
    for (const session of sessions.values()) {
      totalBytes += session.size;
      doneBytes += session.doneBytes;
    }
    return { sessions: sessions.size, totalBytes, doneBytes };
  }

  return { create, get, markChunkDone, stats };
}
