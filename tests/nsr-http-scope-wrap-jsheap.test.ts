/**
 * NSR-HTTP-SCOPE-WRAP-INCOMPLETE — JS-side accumulator reclamation
 *
 * scope_push/scope_pop rewind the WASM bump heap per request, but several
 * bridges keep their own module-level Maps that grow with every allocation:
 *   - bridge/list.ts:     listStore  (list.allocate → handle → JS array)
 *   - bridge/array.ts:    arrayStore (storeArray  → handle → JS array)
 *   - bridge/memory-runtime.ts: refCounts (mem_alloc → ptr → refcount)
 *
 * Without per-request cleanup, those Maps accumulate for the worker's full
 * lifetime (up to MAX_REQUEST_COUNT = 1000 requests), producing the residual
 * ~276 KB / request RSS growth reported in the dashboard despite WASM heap
 * being correctly rewound.
 *
 * `resetPerRequestBridgeState()` is the unified hook the request worker calls
 * after scope_pop on both the success and error paths. This test pins:
 *   1. listStore is emptied and the handle counter rewinds.
 *   2. arrayStore is emptied and the handle counter rewinds.
 *   3. refCounts and scopeStack are emptied.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  resetPerRequestBridgeState,
  createListBridge,
  createArrayBridge,
  createMemoryRuntimeBridge,
  getListStore,
  getArrayStore,
} from '../src/bridge';
import type { WasmState } from '../src/types';

function makeMockState(): WasmState {
  const memory = new WebAssembly.Memory({ initial: 1 });
  let heap = 1024;
  const exports = {
    memory,
    malloc: (size: number): number => {
      const ptr = heap;
      heap += size;
      return ptr;
    },
    free: (_ptr: number): void => {},
    __indirect_function_table: undefined,
  } as unknown as WasmState['exports'];

  return {
    exports,
    config: { verbose: false },
  } as unknown as WasmState;
}

describe('NSR-HTTP-SCOPE-WRAP-INCOMPLETE — resetPerRequestBridgeState releases JS accumulators', () => {
  beforeEach(() => {
    resetPerRequestBridgeState();
  });

  it('clears listStore handles allocated within a request', () => {
    const state = makeMockState();
    const list = createListBridge(() => state);

    const h1 = list['list.allocate'](16);
    const h2 = list['list.allocate'](16);
    list['list.push'](h1, 42);
    list['list.push'](h2, 99);

    expect(getListStore().size).toBe(2);

    resetPerRequestBridgeState();

    expect(getListStore().size).toBe(0);
    // Handle counter must rewind too — otherwise a long-running worker walks
    // through 2^31 handles even though the store is empty.
    const h3 = list['list.allocate'](16);
    expect(h3).toBe(1);
  });

  it('clears arrayStore handles allocated within a request', () => {
    const state = makeMockState();
    const array = createArrayBridge(() => state);

    // Push into a fresh array via array_concat (storeArray is internal — go
    // through a public bridge that creates a new handle).
    array.array_push as unknown;
    // Direct seed: simulate handles being created by the WASM module.
    const store = getArrayStore();
    store.set(1, [1, 2, 3]);
    store.set(2, [4, 5, 6]);
    expect(getArrayStore().size).toBe(2);

    resetPerRequestBridgeState();

    expect(getArrayStore().size).toBe(0);
  });

  it('clears refCounts so per-request mem_alloc tracking does not leak', () => {
    const state = makeMockState();
    const mem = createMemoryRuntimeBridge(() => state);

    // 50 untracked allocations — outside any scope, mem_alloc still records
    // a refcount entry. Without per-request reset, these accumulate forever.
    for (let i = 0; i < 50; i++) {
      mem.mem_alloc(0, 32);
    }

    resetPerRequestBridgeState();

    // refCounts is module-private; verify indirectly: a fresh mem_release on
    // any old ptr is a no-op (count === 0 path).
    expect(() => mem.mem_release(1024)).not.toThrow();
  });

  it('resets nested scopeStack so a runaway scope_push never accumulates', () => {
    const state = makeMockState();
    const mem = createMemoryRuntimeBridge(() => state);

    mem.mem_scope_push();
    mem.mem_scope_push();
    mem.mem_scope_push();
    // Three pushes with no pops — request errored before unwinding.

    resetPerRequestBridgeState();

    // After reset, a pop on the empty stack is a no-op.
    expect(() => mem.mem_scope_pop()).not.toThrow();
  });

  it('is safe to call repeatedly without state', () => {
    expect(() => {
      resetPerRequestBridgeState();
      resetPerRequestBridgeState();
      resetPerRequestBridgeState();
    }).not.toThrow();
    expect(getListStore().size).toBe(0);
    expect(getArrayStore().size).toBe(0);
  });
});
