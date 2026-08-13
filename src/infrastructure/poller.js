/**
 * Unified background polling service.
 *
 * Long-running maintenance tasks (lease expiry sweeps, cache maintenance,
 * egress refresh, prefetch queues) register here so scheduling, jitter,
 * error handling and observability stay in one place.
 */
export function createPoller({
  intervalMs = 60_000,
  jitterRatio = 0.2,
  now = () => Date.now(),
  logger = { debug() {}, info() {}, warn() {}, error() {} },
} = {}) {
  const tasks = new Map();
  let running = false;
  let timer;

  function register(name, fn, { interval: taskIntervalMs, runImmediately = false } = {}) {
    if (tasks.has(name)) return tasks.get(name);
    const task = {
      name: String(name),
      fn,
      intervalMs: Math.max(10, Number(taskIntervalMs) || intervalMs),
      jitterRatio: Math.min(0.5, Math.max(0, Number(jitterRatio) || 0)),
      runImmediately: Boolean(runImmediately),
      lastRunAt: 0,
      lastDurationMs: 0,
      failures: 0,
      consecutiveFailures: 0,
      ticks: 0,
    };
    tasks.set(task.name, task);
    return task;
  }

  async function runTask(task) {
    const startedAt = now();
    try {
      await task.fn();
      task.consecutiveFailures = 0;
    } catch (error) {
      task.failures += 1;
      task.consecutiveFailures += 1;
      logger.warn('poller_task_failed', { task: task.name, failures: task.failures, error: error.message });
    }
    task.lastRunAt = now();
    task.lastDurationMs = task.lastRunAt - startedAt;
    task.ticks += 1;
  }

  function scheduleNext() {
    if (!running) return;
    const scheduled = [...tasks.values()];
    if (!scheduled.length) return;
    const timestamp = now();
    // A never-run task is due one interval after registration (start).
    const earliest = Math.min(...scheduled.map((task) => (
      task.lastRunAt > 0 ? task.lastRunAt + task.intervalMs - timestamp : task.intervalMs
    )));
    const base = Math.max(10, earliest);
    const jitter = base * jitterRatio;
    const delay = Math.max(10, base + Math.random() * jitter);
    timer = setTimeout(() => {
      timer = undefined;
      // Await the tick so a slow task cannot overlap its own next run.
      tick().finally(scheduleNext);
    }, delay);
    timer.unref?.();
  }

  async function tick() {
    // Only tasks whose own interval has elapsed run; the timer wakes at the
    // earliest due time across all tasks, not at a global cadence.
    const timestamp = now();
    for (const task of tasks.values()) {
      if (!running) return;
      if (timestamp - task.lastRunAt < task.intervalMs) continue;
      try {
        await runTask(task);
      } catch {
        // runTask already captures failures; never let one task stop the loop.
      }
    }
  }

  function start() {
    if (running) return;
    running = true;
    for (const task of tasks.values()) {
      if (task.runImmediately && !task.lastRunAt) {
        runTask(task).catch(() => {});
      }
    }
    scheduleNext();
  }

  function stop() {
    running = false;
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  }

  function stats() {
    return {
      running,
      tasks: [...tasks.values()].map((task) => ({
        name: task.name,
        ticks: task.ticks,
        failures: task.failures,
        consecutiveFailures: task.consecutiveFailures,
        lastRunAt: task.lastRunAt,
        lastDurationMs: task.lastDurationMs,
      })),
    };
  }

  return { register, start, stop, tick, stats };
}
