/**
 * NSR002 follow-up — `mem_alloc` (memory_runtime bridge) must also bump
 * `__heap_ptr` after every allocation.
 *
 * The 0.1.66 fix added the defensive bump to `concatLengthPrefixed`,
 * `string_split`, `writeLengthPrefixedString`, and `writeRawBytes`, but
 * `memory_runtime.mem_alloc` (src/bridge/memory-runtime.ts) still calls
 * `state.exports.malloc(size)` directly and returns without touching the
 * global. The compiler uses `mem_alloc` for every non-string object the
 * Clean Language program allocates (tutorial records, list element slots,
 * struct/class instances, etc.), so any iterate-over-DB-rows pattern that
 * runs alongside string ops can still hand out overlapping pointers and
 * surface as the WASM "memory access out of bounds" trap the reporter
 * verified persists in 0.1.65.
 *
 * Reference: clean-server/host-bridge/src/wasm_linker/memory.rs — the Rust
 * `mem_alloc` also bumps the heap pointer in the same way. Without parity
 * here, node-server has a hole that doesn't exist in the Rust runtime.
 *
 * This test uses the SAME buggy-malloc pathology as
 * `nsr002-heap-ptr-overlap.test.ts` (the malloc's internal bump pointer
 * regresses to the global on every call), so two consecutive `mem_alloc`
 * calls return the same pointer until the bridge forces the bump.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createMemoryRuntimeBridge, resetMemoryRuntime } from '../src/bridge/memory-runtime';
import {
  writeLengthPrefixedString,
  readLengthPrefixedString,
} from '../src/wasm/memory';
import type { WasmState, WasmResponse } from '../src/types';

function defaultResponse(): WasmResponse {
  return { status: 200, headers: {}, body: '', cookies: [] };
}

function makeBuggyMallocState(
  memory: WebAssembly.Memory,
  heapStart: number,
): WasmState {
  let heapPtr = heapStart;
  const heapGlobal = new WebAssembly.Global(
    { value: 'i32', mutable: true },
    heapStart,
  );
  const exports = {
    memory,
    __heap_ptr: heapGlobal,
    malloc: (size: number): number => {
      // Same pathology as nsr002-heap-ptr-overlap: the internal bump
      // pointer regresses to the global on every call, so a bridge that
      // forgets to bump the global hands out overlapping pointers.
      heapPtr = heapGlobal.value;
      const ptr = heapPtr;
      heapPtr += size;
      return ptr;
    },
  } as unknown as WasmState['exports'];
  return {
    exports,
    instance: { exports } as unknown as WebAssembly.Instance,
    response: defaultResponse(),
    config: { verbose: false },
  } as unknown as WasmState;
}

describe('NSR002 — mem_alloc must bump __heap_ptr to prevent allocator overlap', () => {
  let memory: WebAssembly.Memory;
  let state: WasmState;

  beforeEach(() => {
    resetMemoryRuntime();
    memory = new WebAssembly.Memory({ initial: 4 });
    state = makeBuggyMallocState(memory, 4096);
  });

  it('consecutive mem_alloc calls return non-overlapping pointers', () => {
    const bridge = createMemoryRuntimeBridge(() => state);
    const a = bridge.mem_alloc(/* typeId */ 0, 32);
    const b = bridge.mem_alloc(/* typeId */ 0, 32);

    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(0);
    expect(b).not.toBe(a);
    // 8-byte alignment parity with clean-server (host-bridge helpers.rs:221).
    expect(b).toBeGreaterThanOrEqual((a + 32 + 7) & ~7);
  });

  it('mem_alloc followed by writeLengthPrefixedString — no overlap with the object', () => {
    // The prod pattern: WASM mem_allocs a record (tutorial row, list element
    // slot, struct field block), then bridge code writes a string into that
    // record via writeLengthPrefixedString. Without the bump, the string
    // write overlaps the record and corrupts its first 4–8 bytes.
    const bridge = createMemoryRuntimeBridge(() => state);

    const recordPtr = bridge.mem_alloc(0, 64);
    // Stamp a sentinel into the record so we can detect corruption.
    const view = new DataView(memory.buffer);
    for (let i = 0; i < 64; i += 4) {
      view.setUint32(recordPtr + i, 0xcafef00d, true);
    }

    const stringPtr = writeLengthPrefixedString(state.exports, 'hello world');
    expect(stringPtr).toBeGreaterThanOrEqual(recordPtr + 64);

    // The record sentinel must still be intact.
    for (let i = 0; i < 64; i += 4) {
      expect(view.getUint32(recordPtr + i, true)).toBe(0xcafef00d);
    }
    expect(readLengthPrefixedString(memory, stringPtr)).toBe('hello world');
  });

  it('30 mem_alloc iterations interleaved with strings (prod 30-card render pattern)', () => {
    // Mirrors the /tutorials render loop where each iteration:
    //   - mem_allocs a record slot for the row
    //   - writes a couple of strings into the slot via writeLengthPrefixedString
    // Without the bump after mem_alloc, the strings clobber the record's
    // pointer fields, and the next iterate step reads garbage and traps.
    const bridge = createMemoryRuntimeBridge(() => state);
    const view = new DataView(memory.buffer);

    const records: number[] = [];
    for (let i = 0; i < 30; i++) {
      const slot = bridge.mem_alloc(0, 48);
      // unique sentinel per slot — `>>> 0` forces unsigned i32 so the value
      // round-trips through getUint32 without a signed-vs-unsigned mismatch.
      const sentinel = (0xa0a0a0a0 | i) >>> 0;
      view.setUint32(slot, sentinel, true);
      writeLengthPrefixedString(state.exports, `title-${i}`);
      writeLengthPrefixedString(state.exports, `slug-${i}`);
      records.push(slot);
    }

    // All 30 slots must still carry their original sentinels.
    for (let i = 0; i < 30; i++) {
      const expected = (0xa0a0a0a0 | i) >>> 0;
      expect(view.getUint32(records[i], true)).toBe(expected);
    }
  });

  it('parity with clean-server: __heap_ptr is bumped to (ptr + size + 7) & ~7 after mem_alloc', () => {
    const bridge = createMemoryRuntimeBridge(() => state);
    const heapGlobal = state.exports.__heap_ptr as WebAssembly.Global;
    const before = heapGlobal.value as number;

    const size = 24;
    const ptr = bridge.mem_alloc(0, size);
    const expected = (ptr + size + 7) & ~7;

    expect(heapGlobal.value).toBeGreaterThanOrEqual(expected);
    expect(heapGlobal.value).toBeGreaterThan(before);
  });

  it('mem_alloc on size <= 0 still returns 0 without touching the heap pointer', () => {
    // Negative / zero sizes are a no-op contract from memory-runtime.ts — the
    // bump must not run for them either, otherwise we'd advance the heap on
    // a phantom allocation.
    const bridge = createMemoryRuntimeBridge(() => state);
    const heapGlobal = state.exports.__heap_ptr as WebAssembly.Global;
    const before = heapGlobal.value as number;

    expect(bridge.mem_alloc(0, 0)).toBe(0);
    expect(bridge.mem_alloc(0, -16)).toBe(0);
    expect(heapGlobal.value).toBe(before);
  });
});
