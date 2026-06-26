/**
 * Bridge: int64_to_string
 *
 * Compiler 0.30.362+ lowers integer:64 .toString() to an env.int64_to_string
 * import. The Node host receives the i64 argument as a JS BigInt (Node's
 * default surfacing of WASM i64). String(bigint) preserves the full 64-bit
 * value — Number(bigint) would silently truncate at 2^53.
 *
 * Without this bridge function, WebAssembly.instantiate fails on any module
 * that uses integer:64 .toString().
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createStringBridge } from '../src/bridge/string';
import { createBridgeImports } from '../src/bridge/index';
import { readLengthPrefixedString } from '../src/wasm/memory';
import type { WasmState } from '../src/types';

function makeMockState(memory: WebAssembly.Memory, heapStart: number): WasmState {
  let heapPtr = heapStart;
  const exports = {
    memory,
    malloc: (size: number): number => {
      const ptr = heapPtr;
      heapPtr += size + 4;
      return ptr;
    },
  } as unknown as WasmState['exports'];
  return { exports } as unknown as WasmState;
}

describe('int64_to_string bridge', () => {
  let memory: WebAssembly.Memory;
  const HEAP_START = 2048;

  beforeEach(() => {
    memory = new WebAssembly.Memory({ initial: 2 });
  });

  it('serializes a positive bigint at i64 max', () => {
    const state = makeMockState(memory, HEAP_START);
    const bridge = createStringBridge(() => state);

    const ptr = bridge.int64_to_string(9223372036854775807n);

    expect(readLengthPrefixedString(memory, ptr)).toBe('9223372036854775807');
  });

  it('serializes a negative bigint at i64 min', () => {
    const state = makeMockState(memory, HEAP_START);
    const bridge = createStringBridge(() => state);

    const ptr = bridge.int64_to_string(-9223372036854775808n);

    expect(readLengthPrefixedString(memory, ptr)).toBe('-9223372036854775808');
  });

  it('serializes zero', () => {
    const state = makeMockState(memory, HEAP_START);
    const bridge = createStringBridge(() => state);

    const ptr = bridge.int64_to_string(0n);

    expect(readLengthPrefixedString(memory, ptr)).toBe('0');
  });

  it('preserves precision past 2^53 (Number would truncate)', () => {
    const state = makeMockState(memory, HEAP_START);
    const bridge = createStringBridge(() => state);

    // 2^53 + 1 — first integer not exactly representable as f64
    const ptr = bridge.int64_to_string(9007199254740993n);

    expect(readLengthPrefixedString(memory, ptr)).toBe('9007199254740993');
  });

  it('is registered on the env import object under its canonical name', () => {
    const state = makeMockState(memory, HEAP_START);
    const imports = createBridgeImports(() => state);

    expect(typeof imports.env.int64_to_string).toBe('function');
  });
});
