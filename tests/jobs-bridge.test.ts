/**
 * Jobs bridge tests — register / enqueue / status / result / cancel and the
 * retry + current-context state machine.
 *
 * The worker poll is driven manually via `_runJobWorkerTickForTest()` so
 * tests are deterministic without sleeping. SQLite persistence is exercised
 * by pointing JOBS_DB_PATH at `:memory:` for the duration of the test file.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createJobsBridge,
  startJobWorker,
  stopJobWorker,
  _runJobWorkerTickForTest,
  _getJobsSnapshotForTest,
} from '../src/bridge/jobs';
import { readLengthPrefixedString } from '../src/wasm/memory';
import type { WasmState } from '../src/types';

interface MockSetup {
  state: WasmState;
  fired: Array<{ name: string; ctx: { id: string; args: string; attempt: number } }>;
  writeString: (str: string) => { ptr: number; len: number };
  registerHandler: (name: string, fn: () => void) => void;
}

function makeMockState(): MockSetup {
  const memory = new WebAssembly.Memory({ initial: 4 });
  let writeCursor = 64;
  let heapPtr = 16384;
  const fired: MockSetup['fired'] = [];

  const exports: Record<string, unknown> = {
    memory,
    malloc: (size: number): number => {
      const ptr = heapPtr;
      heapPtr += size + 4;
      return ptr;
    },
  };

  const state = {
    exports,
    config: { verbose: false },
  } as unknown as WasmState;

  const writeString = (str: string): { ptr: number; len: number } => {
    const bytes = new TextEncoder().encode(str);
    new Uint8Array(memory.buffer).set(bytes, writeCursor);
    const out = { ptr: writeCursor, len: bytes.length };
    writeCursor += bytes.length + 16;
    return out;
  };

  const registerHandler = (name: string, fn: () => void): void => {
    exports[name] = fn;
  };

  // Capture current context inside handlers via the bridge accessors.
  // Tests wire this by binding a closure that reads from the bridge.
  return { state, fired, writeString, registerHandler };
}

function readLP(state: WasmState, ptr: number): string {
  return readLengthPrefixedString(state.exports.memory, ptr);
}

beforeEach(() => {
  process.env.JOBS_DB_PATH = ':memory:';
});

afterEach(() => {
  stopJobWorker();
});

describe('_job_register + _job_enqueue', () => {
  it('register stores the config and enqueue returns a fresh UUID id', () => {
    const { state, writeString } = makeMockState();
    const bridge = createJobsBridge(() => state);

    const name = writeString('email');
    const handler = writeString('send_email_handler');
    const backoff = writeString('fixed');
    const queue = writeString('default');
    bridge._job_register(
      name.ptr, name.len, handler.ptr, handler.len,
      3, backoff.ptr, backoff.len,
      1000, 0, queue.ptr, queue.len,
    );

    const snap1 = _getJobsSnapshotForTest();
    expect(snap1.configs).toHaveLength(1);
    expect(snap1.configs[0]).toMatchObject({
      name: 'email', handler: 'send_email_handler', maxAttempts: 3, backoff: 'fixed',
    });

    const enqName = writeString('email');
    const enqArgs = writeString('{"to":"a@b"}');
    const idPtr = bridge._job_enqueue(enqName.ptr, enqName.len, enqArgs.ptr, enqArgs.len);
    const id = readLP(state, idPtr);

    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const snap2 = _getJobsSnapshotForTest();
    expect(snap2.records).toHaveLength(1);
    expect(snap2.records[0].name).toBe('email');
    expect(snap2.records[0].status).toBe('pending');
  });

  it('enqueue against an unregistered name returns empty string', () => {
    const { state, writeString } = makeMockState();
    const bridge = createJobsBridge(() => state);

    const name = writeString('ghost');
    const args = writeString('{}');
    const idPtr = bridge._job_enqueue(name.ptr, name.len, args.ptr, args.len);
    expect(readLP(state, idPtr)).toBe('');
  });
});

describe('worker loop fires handler and applies outcome', () => {
  it('runs the handler implicitly succeeded on the next tick', () => {
    const { state, registerHandler, writeString } = makeMockState();
    const bridge = createJobsBridge(() => state);
    let count = 0;
    registerHandler('h', () => { count++; });

    const rn = writeString('t'); const rh = writeString('h');
    const rbo = writeString('fixed'); const rq = writeString('default');
    bridge._job_register(rn.ptr, rn.len, rh.ptr, rh.len, 3, rbo.ptr, rbo.len, 100, 0, rq.ptr, rq.len);

    startJobWorker(state);

    const en = writeString('t'); const ea = writeString('{}');
    const idPtr = bridge._job_enqueue(en.ptr, en.len, ea.ptr, ea.len);
    const id = readLP(state, idPtr);

    _runJobWorkerTickForTest();
    expect(count).toBe(1);

    // After implicit success the record is evicted from the in-memory cache.
    const sn = writeString(id);
    const statusPtr = bridge._job_status(sn.ptr, sn.len);
    expect(readLP(state, statusPtr)).toBe('succeeded');
  });

  it('retries with backoff on handler throw, then succeeds', () => {
    const { state, registerHandler, writeString } = makeMockState();
    const bridge = createJobsBridge(() => state);

    let calls = 0;
    registerHandler('h2', () => {
      calls++;
      if (calls < 2) throw new Error('transient');
    });

    const rn = writeString('t2'); const rh = writeString('h2');
    const rbo = writeString('fixed'); const rq = writeString('default');
    bridge._job_register(rn.ptr, rn.len, rh.ptr, rh.len, 3, rbo.ptr, rbo.len, 0 /* delay=0 */, 0, rq.ptr, rq.len);

    startJobWorker(state);

    const en = writeString('t2'); const ea = writeString('{}');
    bridge._job_enqueue(en.ptr, en.len, ea.ptr, ea.len);

    _runJobWorkerTickForTest(); // attempt 1 — throws
    expect(calls).toBe(1);
    // Retry is scheduled for now+0ms, so immediately due again.
    _runJobWorkerTickForTest(); // attempt 2 — succeeds
    expect(calls).toBe(2);
  });

  it('permanently fails after max_attempts and exposes the error', () => {
    const { state, registerHandler, writeString } = makeMockState();
    const bridge = createJobsBridge(() => state);
    registerHandler('hf', () => { throw new Error('always broken'); });

    const rn = writeString('tf'); const rh = writeString('hf');
    const rbo = writeString('fixed'); const rq = writeString('default');
    bridge._job_register(rn.ptr, rn.len, rh.ptr, rh.len, 2, rbo.ptr, rbo.len, 0, 0, rq.ptr, rq.len);

    startJobWorker(state);

    const en = writeString('tf'); const ea = writeString('{}');
    const idPtr = bridge._job_enqueue(en.ptr, en.len, ea.ptr, ea.len);
    const id = readLP(state, idPtr);

    _runJobWorkerTickForTest();
    _runJobWorkerTickForTest();

    const sn = writeString(id);
    expect(readLP(state, bridge._job_status(sn.ptr, sn.len))).toBe('failed');

    const sn2 = writeString(id);
    expect(readLP(state, bridge._job_result(sn2.ptr, sn2.len))).toBe('always broken');
  });
});

describe('_job_current_* are populated inside the handler', () => {
  it('exposes id, args, and attempt to the running handler', () => {
    const { state, registerHandler, writeString } = makeMockState();
    const bridge = createJobsBridge(() => state);

    let captured: { id: string; args: string; attempt: number } = { id: '', args: '', attempt: -1 };
    registerHandler('cap', () => {
      const idPtr = bridge._job_current_id();
      const argsPtr = bridge._job_current_args();
      const attempt = bridge._job_current_attempt();
      captured = {
        id: readLP(state, idPtr),
        args: readLP(state, argsPtr),
        attempt,
      };
    });

    const rn = writeString('cap'); const rh = writeString('cap');
    const rbo = writeString('fixed'); const rq = writeString('default');
    bridge._job_register(rn.ptr, rn.len, rh.ptr, rh.len, 3, rbo.ptr, rbo.len, 0, 0, rq.ptr, rq.len);

    startJobWorker(state);

    const en = writeString('cap'); const ea = writeString('{"k":1}');
    const idPtr = bridge._job_enqueue(en.ptr, en.len, ea.ptr, ea.len);
    const id = readLP(state, idPtr);

    _runJobWorkerTickForTest();

    expect(captured.id).toBe(id);
    expect(captured.args).toBe('{"k":1}');
    expect(captured.attempt).toBe(1);

    // Outside any handler, current accessors return empty/0.
    const idOutside = readLP(state, bridge._job_current_id());
    expect(idOutside).toBe('');
    expect(bridge._job_current_attempt()).toBe(0);
  });
});

describe('explicit success / fail / retry-after take precedence over implicit', () => {
  it('_job_succeed wins over a handler throw', () => {
    const { state, registerHandler, writeString } = makeMockState();
    const bridge = createJobsBridge(() => state);

    registerHandler('s', () => {
      const result = writeString('{"ok":true}');
      bridge._job_succeed(result.ptr, result.len);
      throw new Error('should be ignored');
    });

    const rn = writeString('s'); const rh = writeString('s');
    const rbo = writeString('fixed'); const rq = writeString('default');
    bridge._job_register(rn.ptr, rn.len, rh.ptr, rh.len, 3, rbo.ptr, rbo.len, 0, 0, rq.ptr, rq.len);

    startJobWorker(state);
    const en = writeString('s'); const ea = writeString('{}');
    const idPtr = bridge._job_enqueue(en.ptr, en.len, ea.ptr, ea.len);
    const id = readLP(state, idPtr);

    _runJobWorkerTickForTest();

    const sn = writeString(id);
    expect(readLP(state, bridge._job_status(sn.ptr, sn.len))).toBe('succeeded');
    const sn2 = writeString(id);
    expect(readLP(state, bridge._job_result(sn2.ptr, sn2.len))).toBe('{"ok":true}');
  });

  it('_job_fail terminates immediately, no retry', () => {
    const { state, registerHandler, writeString } = makeMockState();
    const bridge = createJobsBridge(() => state);

    let calls = 0;
    registerHandler('f', () => {
      calls++;
      const reason = writeString('explicit-fail');
      bridge._job_fail(reason.ptr, reason.len);
    });

    const rn = writeString('f'); const rh = writeString('f');
    const rbo = writeString('fixed'); const rq = writeString('default');
    bridge._job_register(rn.ptr, rn.len, rh.ptr, rh.len, 5 /* would retry */, rbo.ptr, rbo.len, 0, 0, rq.ptr, rq.len);

    startJobWorker(state);
    const en = writeString('f'); const ea = writeString('{}');
    const idPtr = bridge._job_enqueue(en.ptr, en.len, ea.ptr, ea.len);
    const id = readLP(state, idPtr);

    _runJobWorkerTickForTest();
    _runJobWorkerTickForTest(); // would re-fire if retry was scheduled

    expect(calls).toBe(1);
    const sn = writeString(id);
    expect(readLP(state, bridge._job_status(sn.ptr, sn.len))).toBe('failed');
    const sn2 = writeString(id);
    expect(readLP(state, bridge._job_result(sn2.ptr, sn2.len))).toBe('explicit-fail');
  });

  it('_job_retry_after overrides the computed backoff', () => {
    const { state, registerHandler, writeString } = makeMockState();
    const bridge = createJobsBridge(() => state);

    let calls = 0;
    registerHandler('r', () => {
      calls++;
      if (calls === 1) {
        bridge._job_retry_after(0); // run again immediately
        throw new Error('first');
      }
      // second call succeeds implicitly
    });

    const rn = writeString('r'); const rh = writeString('r');
    const rbo = writeString('fixed'); const rq = writeString('default');
    // big base delay — the override should kick it back to 0
    bridge._job_register(rn.ptr, rn.len, rh.ptr, rh.len, 3, rbo.ptr, rbo.len, 60_000, 0, rq.ptr, rq.len);

    startJobWorker(state);
    const en = writeString('r'); const ea = writeString('{}');
    bridge._job_enqueue(en.ptr, en.len, ea.ptr, ea.len);

    _runJobWorkerTickForTest();
    _runJobWorkerTickForTest();

    expect(calls).toBe(2);
  });
});

describe('_job_cancel + status / result lookups', () => {
  it('cancels a pending job; returns 0 on first, -1 on second', () => {
    const { state, writeString } = makeMockState();
    const bridge = createJobsBridge(() => state);

    const rn = writeString('c'); const rh = writeString('c');
    const rbo = writeString('fixed'); const rq = writeString('default');
    bridge._job_register(rn.ptr, rn.len, rh.ptr, rh.len, 3, rbo.ptr, rbo.len, 10_000, 0, rq.ptr, rq.len);

    const en = writeString('c'); const ea = writeString('{}');
    const idPtr = bridge._job_enqueue(en.ptr, en.len, ea.ptr, ea.len);
    const id = readLP(state, idPtr);

    const c1 = writeString(id);
    expect(bridge._job_cancel(c1.ptr, c1.len)).toBe(0); // cancelled
    const c2 = writeString(id);
    expect(bridge._job_cancel(c2.ptr, c2.len)).toBe(-1); // already cancelled
  });

  it('unknown id returns not_found / empty', () => {
    const { state, writeString } = makeMockState();
    const bridge = createJobsBridge(() => state);
    const n = writeString('nope');
    expect(readLP(state, bridge._job_status(n.ptr, n.len))).toBe('not_found');
    const n2 = writeString('nope');
    expect(readLP(state, bridge._job_result(n2.ptr, n2.len))).toBe('');
  });
});

describe('_job_enqueue_at honours future schedule', () => {
  it('does not run until scheduled_at is reached', () => {
    const { state, registerHandler, writeString } = makeMockState();
    const bridge = createJobsBridge(() => state);

    let calls = 0;
    registerHandler('h', () => { calls++; });

    const rn = writeString('z'); const rh = writeString('h');
    const rbo = writeString('fixed'); const rq = writeString('default');
    bridge._job_register(rn.ptr, rn.len, rh.ptr, rh.len, 3, rbo.ptr, rbo.len, 0, 0, rq.ptr, rq.len);

    startJobWorker(state);

    const en = writeString('z'); const ea = writeString('{}');
    // 60s in the future
    bridge._job_enqueue_at(en.ptr, en.len, ea.ptr, ea.len, Date.now() + 60_000);

    _runJobWorkerTickForTest();
    expect(calls).toBe(0);
  });

  it('runs immediately when scheduled_at is in the past', () => {
    const { state, registerHandler, writeString } = makeMockState();
    const bridge = createJobsBridge(() => state);

    let calls = 0;
    registerHandler('h', () => { calls++; });

    const rn = writeString('z2'); const rh = writeString('h');
    const rbo = writeString('fixed'); const rq = writeString('default');
    bridge._job_register(rn.ptr, rn.len, rh.ptr, rh.len, 3, rbo.ptr, rbo.len, 0, 0, rq.ptr, rq.len);

    startJobWorker(state);
    const en = writeString('z2'); const ea = writeString('{}');
    bridge._job_enqueue_at(en.ptr, en.len, ea.ptr, ea.len, Date.now() - 10_000);

    _runJobWorkerTickForTest();
    expect(calls).toBe(1);
  });
});
