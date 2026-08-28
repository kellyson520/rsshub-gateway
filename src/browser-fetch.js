import {
  browserFetchLineError as lineError,
  browserRequestTimeoutMs as requestTimeoutMs,
  buildBrowserFetchPayload,
  createBrowserFetchClient as baseCreateBrowserFetchClient,
  createFetchdCompat as baseCreateFetchdCompat,
  DEFAULT_IMPERSONATE,
  DEFAULT_MAX_BODY,
  DEFAULT_PYTHON_BIN,
  DEFAULT_REQUEST_TIMEOUT_MS,
  fetchdJson,
  MAX_REQUEST_TIMEOUT_MS,
  messageToResponse,
  REQUEST_TIMEOUT_SLACK_MS,
} from './http-utils.js';

const DEFAULT_WORKER_PATH = new URL('./fetch-worker.py', import.meta.url).pathname;

export {
  DEFAULT_PYTHON_BIN,
  DEFAULT_IMPERSONATE,
  DEFAULT_MAX_BODY,
  DEFAULT_REQUEST_TIMEOUT_MS,
  MAX_REQUEST_TIMEOUT_MS,
  REQUEST_TIMEOUT_SLACK_MS,
  lineError,
  requestTimeoutMs,
  messageToResponse,
  buildBrowserFetchPayload,
  DEFAULT_WORKER_PATH,
  fetchdJson,
};

export function createBrowserFetchClient(options = {}) {
  return baseCreateBrowserFetchClient({
    workerPath: DEFAULT_WORKER_PATH,
    ...options,
  });
}

export function createFetchdCompat(options = {}) {
  return baseCreateFetchdCompat(options);
}
