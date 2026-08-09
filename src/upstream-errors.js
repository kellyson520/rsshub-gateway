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

export function isRetryableStatus(status) {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
}
