/**
 * withWasmScope contract — NSR-NO-PER-REQUEST-MEMORY-RELEASE
 *
 * Locks the per-call scope wrapper used by request-worker, sse-worker,
 * schedule.ts, and jobs.ts. The host calls `scope_push` to snapshot
 * `__heap_ptr`, runs the handler, then `scope_pop(snapshot)` to rewind the
 * bump pointer. Without this wrap, every handler invocation permanently
 * advances the worker's heap and the process leaks until OOM.
 */
import { describe, it, expect } from 'vitest';
import { withWasmScope } from '../src/wasm/memory';
import type { WasmExports } from '../src/types';

function makeScopedExports(initialHeap: number): {
  exports: WasmExports;
  heap: { value: number };
  pushCount: number;
  popHistory: number[];
} {
  const heap = { value: initialHeap };
  const state = { pushCount: 0, popHistory: [] as number[] };

  const exports = {
    memory: new WebAssembly.Memory({ initial: 1 }),
    scope_push: () => {
      state.pushCount++;
      return heap.value;
    },
    scope_pop: (snapshot: number) => {
      state.popHistory.push(snapshot);
      heap.value = snapshot;
    },
    malloc: (size: number) => {
      const ptr = heap.value;
      heap.value += size;
      return ptr;
    },
  } as unknown as WasmExports;

  return { exports, heap, get pushCount() { return state.pushCount; }, get popHistory() { return state.popHistory; } } as never;
}

function exportsWithoutScopes(): WasmExports {
  return {
    memory: new WebAssembly.Memory({ initial: 1 }),
    malloc: (_size: number) => 0,
  } as unknown as WasmExports;
}

describe('withWasmScope', () => {
  it('snapshots __heap_ptr on entry and rewinds on success', () => {
    const ctx = makeScopedExports(1024);

    const result = withWasmScope(ctx.exports, () => {
      // Simulate the handler doing several allocations.
      (ctx.exports as unknown as { malloc: (n: number) => number }).malloc(100);
      (ctx.exports as unknown as { malloc: (n: number) => number }).malloc(200);
      return 'response-body';
    });

    expect(result).toBe('response-body');
    expect(ctx.pushCount).toBe(1);
    expect(ctx.popHistory).toEqual([1024]);
    expect(ctx.heap.value).toBe(1024); // rewound
  });

  it('rewinds the scope even when the handler throws', () => {
    const ctx = makeScopedExports(2048);

    expect(() => withWasmScope(ctx.exports, () => {
      (ctx.exports as unknown as { malloc: (n: number) => number }).malloc(500);
      throw new Error('handler trap');
    })).toThrow('handler trap');

    expect(ctx.pushCount).toBe(1);
    expect(ctx.popHistory).toEqual([2048]);
    expect(ctx.heap.value).toBe(2048); // rewound on error path
  });

  it('handles nested scopes correctly', () => {
    const ctx = makeScopedExports(0);

    withWasmScope(ctx.exports, () => {
      (ctx.exports as unknown as { malloc: (n: number) => number }).malloc(10);
      withWasmScope(ctx.exports, () => {
        (ctx.exports as unknown as { malloc: (n: number) => number }).malloc(20);
      });
      expect(ctx.heap.value).toBe(10); // inner rewound, outer still grown
    });

    expect(ctx.heap.value).toBe(0); // outer rewound
    expect(ctx.pushCount).toBe(2);
    // Inner pop sees 10, outer pop sees 0.
    expect(ctx.popHistory).toEqual([10, 0]);
  });

  it('falls back to direct invocation when scope_push/scope_pop are missing', () => {
    const exports = exportsWithoutScopes();
    let ran = false;
    const result = withWasmScope(exports, () => {
      ran = true;
      return 42;
    });
    expect(result).toBe(42);
    expect(ran).toBe(true);
  });

  it('does not swallow scope_pop errors — the handler return value still flows through', () => {
    const exports = {
      memory: new WebAssembly.Memory({ initial: 1 }),
      scope_push: () => 100,
      scope_pop: () => { throw new Error('scope_pop trap'); },
    } as unknown as WasmExports;

    // The pop error is intentionally swallowed; the handler result must still
    // reach the caller so the request can be responded to normally.
    const result = withWasmScope(exports, () => 'ok');
    expect(result).toBe('ok');
  });
});
