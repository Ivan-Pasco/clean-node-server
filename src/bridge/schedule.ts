/**
 * frame.jobs schedule (cron) bridge — node-server stubs.
 *
 * Depends on frame.jobs (clean-server/src/jobs.rs); implementation is
 * tracked together with jobs in
 * foundation/management/cross-component-prompts/
 *   all-host-bridge-parity-enforcement.md (Step 4 — node-server jobs).
 *
 * Signature reference: foundation/platform-architecture/function-registry.toml
 * (entries with category = "schedule").
 */
import { WasmState } from '../types';

const NOT_IMPLEMENTED =
  'frame.jobs schedule (cron) is not yet implemented on clean-node-server. ' +
  'Depends on the jobs runtime. See ' +
  'foundation/management/cross-component-prompts/' +
  'all-host-bridge-parity-enforcement.md for status.';

function notImplemented(fn: string): never {
  throw new Error(`${fn}: ${NOT_IMPLEMENTED}`);
}

export function createScheduleBridge(_getState: () => WasmState) {
  return {
    _schedule_cron(_cronPtr: number, _namePtr: number, _argsPtr: number): number {
      notImplemented('_schedule_cron');
    },

    _schedule_cancel(_idPtr: number): number {
      notImplemented('_schedule_cancel');
    },
  };
}
