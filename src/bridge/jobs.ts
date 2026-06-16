/**
 * frame.jobs (background job queue) bridge — node-server implementation.
 *
 * Ports the runtime semantics of clean-server/src/jobs.rs:
 *   - SQLite-persisted queue (`__clean_jobs` table) with a write-through
 *     in-memory cache of pending+running records (terminal records are evicted
 *     from memory; `_job_status` / `_job_result` fall back to the DB).
 *   - Worker poll loop (every WORKER_POLL_MS) claims due pending jobs,
 *     invokes the registered WASM handler, and applies the outcome.
 *   - Retry/backoff state machine: Fixed | Exponential (matches Rust enum and
 *     compute_delay), capped at 24 h. `_job_retry_after` overrides the
 *     computed delay for the current attempt.
 *   - Task-local current-job context via AsyncLocalStorage so `_job_current_id`,
 *     `_job_current_args`, `_job_current_attempt` work from inside the handler.
 *
 * Persistence model:
 *   - Each server process owns one SQLite file at `${cwd}/.clean/jobs.sqlite`
 *     (overridable via JOBS_DB_PATH; `:memory:` is honoured for tests).
 *   - On `startJobWorker`, the schema is created, finished rows older than
 *     JOBS_RETENTION_DAYS are deleted, then pending+running rows are loaded
 *     into the cache (running → pending so an orphaned record is retried).
 *
 * Handler firing reuses the init-instance WASM exports — `server.ts` retains
 * the init `WasmState` after `start()` and calls `startJobWorker(state)`.
 *
 * Signature reference: foundation/platform-architecture/function-registry.toml
 * (entries with category = "jobs"). WASM-level ABI matches
 * clean-server/src/bridge.rs `register_jobs_functions`.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { WasmState } from '../types';
import { readString, writeString } from './helpers';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WORKER_POLL_MS = 1_000;
const MAX_JOBS_PER_POLL = 20;
const JOBS_RETENTION_DAYS = 7;
const MAX_BACKOFF_MS = 86_400_000; // 24 hours
const EXP_SHIFT_CAP = 30;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type JobStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export type BackoffStrategy = 'fixed' | 'exponential';

function parseBackoff(s: string): BackoffStrategy {
  return s.toLowerCase() === 'exponential' ? 'exponential' : 'fixed';
}

function computeBackoffDelay(
  strategy: BackoffStrategy,
  baseMs: number,
  attempt: number,
): number {
  if (strategy === 'fixed') return baseMs;
  // attempt is 1-based; delay = base * 2^(attempt-1), capped at 24h.
  const exponent = Math.min(Math.max(attempt - 1, 0), EXP_SHIFT_CAP);
  const factor = 2 ** exponent;
  return Math.min(baseMs * factor, MAX_BACKOFF_MS);
}

interface JobConfig {
  name: string;
  handler: string;
  maxAttempts: number;
  backoff: BackoffStrategy;
  delayMs: number;
  timeoutMs: number;
  queue: string;
}

interface JobRecord {
  id: string;
  name: string;
  args: string;
  status: JobStatus;
  attempt: number;
  maxAttempts: number;
  backoff: BackoffStrategy;
  delayMs: number;
  timeoutMs: number;
  queue: string;
  handler: string;
  scheduledAt: number;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
  result: string | null;
  error: string | null;
}

interface JobLocalContext {
  id: string;
  args: string;
  attempt: number;
  retryOverrideMs: { value: number }; // -1 = not set
  explicitFail: { value: string | null };
  explicitSucceed: { value: string | null };
}

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

const configs = new Map<string, JobConfig>();
const records = new Map<string, JobRecord>();

let db: Database.Database | null = null;
let workerTimer: NodeJS.Timeout | null = null;
let workerState: WasmState | null = null;
let workerStarted = false;
let pollInFlight = false;

const jobLocal = new AsyncLocalStorage<JobLocalContext>();

function nowMs(): number {
  return Date.now();
}

function verboseLog(msg: string): void {
  if (workerState?.config?.verbose) {
    // eslint-disable-next-line no-console
    console.log(`[jobs] ${msg}`);
  }
}

function warnLog(msg: string, err?: unknown): void {
  const detail = err === undefined
    ? ''
    : `: ${err instanceof Error ? err.message : String(err)}`;
  // eslint-disable-next-line no-console
  console.error(`[jobs] ${msg}${detail}`);
}

// ---------------------------------------------------------------------------
// SQLite persistence
// ---------------------------------------------------------------------------

function resolveJobsDbPath(): string {
  const envPath = process.env.JOBS_DB_PATH;
  if (envPath) return envPath;
  const dir = path.join(process.cwd(), '.clean');
  return path.join(dir, 'jobs.sqlite');
}

function openDb(): Database.Database {
  const target = resolveJobsDbPath();
  if (target !== ':memory:') {
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
    } catch (err) {
      warnLog(`failed to create directory for ${target}, falling back to in-memory`, err);
      return new Database(':memory:');
    }
  }
  const handle = new Database(target);
  if (target !== ':memory:') {
    handle.pragma('journal_mode = WAL');
  }
  handle.pragma('foreign_keys = ON');
  return handle;
}

function ensureSchema(handle: Database.Database): void {
  handle.exec(`
    CREATE TABLE IF NOT EXISTS __clean_jobs (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      args_json       TEXT NOT NULL,
      status          TEXT NOT NULL,
      attempt         INTEGER NOT NULL DEFAULT 0,
      scheduled_at_ms INTEGER NOT NULL,
      started_at_ms   INTEGER,
      finished_at_ms  INTEGER,
      result_json     TEXT,
      error_message   TEXT,
      queue           TEXT NOT NULL DEFAULT 'default',
      created_at_ms   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_status_scheduled
      ON __clean_jobs(status, scheduled_at_ms);
  `);
}

function dbInsert(handle: Database.Database, r: JobRecord): void {
  handle.prepare(`
    INSERT INTO __clean_jobs
      (id, name, args_json, status, attempt, scheduled_at_ms, started_at_ms,
       finished_at_ms, result_json, error_message, queue, created_at_ms)
    VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?)
  `).run(
    r.id, r.name, r.args, r.status, r.attempt, r.scheduledAt,
    r.queue, r.createdAt,
  );
}

function dbUpdate(handle: Database.Database, r: JobRecord): void {
  handle.prepare(`
    UPDATE __clean_jobs
       SET status          = ?,
           attempt         = ?,
           scheduled_at_ms = ?,
           started_at_ms   = CASE WHEN ? = 'running' THEN COALESCE(started_at_ms, ?) ELSE started_at_ms END,
           finished_at_ms  = ?,
           result_json     = ?,
           error_message   = ?
     WHERE id = ?
  `).run(
    r.status, r.attempt, r.scheduledAt,
    r.status, r.updatedAt,
    r.finishedAt, r.result, r.error,
    r.id,
  );
}

interface DbRowJob {
  id: string;
  name: string;
  args_json: string;
  status: string;
  attempt: number;
  scheduled_at_ms: number;
  started_at_ms: number | null;
  finished_at_ms: number | null;
  result_json: string | null;
  error_message: string | null;
  queue: string;
  created_at_ms: number;
}

function dbQueryById(
  handle: Database.Database,
  id: string,
): { status: JobStatus; resultJson: string | null; errorMsg: string | null } | null {
  const row = handle.prepare(
    'SELECT status, result_json, error_message FROM __clean_jobs WHERE id = ?',
  ).get(id) as { status: string; result_json: string | null; error_message: string | null } | undefined;
  if (!row) return null;
  return {
    status: row.status as JobStatus,
    resultJson: row.result_json,
    errorMsg: row.error_message,
  };
}

function dbCleanupStale(handle: Database.Database): number {
  const cutoff = nowMs() - JOBS_RETENTION_DAYS * 86_400_000;
  const info = handle.prepare(`
    DELETE FROM __clean_jobs
     WHERE status IN ('succeeded', 'failed', 'cancelled')
       AND finished_at_ms IS NOT NULL
       AND finished_at_ms < ?
  `).run(cutoff);
  return info.changes;
}

function recoverFromDisk(handle: Database.Database): void {
  const rows = handle.prepare(`
    SELECT id, name, args_json, status, attempt, scheduled_at_ms,
           result_json, error_message, queue, created_at_ms
      FROM __clean_jobs
     WHERE status IN ('pending', 'running')
  `).all() as DbRowJob[];

  let resetCount = 0;
  for (const row of rows) {
    if (row.status === 'running') resetCount++;
    const record: JobRecord = {
      id: row.id,
      name: row.name,
      args: row.args_json,
      status: 'pending',
      attempt: row.attempt,
      maxAttempts: 3, // overwritten when register_job re-runs
      backoff: 'fixed',
      delayMs: 1000,
      timeoutMs: 0,
      queue: row.queue,
      handler: '', // resolved at dispatch time from the registered config
      scheduledAt: row.scheduled_at_ms,
      createdAt: row.created_at_ms,
      updatedAt: nowMs(),
      finishedAt: null,
      result: row.result_json,
      error: row.error_message,
    };
    records.set(row.id, record);
  }

  if (resetCount > 0) {
    handle.exec("UPDATE __clean_jobs SET status = 'pending' WHERE status = 'running'");
    verboseLog(`recovered ${rows.length} job(s) from disk (${resetCount} reset from running→pending)`);
  } else if (rows.length > 0) {
    verboseLog(`recovered ${rows.length} job(s) from disk`);
  }
}

// ---------------------------------------------------------------------------
// Worker loop
// ---------------------------------------------------------------------------

function pollDueJobs(): JobRecord[] {
  const now = nowMs();
  const due: JobRecord[] = [];
  for (const r of records.values()) {
    if (r.status === 'pending' && r.scheduledAt <= now) {
      due.push(r);
      if (due.length >= MAX_JOBS_PER_POLL) break;
    }
  }
  return due;
}

function claimJob(job: JobRecord): JobRecord | null {
  const current = records.get(job.id);
  if (!current || current.status !== 'pending') return null;
  current.status = 'running';
  current.attempt += 1;
  current.updatedAt = nowMs();
  if (db) {
    try { dbUpdate(db, current); } catch (err) { warnLog(`persist running for ${job.id} failed`, err); }
  }
  return current;
}

function persistAndEvict(record: JobRecord): void {
  if (db) {
    try { dbUpdate(db, record); } catch (err) { warnLog(`persist terminal for ${record.id} failed`, err); }
    records.delete(record.id);
  }
  // If persistence is unavailable the in-memory cache is the only source of
  // truth — keep the terminal record so status/result lookups can resolve it.
}

function applyImplicitSuccess(job: JobRecord): void {
  const current = records.get(job.id);
  if (!current) return;
  current.status = 'succeeded';
  current.updatedAt = nowMs();
  current.finishedAt = current.updatedAt;
  verboseLog(`${job.id}: succeeded (implicit, attempt ${current.attempt})`);
  persistAndEvict(current);
}

function applyExplicitSuccess(job: JobRecord, resultJson: string): void {
  const current = records.get(job.id);
  if (!current) return;
  current.status = 'succeeded';
  current.result = resultJson;
  current.updatedAt = nowMs();
  current.finishedAt = current.updatedAt;
  verboseLog(`${job.id}: succeeded (explicit, attempt ${current.attempt})`);
  persistAndEvict(current);
}

function applyExplicitFail(job: JobRecord, reason: string): void {
  const current = records.get(job.id);
  if (!current) return;
  current.status = 'failed';
  current.error = reason;
  current.updatedAt = nowMs();
  current.finishedAt = current.updatedAt;
  verboseLog(`${job.id}: explicitly failed (attempt ${current.attempt}): ${reason}`);
  persistAndEvict(current);
}

function applyFailure(job: JobRecord, errMsg: string, retryOverrideMs: number): void {
  const current = records.get(job.id);
  if (!current) return;
  if (current.attempt < current.maxAttempts) {
    const delay = retryOverrideMs >= 0
      ? retryOverrideMs
      : computeBackoffDelay(current.backoff, current.delayMs, current.attempt);
    current.status = 'pending';
    current.scheduledAt = nowMs() + delay;
    current.error = errMsg;
    current.updatedAt = nowMs();
    verboseLog(`${job.id}: attempt ${current.attempt} failed, retry in ${delay}ms: ${errMsg}`);
    if (db) {
      try { dbUpdate(db, current); } catch (err) { warnLog(`persist retry for ${job.id} failed`, err); }
    }
  } else {
    current.status = 'failed';
    current.error = errMsg;
    current.updatedAt = nowMs();
    current.finishedAt = current.updatedAt;
    verboseLog(`${job.id}: permanently failed after ${current.attempt} attempt(s): ${errMsg}`);
    persistAndEvict(current);
  }
}

function runHandler(job: JobRecord): void {
  const state = workerState;
  if (!state) return;

  // Resolve handler from current config; recovered records may have empty handler.
  let handlerName = job.handler;
  if (!handlerName) {
    const cfg = configs.get(job.name);
    if (cfg) {
      handlerName = cfg.handler;
      // Backfill record fields from current config.
      const current = records.get(job.id);
      if (current) {
        current.handler = cfg.handler;
        current.maxAttempts = cfg.maxAttempts;
        current.backoff = cfg.backoff;
        current.delayMs = cfg.delayMs;
        current.timeoutMs = cfg.timeoutMs;
      }
    }
  }

  if (!handlerName) {
    applyFailure(job, `no handler registered for job name '${job.name}'`, -1);
    return;
  }

  const handler = state.exports[handlerName];
  if (typeof handler !== 'function') {
    applyFailure(job, `handler '${handlerName}' not found in WASM exports`, -1);
    return;
  }

  const ctx: JobLocalContext = {
    id: job.id,
    args: job.args,
    attempt: records.get(job.id)?.attempt ?? job.attempt,
    retryOverrideMs: { value: -1 },
    explicitFail: { value: null },
    explicitSucceed: { value: null },
  };

  let handlerError: Error | null = null;
  jobLocal.run(ctx, () => {
    try {
      (handler as () => unknown)();
    } catch (err) {
      handlerError = err instanceof Error ? err : new Error(String(err));
    }
  });

  // Order matches clean-server: explicit_succeed > explicit_fail > implicit.
  if (ctx.explicitSucceed.value !== null) {
    applyExplicitSuccess(job, ctx.explicitSucceed.value);
    return;
  }
  if (ctx.explicitFail.value !== null) {
    applyExplicitFail(job, ctx.explicitFail.value);
    return;
  }
  if (handlerError) {
    applyFailure(job, (handlerError as Error).message, ctx.retryOverrideMs.value);
    return;
  }
  applyImplicitSuccess(job);
}

function workerTick(): void {
  if (pollInFlight) return;
  pollInFlight = true;
  try {
    const due = pollDueJobs();
    for (const job of due) {
      const claimed = claimJob(job);
      if (!claimed) continue;
      runHandler(claimed);
    }
  } catch (err) {
    warnLog('worker tick failed', err);
  } finally {
    pollInFlight = false;
  }
}

// ---------------------------------------------------------------------------
// Public lifecycle
// ---------------------------------------------------------------------------

/**
 * Start the jobs worker against the provided WASM instance. Idempotent.
 * Opens the SQLite store, ensures schema, recovers pending records, and
 * begins polling every `WORKER_POLL_MS` ms.
 */
export function startJobWorker(state: WasmState): void {
  if (workerStarted) return;
  workerState = state;
  try {
    db = openDb();
    ensureSchema(db);
    const cleaned = dbCleanupStale(db);
    if (cleaned > 0) verboseLog(`cleaned up ${cleaned} stale finished record(s)`);
    recoverFromDisk(db);
  } catch (err) {
    warnLog('failed to initialise persistence — continuing in-memory only', err);
    db = null;
  }
  workerStarted = true;
  workerTimer = setInterval(workerTick, WORKER_POLL_MS);
  verboseLog('worker started');
}

/** Stop the worker, clear in-memory state and the DB handle. */
export function stopJobWorker(): void {
  if (workerTimer) {
    clearInterval(workerTimer);
    workerTimer = null;
  }
  workerStarted = false;
  workerState = null;
  pollInFlight = false;
  records.clear();
  configs.clear();
  if (db) {
    try { db.close(); } catch { /* ignore */ }
    db = null;
  }
}

/** Test-only synchronous tick — runs one poll/dispatch cycle. */
export function _runJobWorkerTickForTest(): void {
  workerTick();
}

/** Test-only registry snapshot. */
export function _getJobsSnapshotForTest(): {
  configs: JobConfig[];
  records: Omit<JobRecord, 'updatedAt' | 'createdAt'>[];
} {
  return {
    configs: [...configs.values()].map(c => ({ ...c })),
    records: [...records.values()].map(r => {
      const { updatedAt: _u, createdAt: _c, ...rest } = r;
      void _u; void _c;
      return { ...rest };
    }),
  };
}

// ---------------------------------------------------------------------------
// Public API used by bridge functions
// ---------------------------------------------------------------------------

function registerJob(
  name: string,
  handler: string,
  maxAttempts: number,
  backoff: BackoffStrategy,
  delayMs: number,
  timeoutMs: number,
  queue: string,
): void {
  const cfg: JobConfig = {
    name,
    handler,
    maxAttempts: Math.max(1, maxAttempts),
    backoff,
    delayMs: Math.max(0, delayMs),
    timeoutMs: Math.max(0, timeoutMs),
    queue: queue || 'default',
  };
  for (const r of records.values()) {
    if (r.name === name) {
      r.maxAttempts = cfg.maxAttempts;
      r.backoff = cfg.backoff;
      r.delayMs = cfg.delayMs;
      r.timeoutMs = cfg.timeoutMs;
      r.handler = cfg.handler;
    }
  }
  configs.set(name, cfg);
  verboseLog(`register: '${name}' handler='${handler}' max=${cfg.maxAttempts} backoff=${backoff}`);
}

function enqueueJobAt(name: string, args: string, runAtMs: number): string {
  const cfg = configs.get(name);
  if (!cfg) {
    warnLog(`enqueue: unknown job name '${name}' — not registered`);
    return '';
  }
  const id = randomUUID();
  const ts = nowMs();
  const record: JobRecord = {
    id,
    name,
    args,
    status: 'pending',
    attempt: 0,
    maxAttempts: cfg.maxAttempts,
    backoff: cfg.backoff,
    delayMs: cfg.delayMs,
    timeoutMs: cfg.timeoutMs,
    queue: cfg.queue,
    handler: cfg.handler,
    scheduledAt: Math.max(0, runAtMs),
    createdAt: ts,
    updatedAt: ts,
    finishedAt: null,
    result: null,
    error: null,
  };
  records.set(id, record);
  if (db) {
    try { dbInsert(db, record); } catch (err) { warnLog(`persist enqueue for ${id} failed`, err); }
  }
  verboseLog(`enqueue: '${name}' as ${id} (scheduled_at=${record.scheduledAt})`);
  return id;
}

function cancelJob(id: string): boolean {
  const r = records.get(id);
  if (!r || r.status !== 'pending') return false;
  r.status = 'cancelled';
  r.updatedAt = nowMs();
  r.finishedAt = r.updatedAt;
  persistAndEvict(r);
  verboseLog(`${id}: cancelled`);
  return true;
}

function jobStatus(id: string): string {
  const r = records.get(id);
  if (r) return r.status;
  if (db) {
    try {
      const row = dbQueryById(db, id);
      if (row) return row.status;
    } catch (err) {
      warnLog(`status DB lookup for ${id} failed`, err);
    }
  }
  return 'not_found';
}

function jobResult(id: string): string {
  const r = records.get(id);
  if (r) {
    if (r.status === 'succeeded') return r.result ?? '';
    if (r.status === 'failed')    return r.error  ?? '';
    return '';
  }
  if (db) {
    try {
      const row = dbQueryById(db, id);
      if (row) {
        if (row.status === 'succeeded') return row.resultJson ?? '';
        if (row.status === 'failed')    return row.errorMsg ?? '';
        return '';
      }
    } catch (err) {
      warnLog(`result DB lookup for ${id} failed`, err);
    }
  }
  return '';
}

// ---------------------------------------------------------------------------
// Bridge
// ---------------------------------------------------------------------------

export function createJobsBridge(getState: () => WasmState) {
  return {
    /**
     * Register a job handler.
     * Registry: params=["string","string","i32","string","i32","i32","string"], returns="void"
     * WASM args: (name_ptr,name_len, handler_ptr,handler_len, max_attempts:i32,
     *             backoff_ptr,backoff_len, delay:i32, timeout:i32,
     *             queue_ptr,queue_len)
     */
    _job_register(
      namePtr: number, nameLen: number,
      handlerPtr: number, handlerLen: number,
      maxAttempts: number,
      backoffPtr: number, backoffLen: number,
      delayMs: number,
      timeoutMs: number,
      queuePtr: number, queueLen: number,
    ): void {
      const state = getState();
      const name = readString(state, namePtr, nameLen);
      const handler = readString(state, handlerPtr, handlerLen);
      const backoffStr = backoffLen > 0 ? readString(state, backoffPtr, backoffLen) : 'fixed';
      const queue = queueLen > 0 ? readString(state, queuePtr, queueLen) : 'default';
      registerJob(name, handler, maxAttempts, parseBackoff(backoffStr), delayMs, timeoutMs, queue);
    },

    /**
     * Enqueue a job for immediate execution.
     * Registry: params=["string","string"], returns="ptr" (LP string job ID).
     */
    _job_enqueue(
      namePtr: number, nameLen: number,
      argsPtr: number, argsLen: number,
    ): number {
      const state = getState();
      const name = readString(state, namePtr, nameLen);
      const args = argsLen > 0 ? readString(state, argsPtr, argsLen) : '{}';
      const id = enqueueJobAt(name, args, nowMs());
      return writeString(state, id);
    },

    /**
     * Schedule a job at a specific Unix epoch ms (f64).
     * Registry: params=["string","string","number"], returns="ptr".
     * NaN / negative timestamps are clamped to 0 (run immediately).
     */
    _job_enqueue_at(
      namePtr: number, nameLen: number,
      argsPtr: number, argsLen: number,
      runAtMs: number,
    ): number {
      const state = getState();
      const name = readString(state, namePtr, nameLen);
      const args = argsLen > 0 ? readString(state, argsPtr, argsLen) : '{}';
      const ts = !Number.isFinite(runAtMs) || runAtMs < 0 ? 0 : Math.floor(runAtMs);
      const id = enqueueJobAt(name, args, ts);
      return writeString(state, id);
    },

    /**
     * Cancel a pending job.
     * Registry: params=["string"], returns="boolean" — clean-server's wrapper
     * returns 0 = cancelled, -1 = not found / not pending. Both are i32 at
     * the WASM-shape layer; node-server matches the runtime values exactly.
     */
    _job_cancel(idPtr: number, idLen: number): number {
      const state = getState();
      const id = readString(state, idPtr, idLen);
      return cancelJob(id) ? 0 : -1;
    },

    /** Return current status string (LP). */
    _job_status(idPtr: number, idLen: number): number {
      const state = getState();
      const id = readString(state, idPtr, idLen);
      return writeString(state, jobStatus(id));
    },

    /** Return result/error string (LP). */
    _job_result(idPtr: number, idLen: number): number {
      const state = getState();
      const id = readString(state, idPtr, idLen);
      return writeString(state, jobResult(id));
    },

    /** Current job id inside a handler — empty string outside. */
    _job_current_id(): number {
      const state = getState();
      return writeString(state, jobLocal.getStore()?.id ?? '');
    },

    /** Current job args inside a handler — empty string outside. */
    _job_current_args(): number {
      const state = getState();
      return writeString(state, jobLocal.getStore()?.args ?? '');
    },

    /** Current attempt number (1-based) — 0 outside. */
    _job_current_attempt(): number {
      return jobLocal.getStore()?.attempt ?? 0;
    },

    /** Override the backoff delay for this attempt's retry. */
    _job_retry_after(delayMs: number): void {
      const ctx = jobLocal.getStore();
      if (ctx) ctx.retryOverrideMs.value = Math.max(0, delayMs);
    },

    /** Mark the current attempt as a permanent failure. */
    _job_fail(reasonPtr: number, reasonLen: number): void {
      const state = getState();
      const reason = reasonLen > 0 ? readString(state, reasonPtr, reasonLen) : 'unknown';
      const ctx = jobLocal.getStore();
      if (ctx) ctx.explicitFail.value = reason;
    },

    /** Mark the current attempt as succeeded with the given JSON result. */
    _job_succeed(resultPtr: number, resultLen: number): void {
      const state = getState();
      const result = resultLen > 0 ? readString(state, resultPtr, resultLen) : '';
      const ctx = jobLocal.getStore();
      if (ctx) ctx.explicitSucceed.value = result;
    },
  };
}
