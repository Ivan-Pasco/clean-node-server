import { WasmState, WasmExports } from '../types';
import { log } from './helpers';
import { bumpHeapPtr } from '../wasm/memory';

/**
 * Memory scope stack for tracking allocations.
 *
 * `allocations` is the legacy per-`mem_alloc` tracking kept for backward
 * compatibility with older compilers and for the few non-region allocators
 * that genuinely want refcount semantics.
 *
 * Per foundation/platform-architecture/function-registry.toml, mem_scope_push
 * and mem_scope_pop are declared "no-op currently" for every host. The per-
 * request `__heap_ptr` rewind lives in workers/request-worker.ts, where it
 * fires exactly once per request AFTER response body/headers/cookies have
 * been materialized as JS values — so no live WASM pointer straddles the
 * rewind. Rewinding INSIDE the handler on every `mem_scope_pop` (as prior
 * revisions did) invalidates pointers the WASM still holds — e.g. a while
 * loop accumulating a string with `html = html + …` where the compiler
 * emits `mem_scope_push` / `mem_scope_pop` around each iteration but `html`
 * itself is declared outside the loop. The per-iteration rewind reclaims
 * html's backing bytes; the next iteration reads garbage → OOB trap.
 * (NODE-SERVER-BRIDGE-OOB-TASKS-FILTER, fingerprint 654ef241296a631e.)
 * clean-server's Rust bridge also treats these as no-ops for the same
 * reason.
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
     *
     * NSR002 (0.1.66 follow-up): bump `__heap_ptr` past the allocation before
     * returning. The compiler emits `mem_alloc` calls for every non-string
     * object (records, list element slots, struct/class instances). Without
     * the defensive bump, the WASM-internal `__malloc` reads a stale
     * `__heap_ptr` on its next call and hands out a pointer that overlaps the
     * mem_alloc'd block, corrupting its first 4–8 bytes and producing the
     * "memory access out of bounds" trap that survived the 7679a9e fix.
     * Parity with clean-server's Rust `mem_alloc` (host-bridge/src/wasm_linker/memory.rs).
     */
    mem_alloc(_typeId: number, size: number): number {
      const state = getState();

      if (size <= 0) {
        return 0;
      }

      try {
        const ptr = state.exports.malloc(size);
        if (ptr === 0) {
          return 0;
        }

        // Track allocation in current scope
        if (scopeStack.length > 0) {
          scopeStack[scopeStack.length - 1].allocations.push(ptr);
        }

        // Initialize reference count
        refCounts.set(ptr, 1);

        // See bumpHeapPtr in wasm/memory.ts — the WASM `__malloc` doesn't
        // always advance `__heap_ptr` before returning to the bridge, so the
        // next allocation can overlap this one. Force the bump to break that
        // chain (matches concatLengthPrefixed / string_split / writeString).
        bumpHeapPtr(state.exports, ptr, size);

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
     * Push a new memory scope onto the stack.
     *
     * No-op for WASM heap management per the registry contract; retained as
     * a stack marker so `mem_scope_pop`'s legacy per-allocation cleanup
     * still balances. See header comment for why the WASM-side `scope_push`
     * export is NOT called here.
     */
    mem_scope_push(): void {
      scopeStack.push({ allocations: [] });
    },

    /**
     * Pop the current memory scope and release its legacy per-`mem_alloc`
     * allocations.
     *
     * Does NOT rewind `__heap_ptr`. The compiler emits these scope brackets
     * around handler internals expecting them to be advisory — clean-server
     * treats them as no-ops. The actual per-request heap rewind runs once
     * per request in workers/request-worker.ts, AFTER response body/headers/
     * cookies have been materialized as JS strings/objects, so no live WASM
     * pointer survives the rewind. Rewinding on every internal
     * `mem_scope_pop` (as prior revisions did) would invalidate pointers the
     * WASM code still holds — see NODE-SERVER-BRIDGE-OOB-TASKS-FILTER.
     */
    mem_scope_pop(): void {
      const state = getState();
      const scope = scopeStack.pop();
      if (!scope) return;

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
