/**
 * Schedule bridge tests — _schedule_cron, _schedule_cancel, and the timer wheel.
 *
 * Covers the ABI (six i32 params for _schedule_cron, two for _schedule_cancel,
 * i32 return) plus the lifecycle: a registered schedule fires its handler on
 * tick, a cancelled schedule does not, and invalid cron expressions are
 * rejected without polluting the registry.
 *
 * The cron parser is exercised via the public `nextCronTickMs` /
 * `isValidCron` exports to keep the parity guarantee with clean-server's
 * jobs.rs visible at the test boundary.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createScheduleBridge,
  startScheduler,
  stopScheduler,
  isValidCron,
  nextCronTickMs,
  _getScheduleSnapshotForTest,
} from '../src/bridge/schedule';
import type { WasmState } from '../src/types';

// ─── Mock state ──────────────────────────────────────────────────────────────

interface MockSetup {
  state: WasmState;
  fired: string[];
  writeString: (str: string) => { ptr: number; len: number };
}

function makeMockState(handlerNames: string[] = []): MockSetup {
  const memory = new WebAssembly.Memory({ initial: 2 });
  let writeCursor = 64;
  let heapPtr = 16384;
  const fired: string[] = [];

  const exports: Record<string, unknown> = {
    memory,
    malloc: (size: number): number => {
      const ptr = heapPtr;
      heapPtr += size + 4;
      return ptr;
    },
  };
  for (const name of handlerNames) {
    exports[name] = (): number => {
      fired.push(name);
      return 0;
    };
  }

  const state = {
    exports,
    config: { verbose: false },
  } as unknown as WasmState;

  const writeString = (str: string): { ptr: number; len: number } => {
    const bytes = new TextEncoder().encode(str);
    new Uint8Array(memory.buffer).set(bytes, writeCursor);
    const result = { ptr: writeCursor, len: bytes.length };
    writeCursor += bytes.length + 16;
    return result;
  };

  return { state, fired, writeString };
}

// ─── Cron parser ─────────────────────────────────────────────────────────────

describe('cron parser parity with clean-server/src/jobs.rs', () => {
  it('accepts the canonical valid expressions', () => {
    expect(isValidCron('* * * * *')).toBe(true);
    expect(isValidCron('*/5 * * * *')).toBe(true);
    expect(isValidCron('0 0 * * *')).toBe(true);
    expect(isValidCron('*/1 * * * *')).toBe(true);
    expect(isValidCron('0 9 * * 1-5')).toBe(true);
    expect(isValidCron('0,30 * * * *')).toBe(true);
  });

  it('rejects malformed expressions', () => {
    expect(isValidCron('invalid')).toBe(false);
    expect(isValidCron('* * * *')).toBe(false);     // too few
    expect(isValidCron('* * * * * *')).toBe(false); // too many
    expect(isValidCron('*/0 * * * *')).toBe(false); // zero step
    expect(isValidCron('')).toBe(false);
    expect(isValidCron('5-1 * * * *')).toBe(false); // inverted range
  });

  it('computes a positive next-tick for any valid expression', () => {
    // "every minute" — next tick must be within the next 60s.
    const delta = nextCronTickMs('* * * * *');
    expect(delta).not.toBeNull();
    expect(delta!).toBeGreaterThanOrEqual(0);
    expect(delta!).toBeLessThanOrEqual(60_000);
  });

  it('returns null for impossible expressions (Feb 31 never fires)', () => {
    // 31st of February — cannot match in any year within the 1-year scan.
    expect(nextCronTickMs('0 0 31 2 *')).toBeNull();
  });
});

// ─── Bridge ABI + registry ──────────────────────────────────────────────────

describe('_schedule_cron / _schedule_cancel ABI', () => {
  afterEach(() => {
    stopScheduler();
  });

  it('registers a valid schedule and returns 1', () => {
    const { state, writeString } = makeMockState();
    const bridge = createScheduleBridge(() => state);
    const name = writeString('dailyDigest');
    const cron = writeString('0 0 * * *');
    const handler = writeString('daily_digest_handler');

    const result = bridge._schedule_cron(
      name.ptr, name.len, cron.ptr, cron.len, handler.ptr, handler.len,
    );

    expect(result).toBe(1);
    const snap = _getScheduleSnapshotForTest();
    expect(snap).toHaveLength(1);
    expect(snap[0]).toMatchObject({
      name: 'dailyDigest',
      cronExpr: '0 0 * * *',
      handler: 'daily_digest_handler',
      active: true,
    });
  });

  it('rejects an invalid cron expression and does not pollute the registry', () => {
    const { state, writeString } = makeMockState();
    const bridge = createScheduleBridge(() => state);
    const name = writeString('bad');
    const cron = writeString('not a cron');
    const handler = writeString('handler');

    const result = bridge._schedule_cron(
      name.ptr, name.len, cron.ptr, cron.len, handler.ptr, handler.len,
    );

    expect(result).toBe(0);
    expect(_getScheduleSnapshotForTest()).toHaveLength(0);
  });

  it('cancels an active schedule and returns 1; a second cancel returns 0', () => {
    const { state, writeString } = makeMockState();
    const bridge = createScheduleBridge(() => state);
    const name = writeString('dailyDigest');
    const cron = writeString('0 0 * * *');
    const handler = writeString('h');

    bridge._schedule_cron(
      name.ptr, name.len, cron.ptr, cron.len, handler.ptr, handler.len,
    );

    const cancelName = writeString('dailyDigest');
    expect(bridge._schedule_cancel(cancelName.ptr, cancelName.len)).toBe(1);

    const cancelName2 = writeString('dailyDigest');
    expect(bridge._schedule_cancel(cancelName2.ptr, cancelName2.len)).toBe(0);
  });

  it('cancelling an unknown schedule returns 0', () => {
    const { state, writeString } = makeMockState();
    const bridge = createScheduleBridge(() => state);
    const unknown = writeString('nope');
    expect(bridge._schedule_cancel(unknown.ptr, unknown.len)).toBe(0);
  });

  it('re-registering by the same name replaces the prior entry', () => {
    const { state, writeString } = makeMockState();
    const bridge = createScheduleBridge(() => state);

    const n1 = writeString('s'); const c1 = writeString('* * * * *'); const h1 = writeString('h1');
    bridge._schedule_cron(n1.ptr, n1.len, c1.ptr, c1.len, h1.ptr, h1.len);

    const n2 = writeString('s'); const c2 = writeString('0 * * * *'); const h2 = writeString('h2');
    bridge._schedule_cron(n2.ptr, n2.len, c2.ptr, c2.len, h2.ptr, h2.len);

    const snap = _getScheduleSnapshotForTest();
    expect(snap).toHaveLength(1);
    expect(snap[0]).toMatchObject({ cronExpr: '0 * * * *', handler: 'h2' });
  });
});

// ─── Scheduler firing ────────────────────────────────────────────────────────

describe('scheduler fires the registered handler on tick', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    stopScheduler();
    vi.useRealTimers();
  });

  it('fires the WASM export at the next cron tick and re-arms', () => {
    const { state, fired, writeString } = makeMockState(['tick_handler']);
    const bridge = createScheduleBridge(() => state);

    const name = writeString('everyMinute');
    const cron = writeString('* * * * *');
    const handler = writeString('tick_handler');
    bridge._schedule_cron(
      name.ptr, name.len, cron.ptr, cron.len, handler.ptr, handler.len,
    );

    startScheduler(state);

    // Advance well past one minute so the timer runs once and re-arms.
    vi.advanceTimersByTime(61_000);
    expect(fired.length).toBeGreaterThanOrEqual(1);
    expect(fired[0]).toBe('tick_handler');

    // Another minute -> another fire.
    const beforeSecondFire = fired.length;
    vi.advanceTimersByTime(60_000);
    expect(fired.length).toBeGreaterThan(beforeSecondFire);
  });

  it('does not fire after _schedule_cancel even if the timer was armed', () => {
    const { state, fired, writeString } = makeMockState(['handler_x']);
    const bridge = createScheduleBridge(() => state);

    const name = writeString('soon');
    const cron = writeString('* * * * *');
    const handler = writeString('handler_x');
    bridge._schedule_cron(
      name.ptr, name.len, cron.ptr, cron.len, handler.ptr, handler.len,
    );

    startScheduler(state);

    const cancelName = writeString('soon');
    expect(bridge._schedule_cancel(cancelName.ptr, cancelName.len)).toBe(1);

    vi.advanceTimersByTime(5 * 60_000);
    expect(fired).toEqual([]);
  });

  it('a missing handler export does not throw — logs and keeps the scheduler alive', () => {
    const { state, writeString } = makeMockState(); // no handlers registered
    const bridge = createScheduleBridge(() => state);

    const name = writeString('orphan');
    const cron = writeString('* * * * *');
    const handler = writeString('does_not_exist');
    bridge._schedule_cron(
      name.ptr, name.len, cron.ptr, cron.len, handler.ptr, handler.len,
    );

    startScheduler(state);

    // Should advance without throwing.
    expect(() => vi.advanceTimersByTime(60_000)).not.toThrow();

    // Scheduler still alive — the entry remains active and re-arms.
    const snap = _getScheduleSnapshotForTest();
    expect(snap[0]?.active).toBe(true);
  });

  it('handler throws — caught and the schedule keeps ticking', () => {
    const { state, writeString } = makeMockState();
    const callOrder: string[] = [];
    (state.exports as Record<string, unknown>).throwy = (): number => {
      callOrder.push('throwy');
      throw new Error('boom');
    };

    const bridge = createScheduleBridge(() => state);
    const name = writeString('t');
    const cron = writeString('* * * * *');
    const handler = writeString('throwy');
    bridge._schedule_cron(
      name.ptr, name.len, cron.ptr, cron.len, handler.ptr, handler.len,
    );

    startScheduler(state);

    expect(() => vi.advanceTimersByTime(60_000)).not.toThrow();
    expect(callOrder).toContain('throwy');

    // Still rearmed — fire again next minute.
    const callsAfterFirst = callOrder.length;
    vi.advanceTimersByTime(60_000);
    expect(callOrder.length).toBeGreaterThan(callsAfterFirst);
  });
});

// ─── Idempotence guards ──────────────────────────────────────────────────────

describe('scheduler lifecycle', () => {
  afterEach(() => stopScheduler());

  it('startScheduler is idempotent — second call is a no-op', () => {
    const { state, writeString } = makeMockState();
    const bridge = createScheduleBridge(() => state);
    const name = writeString('x');
    const cron = writeString('* * * * *');
    const handler = writeString('h');
    bridge._schedule_cron(
      name.ptr, name.len, cron.ptr, cron.len, handler.ptr, handler.len,
    );

    startScheduler(state);
    expect(() => startScheduler(state)).not.toThrow();
  });

  it('stopScheduler clears the registry', () => {
    const { state, writeString } = makeMockState();
    const bridge = createScheduleBridge(() => state);
    const name = writeString('x');
    const cron = writeString('* * * * *');
    const handler = writeString('h');
    bridge._schedule_cron(
      name.ptr, name.len, cron.ptr, cron.len, handler.ptr, handler.len,
    );
    expect(_getScheduleSnapshotForTest()).toHaveLength(1);

    stopScheduler();
    expect(_getScheduleSnapshotForTest()).toHaveLength(0);
  });
});
