/**
 * Arena Scope Bridge Registration — HOST-BRIDGE-E001 regression guard
 *
 * Compiler 0.31.5+ (confirmed on 0.33.2) emits `env._arena_scope_push` and
 * `env._arena_scope_pop` as WASM imports on every module. clean-node-server
 * 0.1.72 through 0.1.76 shipped without handlers, causing every fresh WASM
 * to fail WebAssembly.instantiate with:
 *
 *   LinkError: Import #N module="env" function="_arena_scope_push"
 *              error: function import requires a callable
 *
 * This test verifies both handlers are registered and callable as no-ops.
 * Signatures (verified via wasm-tools print on a 0.33.2-produced module):
 *   _arena_scope_push: () -> i32
 *   _arena_scope_pop:  (i32) -> void
 */

import { describe, it, expect } from 'vitest';
import { createBridgeImports } from '../src/bridge/index';
import type { WasmState } from '../src/types';

function makeMockState(): WasmState {
  const memory = new WebAssembly.Memory({ initial: 2 });
  let heapPtr = 4096;
  const exports = {
    memory,
    malloc: (size: number): number => {
      const ptr = heapPtr;
      heapPtr += size + 4;
      return ptr;
    },
  } as unknown as WasmState['exports'];
  return { exports, projectRoot: '/tmp' } as unknown as WasmState;
}

describe('Arena scope bridges (HOST-BRIDGE-E001)', () => {
  const state = makeMockState();
  const imports = createBridgeImports(() => state);
  const env = imports.env as Record<string, unknown>;

  it('_arena_scope_push is registered as a callable function', () => {
    expect(typeof env._arena_scope_push).toBe('function');
  });

  it('_arena_scope_pop is registered as a callable function', () => {
    expect(typeof env._arena_scope_pop).toBe('function');
  });

  it('_arena_scope_push returns an i32 (numeric) marker without throwing', () => {
    const push = env._arena_scope_push as () => number;
    const marker = push();
    expect(typeof marker).toBe('number');
    expect(Number.isFinite(marker)).toBe(true);
  });

  it('_arena_scope_pop accepts the marker returned by push without throwing', () => {
    const push = env._arena_scope_push as () => number;
    const pop = env._arena_scope_pop as (marker: number) => void;
    const marker = push();
    expect(() => pop(marker)).not.toThrow();
  });
});
