/**
 * Memory Runtime Bridge — Calling Convention Tests
 *
 * The compiler emits the `memory_runtime.mem_alloc` WASM import with the
 * signature `(type_id: i32, size: i32) -> i32`. The first argument is a type
 * tag the host ignores; the second argument is the byte size to allocate.
 *
 * Earlier revisions declared `mem_alloc(size: number)` (single param). JavaScript
 * silently drops extra arguments, so when WASM called `mem_alloc(0, 12)` the
 * JS function read `size = 0`, hit its `size <= 0` guard, and returned 0. Every
 * boxed value pointed at the null pointer and `json.encode` of any string
 * produced the literal `"null"` (4 bytes) — see fingerprint
 * `ad8fa652d2da3853337641cfc4fb818769b8c634ce6dcd1b77a290dafdc81710`
 * (NODE-MEM-ALLOC-SIGNATURE-MISMATCH).
 *
 * Spec: foundation/platform-architecture/function-registry.toml — `mem_alloc`
 * params = ["i32", "i32"]. Matches the Rust host in
 * clean-server/host-bridge/src/wasm_linker/memory.rs (which also takes
 * `_type_id, size`).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createMemoryRuntimeBridge, resetMemoryRuntime } from '../src/bridge/memory-runtime';
import type { WasmState } from '../src/types';

function makeMockState(): { state: WasmState; mallocCalls: number[] } {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const mallocCalls: number[] = [];
  let heapPtr = 1024;
  const exports = {
    memory,
    malloc: (size: number): number => {
      mallocCalls.push(size);
      const ptr = heapPtr;
      heapPtr += size;
      return ptr;
    },
  } as unknown as WasmState['exports'];
  const state = {
    exports,
    config: { verbose: false } as WasmState['config'],
  } as unknown as WasmState;
  return { state, mallocCalls };
}

describe('memory_runtime.mem_alloc — compiler calling convention', () => {
  beforeEach(() => {
    resetMemoryRuntime();
  });

  it('reads byte size from the second argument (type_id, size)', () => {
    const { state, mallocCalls } = makeMockState();
    const bridge = createMemoryRuntimeBridge(() => state);

    // Compiler emits `mem_alloc(type_id=0, size=12)` to box a String.
    const ptr = (bridge.mem_alloc as (a: number, b: number) => number)(0, 12);

    expect(mallocCalls).toEqual([12]);
    expect(ptr).toBeGreaterThan(0);
  });

  it('returns 0 when size (second arg) is non-positive', () => {
    const { state, mallocCalls } = makeMockState();
    const bridge = createMemoryRuntimeBridge(() => state);

    const ptr = (bridge.mem_alloc as (a: number, b: number) => number)(42, 0);

    expect(ptr).toBe(0);
    expect(mallocCalls).toEqual([]);
  });

  it('does not treat the type_id (first arg) as the size', () => {
    // If the bridge mistakenly used the first arg as size, allocating
    // (type_id=64, size=8) would call malloc(64) and return a valid pointer
    // but produce a buffer too small for `size`. Confirm malloc is called
    // with the second arg (8), not the first (64).
    const { state, mallocCalls } = makeMockState();
    const bridge = createMemoryRuntimeBridge(() => state);

    (bridge.mem_alloc as (a: number, b: number) => number)(64, 8);

    expect(mallocCalls).toEqual([8]);
  });
});
