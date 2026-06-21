/**
 * CNS-MEM-SCOPE-POP-IGNORES-NEW-COMPILER-PRIMITIVE
 *
 * Compiler 0.30.330+ exports `scope_push` (snapshots `__heap_ptr`) and
 * `scope_pop` (restores it). Per-allocation `mem_release` no longer rewinds
 * the bump pointer — `free` is now a no-op stub — so reclaiming string
 * buffers from writeLengthPrefixedString / __malloc (which never register
 * with `mem_alloc` / refcounts) requires the bridge to actually call
 * `state.exports.scope_pop(snapshot)`.
 *
 * These tests pin that contract:
 *   1. mem_scope_push captures the snapshot from `state.exports.scope_push()`.
 *   2. mem_scope_pop calls `state.exports.scope_pop(snapshot)`.
 *   3. The fallback path (no scope_push/scope_pop exports) still works for
 *      pre-0.30.330 modules, exercising the legacy per-allocation cleanup.
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

describe('CNS-MEM-SCOPE-POP — bridge wires scope_push/scope_pop into WASM exports', () => {
  beforeEach(() => {
    resetMemoryRuntime();
  });

  it('mem_scope_push calls state.exports.scope_push and stores its snapshot', () => {
    const mock = makeScopeState({ startHeap: 4096 });
    const bridge = createMemoryRuntimeBridge(() => mock.state);

    bridge.mem_scope_push();
    expect(mock.pushCalls).toBe(1);
  });

  it('mem_scope_pop hands the snapshot back to state.exports.scope_pop', () => {
    const mock = makeScopeState({ startHeap: 4096 });
    const bridge = createMemoryRuntimeBridge(() => mock.state);

    bridge.mem_scope_push();
    const snapshotAtPush = mock.getHeap();

    // Simulate WASM-internal allocations growing the heap during the scope.
    mock.setHeap(snapshotAtPush + 8192);

    bridge.mem_scope_pop();

    expect(mock.popCalls).toEqual([snapshotAtPush]);
    expect(mock.getHeap()).toBe(snapshotAtPush);
  });

  it('rewinds writeLengthPrefixedString-style allocations that never went through mem_alloc', () => {
    // This is the exact bottleneck reported in CNS-MEM-…-POP: 1611
    // string.concat calls per request advanced __heap_ptr via writeString →
    // __malloc with zero mem_release calls. mem_scope_pop must reclaim them
    // via scope_pop even though they never registered with the JS refcount.
    const mock = makeScopeState({ startHeap: 4096 });
    const bridge = createMemoryRuntimeBridge(() => mock.state);

    bridge.mem_scope_push();
    const before = mock.getHeap();

    // Simulate 100 string.concat calls each consuming ~32 bytes.
    for (let i = 0; i < 100; i++) {
      (mock.state.exports.malloc as (n: number) => number)(32);
    }
    expect(mock.getHeap()).toBeGreaterThan(before);

    bridge.mem_scope_pop();
    expect(mock.getHeap()).toBe(before);
  });

  it('nested scopes rewind only their own allocations', () => {
    const mock = makeScopeState({ startHeap: 4096 });
    const bridge = createMemoryRuntimeBridge(() => mock.state);

    bridge.mem_scope_push();
    const outerSnap = mock.getHeap();
    (mock.state.exports.malloc as (n: number) => number)(64);

    bridge.mem_scope_push();
    const innerSnap = mock.getHeap();
    (mock.state.exports.malloc as (n: number) => number)(128);

    bridge.mem_scope_pop();
    expect(mock.getHeap()).toBe(innerSnap);

    bridge.mem_scope_pop();
    expect(mock.getHeap()).toBe(outerSnap);
  });

  it('legacy per-allocation tracking is still reclaimed alongside the scope rewind', () => {
    // For backward compatibility, mem_alloc'd ptrs are still pushed onto the
    // scope's allocations array. On pop, those refcounts are decremented and
    // `free` is called for each. Even though `free` is a no-op stub in modern
    // compilers, the JS-side refCounts map must still be cleaned up.
    const mock = makeScopeState({ startHeap: 4096 });
    const bridge = createMemoryRuntimeBridge(() => mock.state);

    bridge.mem_scope_push();
    const p1 = bridge.mem_alloc(0, 32);
    const p2 = bridge.mem_alloc(0, 32);
    bridge.mem_scope_pop();

    expect(mock.freeCalls).toEqual(expect.arrayContaining([p1, p2]));
    expect(mock.popCalls.length).toBe(1);
  });

  it('fallback: modules without scope_push/scope_pop exports still pop without throwing', () => {
    // Pre-0.30.330 compilers don't export the scope primitives. mem_scope_pop
    // must degrade gracefully: do the legacy per-allocation cleanup and skip
    // the heap rewind.
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
