/**
 * frame.jobs schedule (cron) bridge — node-server implementation.
 *
 * Mirrors clean-server/src/jobs.rs cron scheduler:
 *   - 5-field cron expression parser (`min hour dom month dow`),
 *     fields support `*`, `*` /n step, comma lists, and `a-b` ranges.
 *   - Per-schedule timer wheel: each active schedule owns a setTimeout that
 *     computes the next tick, sleeps until then, fires the WASM handler, and
 *     re-arms itself.
 *   - Registry is in-memory; the host is expected to re-call `_schedule_cron`
 *     for every named schedule on each start (matches clean-server semantics).
 *
 * Handler firing reuses the init-instance WASM exports — `server.ts` retains
 * the init `WasmState` after `start()` and calls `startScheduler(state)`.
 *
 * Signature reference: foundation/platform-architecture/function-registry.toml
 * (entries with category = "jobs", names `_schedule_cron` / `_schedule_cancel`).
 * WASM-level ABI: each `string` param expands to a (ptr, len) i32 pair, return
 * is i32 (1 = success, 0 = failure) — matches clean-server's bridge.rs wrappers.
 */
import { WasmState } from '../types';
import { readString } from './helpers';
import { withWasmScope } from '../wasm/memory';

// ---------------------------------------------------------------------------
// Cron expression parsing
// ---------------------------------------------------------------------------

type CronField =
  | { kind: 'star' }
  | { kind: 'step'; n: number }
  | { kind: 'list'; values: number[] };

interface CronFields {
  minute: CronField; // 0–59
  hour:   CronField; // 0–23
  dom:    CronField; // 1–31
  month:  CronField; // 1–12
  dow:    CronField; // 0–6 (Sunday = 0)
}

function parseField(s: string): CronField | null {
  if (s === '*') return { kind: 'star' };
  if (s.startsWith('*/')) {
    const n = Number(s.slice(2));
    if (!Number.isInteger(n) || n <= 0) return null;
    return { kind: 'step', n };
  }
  const values: number[] = [];
  for (const part of s.split(',')) {
    const trimmed = part.trim();
    if (trimmed === '') return null;
    const dash = trimmed.indexOf('-');
    if (dash >= 0) {
      const a = Number(trimmed.slice(0, dash).trim());
      const b = Number(trimmed.slice(dash + 1).trim());
      if (!Number.isInteger(a) || !Number.isInteger(b) || a > b) return null;
      for (let v = a; v <= b; v++) values.push(v);
    } else {
      const v = Number(trimmed);
      if (!Number.isInteger(v)) return null;
      values.push(v);
    }
  }
  if (values.length === 0) return null;
  return { kind: 'list', values };
}

function parseCronFields(expr: string): CronFields | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const minute = parseField(parts[0]); if (!minute) return null;
  const hour   = parseField(parts[1]); if (!hour)   return null;
  const dom    = parseField(parts[2]); if (!dom)    return null;
  const month  = parseField(parts[3]); if (!month)  return null;
  const dow    = parseField(parts[4]); if (!dow)    return null;
  return { minute, hour, dom, month, dow };
}

function fieldMatches(field: CronField, value: number): boolean {
  switch (field.kind) {
    case 'star': return true;
    case 'step': return field.n > 0 && value % field.n === 0;
    case 'list': return field.values.includes(value);
  }
}

export function isValidCron(expr: string): boolean {
  return parseCronFields(expr) !== null;
}

/**
 * Compute milliseconds from `now` until the next tick of a 5-field cron
 * expression. Scans forward minute-by-minute up to one year, returns null if no
 * match (guards against impossible expressions like `0 0 31 2 *`).
 *
 * Times are evaluated in the host's local timezone — matches clean-server's
 * use of `chrono::Utc::now()` semantically (both interpret the cron fields
 * against the wall-clock the process sees).
 */
export function nextCronTickMs(expr: string, now: Date = new Date()): number | null {
  const fields = parseCronFields(expr);
  if (!fields) return null;

  const base = new Date(now.getTime());
  base.setSeconds(0, 0);
  let candidate = new Date(base.getTime() + 60_000);

  const limit = 366 * 24 * 60;
  for (let i = 0; i < limit; i++) {
    const m  = candidate.getMinutes();
    const h  = candidate.getHours();
    const d  = candidate.getDate();
    const mo = candidate.getMonth() + 1;
    const wd = candidate.getDay();

    if (
      fieldMatches(fields.minute, m) &&
      fieldMatches(fields.hour,   h) &&
      fieldMatches(fields.dom,    d) &&
      fieldMatches(fields.month,  mo) &&
      fieldMatches(fields.dow,    wd)
    ) {
      return Math.max(0, candidate.getTime() - now.getTime());
    }
    candidate = new Date(candidate.getTime() + 60_000);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Schedule registry
// ---------------------------------------------------------------------------

interface ScheduleEntry {
  name: string;
  cronExpr: string;
  handler: string;
  active: boolean;
  timer: NodeJS.Timeout | null;
}

const schedules = new Map<string, ScheduleEntry>();
let schedulerState: WasmState | null = null;
let schedulerStarted = false;

function logSchedule(msg: string, err?: unknown): void {
  if (err !== undefined) {
    const detail = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error(`[schedule] ${msg}: ${detail}`);
  } else if (schedulerState?.config?.verbose) {
    // eslint-disable-next-line no-console
    console.log(`[schedule] ${msg}`);
  }
}

function fireHandler(entry: ScheduleEntry): void {
  const state = schedulerState;
  if (!state) return;
  const handler = state.exports[entry.handler];
  if (typeof handler !== 'function') {
    logSchedule(`'${entry.name}': handler '${entry.handler}' not found in WASM exports`);
    return;
  }
  try {
    // Cron handlers run on the long-lived init instance, so without scope
    // rewind every tick permanently advances the bump pointer — a once-per-
    // minute job leaks indefinitely. See NSR-NO-PER-REQUEST-MEMORY-RELEASE.
    withWasmScope(state.exports, () => (handler as () => unknown)());
  } catch (err) {
    logSchedule(`'${entry.name}': handler '${entry.handler}' threw`, err);
  }
}

function scheduleNext(entry: ScheduleEntry): void {
  if (!entry.active || !schedulerStarted) return;
  const delay = nextCronTickMs(entry.cronExpr);
  if (delay === null) {
    logSchedule(`'${entry.name}': cron '${entry.cronExpr}' has no next tick within 1 year, deactivating`);
    entry.active = false;
    return;
  }
  entry.timer = setTimeout(() => {
    entry.timer = null;
    if (!entry.active) return;
    fireHandler(entry);
    scheduleNext(entry);
  }, delay);
  // setTimeout returns a Timeout that keeps the event loop alive. That's the
  // intended behavior: a server with active schedules should not exit just
  // because there are no in-flight HTTP requests. To make tests deterministic,
  // unref() can be called by the caller; production uses the default (ref).
}

/**
 * Begin firing registered schedules against the provided WASM instance.
 * Must be called once after the init instance's `start()` has registered all
 * schedules via `_schedule_cron`. Idempotent.
 */
export function startScheduler(state: WasmState): void {
  if (schedulerStarted) return;
  schedulerState = state;
  schedulerStarted = true;
  logSchedule(`scheduler started with ${schedules.size} registered schedule(s)`);
  for (const entry of schedules.values()) {
    if (entry.active) scheduleNext(entry);
  }
}

/**
 * Cancel every active schedule, clear timers, drop the WASM-state reference,
 * and reset the registry. Call during shutdown or between tests.
 */
export function stopScheduler(): void {
  for (const entry of schedules.values()) {
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    entry.active = false;
  }
  schedules.clear();
  schedulerState = null;
  schedulerStarted = false;
}

/**
 * Test-only accessor — returns a snapshot of the current schedule registry
 * for assertions. The returned objects are clones; mutating them does not
 * affect the live registry.
 */
export function _getScheduleSnapshotForTest(): Array<Omit<ScheduleEntry, 'timer'>> {
  return [...schedules.values()].map(e => ({
    name: e.name,
    cronExpr: e.cronExpr,
    handler: e.handler,
    active: e.active,
  }));
}

// ---------------------------------------------------------------------------
// Bridge functions
// ---------------------------------------------------------------------------

export function createScheduleBridge(getState: () => WasmState) {
  return {
    /**
     * Register a cron-scheduled handler.
     *
     * Registry signature: params=["string", "string", "string"], returns="ptr"
     * — `ptr` collapses to i32 at the WASM-shape layer. The clean-server
     * canonical impl returns 1/0 (i32) where 1 = registered, 0 = invalid cron.
     * Node-server matches that contract.
     */
    _schedule_cron(
      namePtr: number, nameLen: number,
      cronPtr: number, cronLen: number,
      handlerPtr: number, handlerLen: number,
    ): number {
      const state = getState();
      const name = readString(state, namePtr, nameLen);
      const cronExpr = readString(state, cronPtr, cronLen);
      const handler = readString(state, handlerPtr, handlerLen);

      if (!isValidCron(cronExpr)) {
        logSchedule(`'${name}': invalid cron expression '${cronExpr}', not registering`);
        return 0;
      }

      const existing = schedules.get(name);
      if (existing?.timer) {
        clearTimeout(existing.timer);
        existing.timer = null;
      }

      const entry: ScheduleEntry = {
        name, cronExpr, handler, active: true, timer: null,
      };
      schedules.set(name, entry);
      logSchedule(`'${name}': registered (expr='${cronExpr}', handler='${handler}')`);

      if (schedulerStarted) scheduleNext(entry);
      return 1;
    },

    /**
     * Cancel a registered schedule by name.
     *
     * Returns 1 if an active schedule was cancelled, 0 if the name is unknown
     * or already inactive — matches clean-server's `schedule_cancel`.
     */
    _schedule_cancel(namePtr: number, nameLen: number): number {
      const state = getState();
      const name = readString(state, namePtr, nameLen);
      const entry = schedules.get(name);
      if (!entry || !entry.active) return 0;
      entry.active = false;
      if (entry.timer) {
        clearTimeout(entry.timer);
        entry.timer = null;
      }
      logSchedule(`'${name}': cancelled`);
      return 1;
    },
  };
}
