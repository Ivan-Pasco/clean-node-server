import { WasmState } from '../types';
import { log } from './helpers';

/**
 * Memory scope stack for tracking allocations
 */
interface MemoryScope {
  allocations: number[];
}

let scopeStack: MemoryScope[] = [];
let refCounts: Map<number, number> = new Map();

/**
 * Create memory runtime bridge functions
 *
 * These functions handle Clean Language's memory management model:
 * - mem_alloc: Allocate memory using WASM's malloc
 * - mem_retain: Increment reference count
 * - mem_release: Decrement reference count and free if zero
 * - mem_scope_push: Create a new allocation scope
 * - mem_scope_pop: Release all allocations in current scope
 */
export function createMemoryRuntimeBridge(getState: () => WasmState) {
  return {
    /**
     * Allocate memory of given size.
     *
     * Compiler-emitted calling convention: `mem_alloc(type_id: i32, size: i32) -> i32`.
     * The first argument is a type tag the compiler uses for telemetry; the host
     * implementation ignores it. The second argument is the byte size to allocate.
     * Spec: foundation/platform-architecture/function-registry.toml (`mem_alloc`).
     *
     * Matches clean-server/host-bridge/src/wasm_linker/memory.rs which also
     * declares `(_type_id, size)`.
     */
    mem_alloc(_typeId: number, size: number): number {
      const state = getState();

      if (size <= 0) {
        return 0;
      }

      try {
        const ptr = state.exports.malloc(size);

        // Track allocation in current scope
        if (scopeStack.length > 0) {
          scopeStack[scopeStack.length - 1].allocations.push(ptr);
        }

        // Initialize reference count
        refCounts.set(ptr, 1);

        log(state, 'MEM', `Allocated ${size} bytes at ${ptr}`);
        return ptr;
      } catch (err) {
        log(state, 'MEM', `Allocation failed for ${size} bytes`, err);
        return 0;
      }
    },

    /**
     * Increment reference count for a pointer
     */
    mem_retain(ptr: number): void {
      if (ptr === 0) return;

      const count = refCounts.get(ptr) || 0;
      refCounts.set(ptr, count + 1);
    },

    /**
     * Decrement reference count and free if zero
     */
    mem_release(ptr: number): void {
      if (ptr === 0) return;

      const state = getState();
      const count = refCounts.get(ptr) || 0;

      if (count <= 1) {
        // Free memory if WASM provides a free function
        if (state.exports.free) {
          try {
            state.exports.free(ptr);
            log(state, 'MEM', `Freed memory at ${ptr}`);
          } catch (err) {
            log(state, 'MEM', `Free failed for ${ptr}`, err);
          }
        }
        refCounts.delete(ptr);
      } else {
        refCounts.set(ptr, count - 1);
      }
    },

    /**
     * Push a new memory scope onto the stack
     */
    mem_scope_push(): void {
      scopeStack.push({ allocations: [] });
    },

    /**
     * Pop the current memory scope and release all its allocations
     */
    mem_scope_pop(): void {
      const state = getState();
      const scope = scopeStack.pop();

      if (scope) {
        // Release all allocations in this scope
        for (const ptr of scope.allocations) {
          const count = refCounts.get(ptr) || 0;
          if (count <= 1) {
            if (state.exports.free) {
              try {
                state.exports.free(ptr);
              } catch {
                // Ignore errors during cleanup
              }
            }
            refCounts.delete(ptr);
          } else {
            refCounts.set(ptr, count - 1);
          }
        }
      }
    },
  };
}

/**
 * Reset memory runtime state (for testing or between requests)
 */
export function resetMemoryRuntime(): void {
  scopeStack = [];
  refCounts.clear();
}
