/**
 * List bridge tests — createListBridge / resetListStore
 *
 * Alignment: positive-path contract for the list handle store.
 * Category: contract
 *
 * Tests cover: allocate, push (i32 and f64), add, get, set, remove,
 * clear, contains, isEmpty, and resetListStore semantics.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  createListBridge,
  resetListStore,
  getListStore,
} from '../src/bridge/list';
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

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('List bridge — reset and isolation', () => {
  beforeEach(() => {
    resetListStore();
  });

  it('resetListStore clears all handles', () => {
    const state = makeMockState();
    const bridge = createListBridge(() => state);

    const h = bridge['list.allocate'](10);
    bridge['list.push'](h, 42);
    expect(bridge['list.get'](h, 0)).toBe(42);

    resetListStore();
    // Handle is now invalid — get returns 0
    expect(bridge['list.get'](h, 0)).toBe(0);
    expect(getListStore().size).toBe(0);
  });

  it('invalid handle returns 0 from list.get', () => {
    const state = makeMockState();
    const bridge = createListBridge(() => state);
    expect(bridge['list.get'](9999, 0)).toBe(0);
  });
});

describe('List bridge — allocate / push / get / set', () => {
  beforeEach(() => {
    resetListStore();
  });

  it('list.allocate returns a positive handle and the list starts empty', () => {
    const state = makeMockState();
    const bridge = createListBridge(() => state);

    const h = bridge['list.allocate'](0);
    expect(h).toBeGreaterThan(0);
    expect(bridge['list.isEmpty'](h)).toBe(1);
  });

  it('list.push appends integer values and list.get retrieves them', () => {
    const state = makeMockState();
    const bridge = createListBridge(() => state);

    const h = bridge['list.allocate'](4);
    bridge['list.push'](h, 10);
    bridge['list.push'](h, 20);
    bridge['list.push'](h, 30);

    expect(bridge['list.get'](h, 0)).toBe(10);
    expect(bridge['list.get'](h, 1)).toBe(20);
    expect(bridge['list.get'](h, 2)).toBe(30);
  });

  it('list.get returns 0 for out-of-range indices', () => {
    const state = makeMockState();
    const bridge = createListBridge(() => state);

    const h = bridge['list.allocate'](2);
    bridge['list.push'](h, 5);
    expect(bridge['list.get'](h, 1)).toBe(0);   // index 1, only 0 filled
    expect(bridge['list.get'](h, -1)).toBe(0);  // negative
  });

  it('list.set mutates an existing element', () => {
    const state = makeMockState();
    const bridge = createListBridge(() => state);

    const h = bridge['list.allocate'](2);
    bridge['list.push'](h, 1);
    bridge['list.push'](h, 2);

    bridge['list.set'](h, 0, 99);
    expect(bridge['list.get'](h, 0)).toBe(99);
    expect(bridge['list.get'](h, 1)).toBe(2); // unchanged
  });

  it('list.push_f64 stores floating-point values', () => {
    const state = makeMockState();
    const bridge = createListBridge(() => state);

    const h = bridge['list.allocate'](2);
    bridge['list.push_f64'](h, 3.14);
    bridge['list.push_f64'](h, 2.71);

    expect(bridge['list.get'](h, 0)).toBeCloseTo(3.14, 5);
    expect(bridge['list.get'](h, 1)).toBeCloseTo(2.71, 5);
  });
});

describe('List bridge — remove / clear / contains / isEmpty / add', () => {
  beforeEach(() => {
    resetListStore();
  });

  it('list.remove deletes the element at the given index and shifts the rest', () => {
    const state = makeMockState();
    const bridge = createListBridge(() => state);

    const h = bridge['list.allocate'](3);
    bridge['list.push'](h, 10);
    bridge['list.push'](h, 20);
    bridge['list.push'](h, 30);

    bridge['list.remove'](h, 1); // remove 20
    expect(bridge['list.get'](h, 0)).toBe(10);
    expect(bridge['list.get'](h, 1)).toBe(30);
    expect(bridge['list.get'](h, 2)).toBe(0); // out of range now
  });

  it('list.clear empties the list', () => {
    const state = makeMockState();
    const bridge = createListBridge(() => state);

    const h = bridge['list.allocate'](3);
    bridge['list.push'](h, 1);
    bridge['list.push'](h, 2);
    bridge['list.clear'](h);

    expect(bridge['list.isEmpty'](h)).toBe(1);
    expect(bridge['list.get'](h, 0)).toBe(0);
  });

  it('list.contains returns 1 when present and 0 when absent', () => {
    const state = makeMockState();
    const bridge = createListBridge(() => state);

    const h = bridge['list.allocate'](3);
    bridge['list.push'](h, 42);
    bridge['list.push'](h, 7);

    expect(bridge['list.contains'](h, 42)).toBe(1);
    expect(bridge['list.contains'](h, 7)).toBe(1);
    expect(bridge['list.contains'](h, 99)).toBe(0);
  });

  it('list.add appends a pointer value and list.isEmpty toggles correctly', () => {
    const state = makeMockState();
    const bridge = createListBridge(() => state);

    const h = bridge['list.allocate'](2);
    expect(bridge['list.isEmpty'](h)).toBe(1);

    bridge['list.add'](h, 1234);
    expect(bridge['list.isEmpty'](h)).toBe(0);
    expect(bridge['list.get'](h, 0)).toBe(1234);
  });
});
