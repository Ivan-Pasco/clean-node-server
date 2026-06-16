/**
 * frame.jobs (background job queue) bridge — node-server stubs.
 *
 * The frame.jobs runtime is implemented in clean-server (Rust) at
 * clean-server/src/jobs.rs — FIFO queue with SQLite persistence,
 * retry/backoff state machine, worker pool, and request-scoped current-job
 * accessors.
 *
 * Porting to TypeScript is tracked in
 * foundation/management/cross-component-prompts/
 *   all-host-bridge-parity-enforcement.md (Step 4 — node-server jobs).
 *
 * These stubs satisfy the WASM linker contract so apps using `jobs:` blocks
 * can instantiate on node-server, but any actual queue call fails loudly
 * instead of crashing in WASM linking or silently dropping work.
 *
 * Signature reference: foundation/platform-architecture/function-registry.toml
 * (entries with category = "jobs").
 */
import { WasmState } from '../types';

const NOT_IMPLEMENTED =
  'frame.jobs is not yet implemented on clean-node-server. ' +
  'See foundation/management/cross-component-prompts/' +
  'all-host-bridge-parity-enforcement.md for status.';

function notImplemented(fn: string): never {
  throw new Error(`${fn}: ${NOT_IMPLEMENTED}`);
}

export function createJobsBridge(_getState: () => WasmState) {
  return {
    _job_register(
      _namePtr: number, _maxAttempts: number, _backoffPtr: number,
      _baseMs: number, _maxMs: number, _retriesPtr: number, _timeoutPtr: number,
    ): void {
      notImplemented('_job_register');
    },

    _job_enqueue(_namePtr: number, _argsPtr: number): number {
      notImplemented('_job_enqueue');
    },

    _job_enqueue_at(_namePtr: number, _argsPtr: number, _epochMs: number): number {
      notImplemented('_job_enqueue_at');
    },

    _job_cancel(_idPtr: number): number {
      notImplemented('_job_cancel');
    },

    _job_status(_idPtr: number): number {
      notImplemented('_job_status');
    },

    _job_result(_idPtr: number): number {
      notImplemented('_job_result');
    },

    _job_current_id(): number {
      notImplemented('_job_current_id');
    },

    _job_current_args(): number {
      notImplemented('_job_current_args');
    },

    _job_current_attempt(): number {
      notImplemented('_job_current_attempt');
    },

    _job_retry_after(_delayMs: number): void {
      notImplemented('_job_retry_after');
    },

    _job_fail(_msgPtr: number): void {
      notImplemented('_job_fail');
    },

    _job_succeed(_resultPtr: number): void {
      notImplemented('_job_succeed');
    },
  };
}
