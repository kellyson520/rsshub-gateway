/**
 * Unified structured logging for rsshub-gateway.
 *
 * Every service logs through a single logger so events share one shape:
 * { event, level, ts, ...fields }. Sensitive fields (tokens, passwords,
 * cookies, proxy credentials) are redacted by default.
 */

const REDACT_KEYS = new Set([
  'authorization',
  'cookie',
  'token',
  'password',
  'secret',
  'proxyurl',
  'username',
  'credentials',
]);

const REDACT_VALUE = '[redacted]';

function redactValue(key, value) {
  const normalized = String(key).toLowerCase();
  if (REDACT_KEYS.has(normalized)) return REDACT_VALUE;
  if (normalized.includes('token') || normalized.includes('password') || normalized.includes('secret')) return REDACT_VALUE;
  if (typeof value === 'string' && /(bearer\s+[a-z0-9._-]+|basic\s+[a-z0-9+/=]+|cookie\s*[:=][^;]+)/i.test(value)) {
    return value.replace(/(bearer\s+)[a-z0-9._-]+/gi, '$1[redacted]')
      .replace(/(basic\s+)[a-z0-9+/=]+/gi, '$1[redacted]')
      .replace(/(cookie\s*[:=]\s*)[^;]+/gi, '$1[redacted]');
  }
  return value;
}

function redactFields(fields) {
  const output = {};
  for (const [key, value] of Object.entries(fields || {})) {
    output[key] = redactValue(key, value);
  }
  return output;
}

export const LOG_LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 });
export const DEFAULT_LOG_LEVEL = 'info';

export function createNoopLogger() {
  const noop = () => {};
  return {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => createNoopLogger(),
    sink: noop,
    threshold: 100,
  };
}

export function createLogger({
  level = process.env.GATEWAY_LOG_LEVEL || DEFAULT_LOG_LEVEL,
  sink = (line) => process.stdout.write(`${line}\n`),
  redact = true,
  now = () => Date.now(),
} = {}) {
  const levels = LOG_LEVELS;
  const threshold = levels[level] ?? levels.info;

  function write(event, fields = {}, levelName = 'info') {
    if ((levels[levelName] ?? levels.info) < threshold) return;
    const payload = {
      event,
      level: levelName,
      ts: new Date(now()).toISOString(),
      ...(redact ? redactFields(fields) : fields),
    };
    try {
      sink(JSON.stringify(payload));
    } catch {
      // Logging must never break request handling.
    }
  }

  function child(context = {}) {
    return {
      debug: (event, fields = {}) => write(event, { ...context, ...fields }, 'debug'),
      info: (event, fields = {}) => write(event, { ...context, ...fields }, 'info'),
      warn: (event, fields = {}) => write(event, { ...context, ...fields }, 'warn'),
      error: (event, fields = {}) => write(event, { ...context, ...fields }, 'error'),
    };
  }

  return {
    debug: (event, fields) => write(event, fields, 'debug'),
    info: (event, fields) => write(event, fields, 'info'),
    warn: (event, fields) => write(event, fields, 'warn'),
    error: (event, fields) => write(event, fields, 'error'),
    child,
    sink,
    threshold,
  };
}

export { REDACT_VALUE, redactValue, redactFields };
