import { WasmExports } from '../types';

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

  const view = new DataView(memory.buffer);
  const len = view.getUint32(ptr, true); // little-endian

  if (len === 0) return '';
  if (len > memory.buffer.byteLength - ptr - 4) {
    throw new Error(`Invalid string length: ${len} at ptr ${ptr}`);
  }

  const bytes = new Uint8Array(memory.buffer, ptr + 4, len);
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

  if (ptr + len > memory.buffer.byteLength) {
    throw new Error(`String read out of bounds: ptr=${ptr}, len=${len}, bufferSize=${memory.buffer.byteLength}`);
  }

  const bytes = new Uint8Array(memory.buffer, ptr, len);
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
    throw new Error('WASM malloc returned null pointer');
  }

  const view = new DataView(exports.memory.buffer);
  view.setUint32(ptr, bytes.length, true); // little-endian length prefix

  const memoryArray = new Uint8Array(exports.memory.buffer);
  memoryArray.set(bytes, ptr + 4);

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
