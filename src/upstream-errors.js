import {
  DEFAULT_BLOCKED_STATUSES,
  isClientAbortError,
  isRetryableStatus,
  isSuccessfulStatus,
  RETRYABLE_STATUSES,
} from './http-utils.js';

export const DEFAULT_UPSTREAM_ERROR_STATUS = 502;
export const DEFAULT_UPSTREAM_SOURCE = 'unknown';

export class GatewayUpstreamError extends Error {
  constructor(message, { code, source = DEFAULT_UPSTREAM_SOURCE, status = DEFAULT_UPSTREAM_ERROR_STATUS, attempts = 0, retryAfter } = {}) {
    super(message);
    this.name = 'GatewayUpstreamError';
    this.code = code;
    this.source = source;
    this.status = status;
    this.attempts = attempts;
    if (retryAfter !== undefined) this.retryAfter = retryAfter;
  }
}

export {
  DEFAULT_BLOCKED_STATUSES,
  isClientAbortError,
  isRetryableStatus,
  isSuccessfulStatus,
  RETRYABLE_STATUSES,
};
