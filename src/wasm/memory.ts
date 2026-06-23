import { WasmExports } from '../types';

const WASM_PAGE_BYTES = 65_536;
const DEFAULT_PREGROW_BYTES = 16 * 1024 * 1024; // 16 MB

/**
 * Defensively bump the `__heap_ptr` exported global past a host-side allocation.
 *
 * The compiler's `__malloc` uses `__heap_ptr` as the bump pointer for WASM-side
 * allocations. Re-entrant mallocs called from host bridge functions don't always
 * advance the global by the time control returns to the bridge — the global is
 * still at its pre-call value when the NEXT bridge function asks malloc for
 * memory, so the next allocation overlaps the first. The overlap corrupts the
 * first allocation's length prefix, and the next WASM read pulls a huge bogus
 * length and traps with "memory access out of bounds".
 *
 * Clean-server's Rust bridge has the same guard in `write_string_to_caller`,
 * `write_bytes_to_caller`, and `write_string_list_to_caller`
 * (host-bridge/src/wasm_linker/helpers.rs). This function brings node-server
 * into parity.
 *
 * The bump aligns to 8 bytes so any subsequent f64 allocation (e.g. from
 * `list.push_f64`) lands aligned.
 */
function bumpHeapPtrPastAllocation(exports: WasmExports, ptr: number, totalSize: number): void {
  const heapGlobal = (exports as unknown as Record<string, unknown>).__heap_ptr as
    | WebAssembly.Global
    | undefined;
  if (!heapGlobal) return;
  const expected = (ptr + totalSize + 7) & ~7;
  const current = heapGlobal.value as number;
  if (typeof current === 'number' && current < expected) {
    heapGlobal.value = expected;
  }
}

/**
 * Internal export so other bridge helpers (concatLengthPrefixed, string_split,
 * etc.) can apply the same defensive bump after their own malloc calls.
 */
export function bumpHeapPtr(exports: WasmExports, ptr: number, totalSize: number): void {
  bumpHeapPtrPastAllocation(exports, ptr, totalSize);
}

/**
 * Read a length-prefixed string from WASM memory
 * Format: [4-byte LE length][UTF-8 bytes]
 *
 * @param memory - WASM memory instance
 * @param ptr - Pointer to the string (pointing to length prefix)
 * @returns Decoded string
 */
export function readLengthPrefixedString(memory: WebAssembly.Memory, ptr: number): string {
  if (ptr === 0) return '';

  // Snap buffer once so all reads see a consistent view.
  const buffer = memory.buffer;
  const view = new DataView(buffer);
  const len = view.getUint32(ptr, true); // little-endian

  if (len === 0) return '';
  if (ptr + 4 + len > buffer.byteLength) {
    throw new Error(`Invalid string length: ${len} at ptr ${ptr} (buffer ${buffer.byteLength})`);
  }

  const bytes = new Uint8Array(buffer, ptr + 4, len);
  return new TextDecoder('utf-8').decode(bytes);
}

/**
 * Read a raw string from WASM memory (ptr, len pair)
 * Used when WASM passes ptr and len as separate arguments
 *
 * @param memory - WASM memory instance
 * @param ptr - Pointer to the string data (no length prefix)
 * @param len - Length in bytes
 * @returns Decoded string
 */
export function readRawString(memory: WebAssembly.Memory, ptr: number, len: number): string {
  if (ptr === 0 || len === 0) return '';

  // Snap buffer once so the bounds check and the read use the same backing buffer.
  const buffer = memory.buffer;
  if (ptr + len > buffer.byteLength) {
    throw new Error(`String read out of bounds: ptr=${ptr}, len=${len}, bufferSize=${buffer.byteLength}`);
  }

  const bytes = new Uint8Array(buffer, ptr, len);
  return new TextDecoder('utf-8').decode(bytes);
}

/**
 * Write a length-prefixed string to WASM memory
 * Uses WASM's malloc to allocate memory
 * Format: [4-byte LE length][UTF-8 bytes]
 *
 * @param exports - WASM exports containing malloc and memory
 * @param str - String to write
 * @returns Pointer to the allocated string
 */
export function writeLengthPrefixedString(exports: WasmExports, str: string): number {
  const bytes = new TextEncoder().encode(str);
  const totalSize = 4 + bytes.length;

  const ptr = exports.malloc(totalSize);
  if (ptr === 0) {
    // Compiler ≥ 0.30.321 returns 0 from __malloc when memory.grow fails
    // (MALLOC-IGNORES-MEMORY-GROW-FAILURE). The cause is one of:
    //   - The WASM module's declared maximum memory has been reached.
    //   - The host-configured preGrowMemoryBytes / system limit refused grow.
    //   - The WASM program has an unbounded allocation pattern (e.g. an
    //     infinite loop concatenating strings) that walked past any reasonable
    //     cap.
    const bufferMB = (exports.memory.buffer.byteLength / 1024 / 1024).toFixed(1);
    throw new Error(
      `WASM malloc returned null: need ${totalSize} bytes, buffer is ${bufferMB} MB. ` +
      `Memory cap reached — either raise preGrowMemoryBytes, raise the WASM module's ` +
      `declared maximum, or audit the program for unbounded allocations.`
    );
  }

  // Snap buffer AFTER malloc — malloc may have grown WASM memory, which detaches
  // the previous ArrayBuffer and creates a new one. All writes must use this snapshot.
  const buffer = exports.memory.buffer;
  if (ptr + totalSize > buffer.byteLength) {
    // Defensive guard: pre-0.30.321 compilers (or any other allocator) could
    // return a non-zero pointer past the buffer end. With compiler ≥ 0.30.321
    // this path is unreachable for native __malloc — the null-on-grow-failure
    // contract is enforced upstream. If we hit it, the compiler regressed or a
    // third-party allocator is in use; report the raw bounds rather than
    // guessing at NSR002/SEM002.
    throw new Error(
      `WASM allocator returned out-of-bounds pointer: ptr=${ptr}, need=${totalSize}, ` +
      `buffer=${buffer.byteLength}. The allocator is not honoring the null-on-failure contract.`
    );
  }
  const view = new DataView(buffer);
  view.setUint32(ptr, bytes.length, true); // little-endian length prefix
  new Uint8Array(buffer).set(bytes, ptr + 4);

  bumpHeapPtrPastAllocation(exports, ptr, totalSize);
  return ptr;
}

/**
 * Write raw bytes to WASM memory
 * Uses WASM's malloc to allocate memory
 *
 * @param exports - WASM exports containing malloc and memory
 * @param data - Raw bytes to write
 * @returns Pointer to the allocated data
 */
export function writeRawBytes(exports: WasmExports, data: Uint8Array): number {
  const ptr = exports.malloc(data.length);
  if (ptr === 0) {
    throw new Error('WASM malloc returned null pointer');
  }

  const memoryArray = new Uint8Array(exports.memory.buffer);
  memoryArray.set(data, ptr);

  bumpHeapPtrPastAllocation(exports, ptr, data.length);
  return ptr;
}

/**
 * Read an i32 value from WASM memory
 */
export function readI32(memory: WebAssembly.Memory, ptr: number): number {
  const view = new DataView(memory.buffer);
  return view.getInt32(ptr, true);
}

/**
 * Read an f64 value from WASM memory
 */
export function readF64(memory: WebAssembly.Memory, ptr: number): number {
  const view = new DataView(memory.buffer);
  return view.getFloat64(ptr, true);
}

/**
 * Write an i32 value to WASM memory
 */
export function writeI32(memory: WebAssembly.Memory, ptr: number, value: number): void {
  const view = new DataView(memory.buffer);
  view.setInt32(ptr, value, true);
}

/**
 * Write an f64 value to WASM memory
 */
export function writeF64(memory: WebAssembly.Memory, ptr: number, value: number): void {
  const view = new DataView(memory.buffer);
  view.setFloat64(ptr, value, true);
}

/**
 * Get the size of the string in bytes (UTF-8 encoded)
 */
export function getStringByteLength(str: string): number {
  return new TextEncoder().encode(str).length;
}

/**
 * Pre-grow WASM memory to at least `targetBytes` before the first request.
 *
 * Why: when the WASM bump allocator exhausts the current memory and calls
 * memory.grow() mid-request, the old ArrayBuffer is detached. Any DataView or
 * TypedArray created from the pre-grow buffer raises "Offset is outside the
 * bounds of the DataView" if it is accessed after the grow. Pre-growing at
 * startup ensures all subsequent allocations fit within the initial buffer and
 * memory.grow() is never triggered during request handling.
 *
 * Silently skips if the WASM module declares a max memory smaller than
 * `targetBytes` (grow() would throw; the server continues with available memory).
 */
export function preGrowMemory(
  exports: WasmExports,
  targetBytes: number = DEFAULT_PREGROW_BYTES
): void {
  const currentBytes = exports.memory.buffer.byteLength;
  if (currentBytes >= targetBytes) return;

  const pagesNeeded = Math.ceil((targetBytes - currentBytes) / WASM_PAGE_BYTES);
  try {
    exports.memory.grow(pagesNeeded);
  } catch {
    // Module's declared max memory is below targetBytes — non-fatal.
  }
}

/**
 * Wrap a WASM handler invocation in a per-call memory scope so any heap growth
 * during the call (string concats, malloc-backed buffers, list payloads, etc.)
 * is reclaimed when the call returns.
 *
 * Compiler ≥ 0.30.330 emits `scope_push` (returns the current `__heap_ptr`)
 * and `scope_pop(snapshot)` (rewinds `__heap_ptr` to it). Modules compiled with
 * older compilers don't export these — the body runs unchanged and the bump
 * pointer accumulates, but rotation thresholds (MAX_REQUEST_COUNT,
 * MAX_HEAP_GROWTH_BYTES) still bound total growth at the worker level.
 *
 * `fn` MUST materialize anything the JS host needs to read out of WASM memory
 * (response bodies, list payloads, return values) before returning. Once
 * scope_pop rewinds the bump pointer the WASM addresses inside the scope are
 * reusable and reading them is unsafe.
 *
 * scope_pop is invoked on both the success and error paths — a handler that
 * traps mid-allocation otherwise leaks every byte it allocated before the
 * trap. See NSR-NO-PER-REQUEST-MEMORY-RELEASE.
 */
export function withWasmScope<T>(exports: WasmExports, fn: () => T): T {
  const recordExports = exports as unknown as Record<string, unknown>;
  const scopePush = recordExports.scope_push as (() => number) | undefined;
  const scopePop = recordExports.scope_pop as ((snapshot: number) => void) | undefined;

  if (typeof scopePush !== 'function' || typeof scopePop !== 'function') {
    return fn();
  }

  const snapshot = scopePush();
  try {
    return fn();
  } finally {
    try {
      scopePop(snapshot);
    } catch {
      // scope_pop trap leaves __heap_ptr at its post-handler position; the
      // worker pool's heap-growth threshold rotates the instance separately.
    }
  }
}
