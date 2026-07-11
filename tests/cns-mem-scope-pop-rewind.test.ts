/**
 * NODE-SERVER-BRIDGE-OOB-TASKS-FILTER (supersedes CNS-MEM-SCOPE-POP-…)
 *
 * The registry (foundation/platform-architecture/function-registry.toml)
 * declares `mem_scope_push` and `mem_scope_pop` as "no-op currently" for
 * every host. Prior revisions of this bridge called the WASM-side
 * `scope_pop` export inside `mem_scope_pop` to rewind `__heap_ptr`, which
 * matched a well-intentioned leak-fix but broke Clean programs that
 * accumulate string state across compiler-emitted scope brackets
 * (`html = html + ...` inside a while loop). Each pop reclaimed the
 * accumulator's backing bytes; the next iteration read garbage and
 * traps fired with "memory access out of bounds".
 *
 * The correct per-request heap rewind lives in workers/request-worker.ts,
 * where it runs exactly once after response body/headers/cookies have
 * been materialized as JS values. These tests pin the corrected contract:
 *
 *   1. `mem_scope_push` does NOT call `state.exports.scope_push`.
 *   2. `mem_scope_pop`  does NOT call `state.exports.scope_pop`.
 *   3. Legacy per-`mem_alloc` refcount cleanup still runs on pop
 *      (for backward compatibility and JS-side bookkeeping).
 *   4. Empty-stack pop is a no-op.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createMemoryRuntimeBridge, resetMemoryRuntime } from '../src/bridge/memory-runtime';
import type { WasmState } from '../src/types';

type ScopeMock = {
  state: WasmState;
  pushCalls: number;
  popCalls: number[];
  freeCalls: number[];
  setHeap: (v: number) => void;
  getHeap: () => number;
};

function makeScopeState(opts: {
  withScopes?: boolean;
  withFree?: boolean;
  startHeap?: number;
} = {}): ScopeMock {
  const { withScopes = true, withFree = true, startHeap = 1024 } = opts;
  const memory = new WebAssembly.Memory({ initial: 1 });
  let heap = startHeap;
  const pushCalls = { n: 0 };
  const popCalls: number[] = [];
  const freeCalls: number[] = [];

  const exports: Record<string, unknown> = {
    memory,
    malloc: (size: number): number => {
      const ptr = heap;
      heap += size;
      return ptr;
    },
  };

  if (withFree) {
    exports.free = (ptr: number): void => {
      freeCalls.push(ptr);
    };
  }

  if (withScopes) {
    exports.scope_push = (): number => {
      pushCalls.n++;
      return heap;
    };
    exports.scope_pop = (snapshot: number): void => {
      popCalls.push(snapshot);
      heap = snapshot;
    };
  }

  const state = {
    exports,
    config: { verbose: false },
  } as unknown as WasmState;

  return {
    state,
    get pushCalls() { return pushCalls.n; },
    popCalls,
    freeCalls,
    setHeap: (v: number) => { heap = v; },
    getHeap: () => heap,
  };
}

describe('mem_scope_push / mem_scope_pop — no-op for WASM heap; legacy refcount only', () => {
  beforeEach(() => {
    resetMemoryRuntime();
  });

  it('mem_scope_push does NOT call state.exports.scope_push', () => {
    const mock = makeScopeState({ startHeap: 4096 });
    const bridge = createMemoryRuntimeBridge(() => mock.state);

    bridge.mem_scope_push();
    expect(mock.pushCalls).toBe(0);
  });

  it('mem_scope_pop does NOT call state.exports.scope_pop', () => {
    const mock = makeScopeState({ startHeap: 4096 });
    const bridge = createMemoryRuntimeBridge(() => mock.state);

    bridge.mem_scope_push();
    const before = mock.getHeap();

    // Simulate WASM-internal allocations growing the heap during the scope.
    mock.setHeap(before + 8192);

    bridge.mem_scope_pop();

    expect(mock.popCalls).toEqual([]);
    // Heap must NOT be rewound — the per-request rewind in request-worker.ts
    // handles it once, after response materialization.
    expect(mock.getHeap()).toBe(before + 8192);
  });

  it('accumulator pattern survives a mem_scope_pop that would previously have rewound it', () => {
    // The exact bug NODE-SERVER-BRIDGE-OOB-TASKS-FILTER protects against:
    // WASM allocates `html` at address A, enters a scope, allocates more,
    // exits the scope. Under the old (broken) implementation, `html` at A
    // would be reclaimed. Under the corrected implementation, `html`
    // survives past the pop until the outer per-request rewind fires.
    const mock = makeScopeState({ startHeap: 4096 });
    const bridge = createMemoryRuntimeBridge(() => mock.state);

    // Simulate the accumulator being allocated first, outside any inner scope.
    const htmlPtr = (mock.state.exports.malloc as (n: number) => number)(64);
    const heapAfterHtml = mock.getHeap();

    bridge.mem_scope_push();
    // Simulate concat inside the loop iteration allocating a working buffer.
    (mock.state.exports.malloc as (n: number) => number)(256);
    bridge.mem_scope_pop();

    // The accumulator's ptr must still be behind the current heap head —
    // any read of htmlPtr's bytes on the WASM side would land in valid memory.
    expect(mock.getHeap()).toBeGreaterThanOrEqual(heapAfterHtml);
    expect(htmlPtr).toBeLessThan(heapAfterHtml);
  });

  it('legacy per-allocation refcount cleanup still runs on pop', () => {
    // mem_alloc'd ptrs are pushed onto the scope's allocations array. On pop,
    // refcounts are decremented and `free` is called for each. Even though
    // `free` is a no-op stub in modern compilers, the JS-side refCounts map
    // is still cleaned up so long-running processes don't grow it unbounded.
    const mock = makeScopeState({ startHeap: 4096 });
    const bridge = createMemoryRuntimeBridge(() => mock.state);

    bridge.mem_scope_push();
    const p1 = bridge.mem_alloc(0, 32);
    const p2 = bridge.mem_alloc(0, 32);
    bridge.mem_scope_pop();

    expect(mock.freeCalls).toEqual(expect.arrayContaining([p1, p2]));
  });

  it('fallback: modules without scope_push/scope_pop exports still pop without throwing', () => {
    const mock = makeScopeState({ withScopes: false, startHeap: 4096 });
    const bridge = createMemoryRuntimeBridge(() => mock.state);

    bridge.mem_scope_push();
    const p1 = bridge.mem_alloc(0, 32);
    expect(() => bridge.mem_scope_pop()).not.toThrow();
    expect(mock.freeCalls).toContain(p1);
  });

  it('pop of an empty stack is a no-op', () => {
    const mock = makeScopeState();
    const bridge = createMemoryRuntimeBridge(() => mock.state);

    expect(() => bridge.mem_scope_pop()).not.toThrow();
    expect(mock.popCalls).toEqual([]);
  });
});
