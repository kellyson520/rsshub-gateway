export class GatewayUpstreamError extends Error {
  constructor(message, { code, source = 'unknown', status = 502, attempts = 0, retryAfter } = {}) {
    super(message);
    this.name = 'GatewayUpstreamError';
    this.code = code;
    this.source = source;
    this.status = status;
    this.attempts = attempts;
    if (retryAfter !== undefined) this.retryAfter = retryAfter;
  }
}

export function isClientAbortError(error) {
  if (!error) return false;
  const message = String(error.message || '').toLowerCase();
  const code = String(error.code || '').toUpperCase();
  return code === 'ECONNRESET'
    || code === 'ERR_STREAM_PREMATURE_CLOSE'
    || code === 'ABORT_ERR'
    || message.includes('client response closed')
    || message.includes('aborted');
}

export function isRetryableStatus(status) {
  return Number.isInteger(status) && (status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599));
}
