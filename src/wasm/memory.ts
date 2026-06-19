import { WasmExports } from '../types';

const WASM_PAGE_BYTES = 65_536;
const DEFAULT_PREGROW_BYTES = 16 * 1024 * 1024; // 16 MB

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
