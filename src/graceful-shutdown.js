export function installGracefulShutdown({
  servers = [],
  timeoutMs = 10_000,
  signals = ['SIGTERM', 'SIGINT'],
  logger,
  exitImpl = (code) => process.exit(code),
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  let draining = false;

  function stopAccepting() {
    for (const server of servers) {
      if (!server) continue;
      try {
        server.close?.();
      } catch {
        // The server may already be closed; draining continues regardless.
      }
      if (typeof server.closeIdleConnections === 'function') {
        server.closeIdleConnections();
      }
    }
  }

  function drain() {
    return Promise.all(servers.map((server) => new Promise((resolve) => {
      if (!server || typeof server.close !== 'function' || server.listening === false) {
        resolve();
        return;
      }
      server.once('close', resolve);
    })));
  }

  function shutdown(signal = 'SIGTERM') {
    if (draining) return false;
    draining = true;
    logger?.info('shutdown_draining', { signal, timeoutMs });
    stopAccepting();
    const force = setTimeoutImpl(() => {
      logger?.warn('shutdown_timeout', { timeoutMs });
      exitImpl(1);
    }, timeoutMs);
    if (force?.unref) force.unref();
    void drain().then(() => {
      clearTimeoutImpl(force);
      logger?.info('shutdown_drained');
      exitImpl(0);
    });
    return true;
  }

  const handlers = new Map();
  for (const signal of signals) {
    const handler = () => shutdown(signal);
    process.on(signal, handler);
    handlers.set(signal, handler);
  }

  return {
    isDraining: () => draining,
    shutdown,
    dispose: () => {
      for (const [signal, handler] of handlers) {
        process.removeListener(signal, handler);
      }
      handlers.clear();
    },
  };
}
