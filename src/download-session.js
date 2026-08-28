import {
  buildDownloadSession,
  createDownloadSessionStore as baseCreateDownloadSessionStore,
  DEFAULT_DOWNLOAD_SESSION_TTL_MS as DEFAULT_TTL_MS,
  DEFAULT_MAX_DOWNLOAD_SESSIONS as DEFAULT_MAX_SESSIONS,
  DOWNLOAD_SESSION_VERSION as VERSION,
  isValidChunkRecord as validChunk,
  isValidSessionRecord as validSession,
  restoreDownloadSessionRecord,
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

export function createDownloadSessionStore(options = {}) {
  return baseCreateDownloadSessionStore(options);
}
