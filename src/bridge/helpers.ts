import { WasmState } from '../types';
import {
  readRawString,
  readLengthPrefixedString,
  writeLengthPrefixedString,
  writeLengthPrefixedBytes,
  bumpHeapPtr,
} from '../wasm/memory';

/**
 * Boxed-Any layout emitted by the compiler's `emit_box_any` (see
 * clean-language-compiler/src/codegen/mir_codegen/instructions.rs::emit_box_value):
 *   [tag@0: i32] [value1@4: i32] [value2@8: i32]
 * Total size 12 bytes. See AnyTypeTag in mir_types.rs for tag values.
 */
export const ANY_STRUCT_SIZE = 12;
export const ANY_TAG_NULL = 0;
export const ANY_TAG_INTEGER = 1;
export const ANY_TAG_BOOLEAN = 2;
export const ANY_TAG_NUMBER = 3;
export const ANY_TAG_STRING = 4;
export const ANY_TAG_LIST = 5;
export const ANY_TAG_OBJECT = 6;

/**
 * Helper to read a string from WASM memory using ptr and len
 * This is the common pattern for bridge function arguments
 */
export function readString(state: WasmState, ptr: number, len: number): string {
  return readRawString(state.exports.memory, ptr, len);
}

/**
 * Helper to read a length-prefixed string from WASM memory
 * Used when WASM returns a pointer to a length-prefixed string
 */
export function readPrefixedString(state: WasmState, ptr: number): string {
  return readLengthPrefixedString(state.exports.memory, ptr);
}

/**
 * Helper to write a string to WASM memory (length-prefixed)
 * Returns the pointer to the allocated string
 */
export function writeString(state: WasmState, str: string): number {
  return writeLengthPrefixedString(state.exports, str);
}

/**
 * Helper to write a raw byte sequence to WASM memory in the length-prefixed
 * layout Clean code uses for strings. The bytes are stored verbatim — no
 * UTF-8 encoding step — so binary payloads survive the round-trip intact.
 */
export function writeBytes(state: WasmState, data: Uint8Array): number {
  return writeLengthPrefixedBytes(state.exports, data);
}

/**
 * Helper to write a JSON response to WASM memory
 * Wraps data in the standard envelope format
 */
export function writeJsonResponse<T>(state: WasmState, data: T): number {
  const json = JSON.stringify({ ok: true, data });
  return writeString(state, json);
}

/**
 * Helper to write an error response to WASM memory
 */
export function writeErrorResponse(
  state: WasmState,
  code: string,
  message: string,
  details?: Record<string, unknown>
): number {
  const json = JSON.stringify({
    ok: false,
    err: { code, message, details },
  });
  return writeString(state, json);
}

/**
 * Parse JSON from a string read from WASM memory
 */
export function parseJson<T>(state: WasmState, ptr: number, len: number): T | null {
  try {
    const str = readString(state, ptr, len);
    return JSON.parse(str) as T;
  } catch {
    return null;
  }
}

/**
 * Create a bridge function wrapper that handles common patterns
 * - Reads string arguments from WASM memory
 * - Writes string results back to WASM memory
 */
export function createStringBridge(
  getState: () => WasmState,
  fn: (state: WasmState, ...args: string[]) => string | number
): (...args: number[]) => number {
  return (...ptrLenPairs: number[]) => {
    const state = getState();
    const args: string[] = [];

    // Process pairs of (ptr, len) arguments
    for (let i = 0; i < ptrLenPairs.length; i += 2) {
      const ptr = ptrLenPairs[i];
      const len = ptrLenPairs[i + 1];
      args.push(readString(state, ptr, len));
    }

    const result = fn(state, ...args);

    if (typeof result === 'string') {
      return writeString(state, result);
    }
    return result;
  };
}

/**
 * Read the underlying string value from a boxed-Any pointer.
 *
 * The compiler's stdlib `json.get(any, string) -> any` boxes its first
 * argument (typically a raw SQL result string or an already-boxed JSON) via
 * `emit_box_any` before invoking the bridge, so `anyPtr` points to the 12-byte
 * struct laid out as `[tag@0][value1@4][value2@8]`.
 *
 * Supported tag paths for `_json_get`'s first argument:
 *   - String (4): value1 is an LP-string pointer, read it.
 *   - Null   (0): treat as empty string.
 *
 * Other tags fall through to `String(value1)` — this is defensive; the
 * compiler is expected to only box String / Object here (Object gets JSON-
 * encoded upstream, at which point it flows through the String path).
 */
export function readAnyAsString(state: WasmState, anyPtr: number): string {
  if (anyPtr === 0) return '';
  const view = new DataView(state.exports.memory.buffer);
  const tag = view.getUint32(anyPtr, true);
  if (tag === ANY_TAG_NULL) return '';
  if (tag === ANY_TAG_STRING) {
    const lpPtr = view.getUint32(anyPtr + 4, true);
    return readLengthPrefixedString(state.exports.memory, lpPtr);
  }
  // Defensive fallback: read value1 as an LP-string pointer even for other tags.
  // The compiler currently boxes json.get's first argument as String; if it
  // ever emits a different tag, treating value1 as an LP-ptr will either read
  // the correct bytes or trap in readLengthPrefixedString with a diagnosis.
  const lpPtr = view.getUint32(anyPtr + 4, true);
  return readLengthPrefixedString(state.exports.memory, lpPtr);
}

/**
 * Allocate a fresh 12-byte boxed-Any struct with tag=String and value1 pointing
 * at an LP-string of `str`. Returns the pointer to the struct.
 *
 * Two allocations happen: one for the LP-string (via `writeString`), one for
 * the Any envelope (via `malloc`). Both must bump `__heap_ptr` past their end
 * so the next allocator call (WASM-side or bridge-side) doesn't overlap them —
 * same guard applied by all other multi-allocation bridge helpers
 * (concatLengthPrefixed, string_split, mem_alloc).
 */
export function boxStringAsAny(state: WasmState, str: string): number {
  const lpPtr = writeLengthPrefixedString(state.exports, str);
  const anyPtr = state.exports.malloc(ANY_STRUCT_SIZE);
  if (anyPtr === 0) {
    const bufferMB = (state.exports.memory.buffer.byteLength / 1024 / 1024).toFixed(1);
    throw new Error(
      `WASM malloc returned null in boxStringAsAny: need ${ANY_STRUCT_SIZE} bytes, ` +
      `buffer is ${bufferMB} MB.`,
    );
  }
  // Snap buffer AFTER malloc — malloc may have grown WASM memory and detached
  // the previous ArrayBuffer.
  const view = new DataView(state.exports.memory.buffer);
  view.setUint32(anyPtr, ANY_TAG_STRING, true);
  view.setUint32(anyPtr + 4, lpPtr, true);
  view.setUint32(anyPtr + 8, 0, true);
  bumpHeapPtr(state.exports, anyPtr, ANY_STRUCT_SIZE);
  return anyPtr;
}

/**
 * Logging helper for verbose mode
 */
export function log(state: WasmState, category: string, message: string, data?: unknown): void {
  if (state.config.verbose) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [${category}] ${message}`, data ? JSON.stringify(data) : '');
  }
}
