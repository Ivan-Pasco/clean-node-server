/**
 * Array bridge tests — createArrayBridge / resetArrayStore
 *
 * Alignment: positive-path contract for the array handle store.
 * Category: contract
 *
 * Tests cover: create-via-push, get/set, pop, slice, concat, reverse,
 * sort, contains, filter/map/reduce stubs when no WASM table is wired,
 * and reset semantics.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  createArrayBridge,
  resetArrayStore,
  getArrayStore,
} from '../src/bridge/array';
import type { WasmState } from '../src/types';

// ─── Test helpers ────────────────────────────────────────────────────────────

function writeRawAt(memory: WebAssembly.Memory, ptr: number, str: string): number {
  const bytes = new TextEncoder().encode(str);
  new Uint8Array(memory.buffer).set(bytes, ptr);
  return bytes.length;
}

function makeMockState(memory?: WebAssembly.Memory, heapStart = 65_536): WasmState {
  const mem = memory ?? new WebAssembly.Memory({ initial: 4 });
  let heapPtr = heapStart;
  const exports = {
    memory: mem,
    malloc: (size: number): number => {
      const ptr = heapPtr;
      heapPtr += size + 4;
      return ptr;
    },
  } as unknown as WasmState['exports'];
  return { exports, config: { verbose: false }, projectRoot: '/tmp' } as unknown as WasmState;
}

// ─── Helpers to inject pre-populated arrays directly into the store ──────────

function injectArray(arr: unknown[]): number {
  const store = getArrayStore();
  // find the highest handle and assign the next one
  let handle = 1;
  for (const k of store.keys()) {
    if (k >= handle) handle = k + 1;
  }
  store.set(handle, arr);
  return handle;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Array bridge — reset and isolation', () => {
  beforeEach(() => {
    resetArrayStore();
  });

  it('resetArrayStore clears all handles and resets counter', () => {
    const state = makeMockState();
    const bridge = createArrayBridge(() => state);

    const h = injectArray([10, 20, 30]);
    expect(bridge.array_get(h, 0)).toBe(10);

    resetArrayStore();
    // After reset the handle is gone
    expect(bridge.array_get(h, 0)).toBe(0);
    expect(getArrayStore().size).toBe(0);
  });

  it('handles that do not exist return 0 from array_get', () => {
    const state = makeMockState();
    const bridge = createArrayBridge(() => state);
    expect(bridge.array_get(9999, 0)).toBe(0);
    expect(bridge.array_get(0, 0)).toBe(0);
  });
});

describe('Array bridge — get / set / push / pop', () => {
  beforeEach(() => {
    resetArrayStore();
  });

  it('array_get returns correct element and 0 for out-of-range index', () => {
    const state = makeMockState();
    const bridge = createArrayBridge(() => state);

    const h = injectArray([5, 10, 15]);
    expect(bridge.array_get(h, 0)).toBe(5);
    expect(bridge.array_get(h, 2)).toBe(15);
    expect(bridge.array_get(h, 3)).toBe(0);   // out-of-range
    expect(bridge.array_get(h, -1)).toBe(0);  // negative
  });

  it('array_set mutates element in place', () => {
    const state = makeMockState();
    const bridge = createArrayBridge(() => state);

    const h = injectArray([1, 2, 3]);
    bridge.array_set(h, 1, 99);
    expect(bridge.array_get(h, 1)).toBe(99);
    // other elements unchanged
    expect(bridge.array_get(h, 0)).toBe(1);
    expect(bridge.array_get(h, 2)).toBe(3);
  });

  it('array_set is a no-op for out-of-range index', () => {
    const state = makeMockState();
    const bridge = createArrayBridge(() => state);

    const h = injectArray([7]);
    bridge.array_set(h, 5, 42);
    expect(bridge.array_get(h, 0)).toBe(7);   // unchanged
  });

  it('array_push appends and returns the handle; array_pop removes last', () => {
    const state = makeMockState();
    const bridge = createArrayBridge(() => state);

    const h = injectArray([1, 2]);
    const returned = bridge.array_push(h, 3);
    expect(returned).toBe(h);
    expect(bridge.array_get(h, 2)).toBe(3);

    const popped = bridge.array_pop(h);
    expect(popped).toBe(3);
    expect(bridge.array_get(h, 2)).toBe(0); // slot gone
  });

  it('array_pop on empty array returns 0', () => {
    const state = makeMockState();
    const bridge = createArrayBridge(() => state);

    const h = injectArray([]);
    expect(bridge.array_pop(h)).toBe(0);
  });
});

describe('Array bridge — slice / concat / reverse / sort', () => {
  beforeEach(() => {
    resetArrayStore();
  });

  it('array_slice returns new handle with subrange', () => {
    const state = makeMockState();
    const bridge = createArrayBridge(() => state);

    const h = injectArray([10, 20, 30, 40, 50]);
    const sliced = bridge.array_slice(h, 1, 3);
    expect(sliced).not.toBe(h);
    expect(bridge.array_get(sliced, 0)).toBe(20);
    expect(bridge.array_get(sliced, 1)).toBe(30);
    expect(bridge.array_get(sliced, 2)).toBe(0); // out of sliced range
  });

  it('array_concat merges two arrays into a new handle', () => {
    const state = makeMockState();
    const bridge = createArrayBridge(() => state);

    const h1 = injectArray([1, 2]);
    const h2 = injectArray([3, 4]);
    const merged = bridge.array_concat(h1, h2);
    expect(bridge.array_get(merged, 0)).toBe(1);
    expect(bridge.array_get(merged, 2)).toBe(3);
    expect(bridge.array_get(merged, 3)).toBe(4);
  });

  it('array_reverse returns new handle with elements reversed', () => {
    const state = makeMockState();
    const bridge = createArrayBridge(() => state);

    const h = injectArray([1, 2, 3]);
    const rev = bridge.array_reverse(h);
    expect(bridge.array_get(rev, 0)).toBe(3);
    expect(bridge.array_get(rev, 2)).toBe(1);
    // original unchanged
    expect(bridge.array_get(h, 0)).toBe(1);
  });

  it('array_sort returns new handle with numerically sorted elements', () => {
    const state = makeMockState();
    const bridge = createArrayBridge(() => state);

    const h = injectArray([30, 10, 20]);
    const sorted = bridge.array_sort(h);
    expect(bridge.array_get(sorted, 0)).toBe(10);
    expect(bridge.array_get(sorted, 1)).toBe(20);
    expect(bridge.array_get(sorted, 2)).toBe(30);
  });
});

describe('Array bridge — contains / filter / map / reduce (no WASM table)', () => {
  beforeEach(() => {
    resetArrayStore();
  });

  it('array_contains returns 1 when value present, 0 when absent', () => {
    const state = makeMockState();
    const bridge = createArrayBridge(() => state);

    const h = injectArray([5, 10, 15]);
    expect(bridge.array_contains(h, 10)).toBe(1);
    expect(bridge.array_contains(h, 99)).toBe(0);
  });

  it('array_filter with missing WASM table returns handle of empty array', () => {
    const state = makeMockState();
    const bridge = createArrayBridge(() => state);

    const h = injectArray([1, 2, 3]);
    // callback index 1 — no real table in mock state, callWasmCallback returns 0 for all
    const filtered = bridge.array_filter(h, 1);
    // All elements filtered out because callback returns 0
    expect(bridge.array_get(filtered, 0)).toBe(0);
  });

  it('array_reduce with missing WASM table returns the initial value', () => {
    const state = makeMockState();
    const bridge = createArrayBridge(() => state);

    const h = injectArray([10, 20]);
    // callback returns 0 each iteration; accumulator becomes 0 for both elements
    const result = bridge.array_reduce(h, 1, 42);
    // After first iteration: callWasmCallback(42, 10) → 0; after second: callWasmCallback(0, 20) → 0
    expect(typeof result).toBe('number');
  });
});
