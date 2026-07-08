import { getLogger } from './logger';

/**
 * Poll `process.memoryUsage().rss` and trigger a graceful drain-and-exit when
 * the soft limit is crossed. This exists so the process voluntarily leaves
 * the ring before the kernel's cgroup memory throttle
 * (`mem_cgroup_handle_over_high`) pins the event-loop thread in D-state.
 *
 * Contract: `onExceeded` is called at most once. It should stop accepting new
 * work, drain in-flight, and eventually call `process.exit(0)` so systemd's
 * Restart=always brings the service back cleanly.
 */

export interface MemoryGuardHandle {
  /** Stop polling. Safe to call multiple times. */
  stop(): void;
  /** Current RSS bytes at last sample. Zero before first sample. */
  lastRssBytes(): number;
}

export function startMemoryGuard(
  limitBytes: number,
  pollMs: number,
  onExceeded: (rss: number) => void,
): MemoryGuardHandle {
  const log = getLogger();
  let lastRss = 0;
  let fired = false;

  const timer = setInterval(() => {
    lastRss = process.memoryUsage().rss;
    if (!fired && lastRss >= limitBytes) {
      fired = true;
      clearInterval(timer);
      log.warn(
        { rssBytes: lastRss, limitBytes },
        'Memory soft limit exceeded — beginning graceful drain-and-exit',
      );
      try {
        onExceeded(lastRss);
      } catch (err) {
        log.error({ err }, 'memory-guard onExceeded threw');
      }
    }
  }, pollMs);
  timer.unref();

  return {
    stop(): void {
      clearInterval(timer);
    },
    lastRssBytes(): number {
      return lastRss;
    },
  };
}
