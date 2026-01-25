import { WasmState } from '../types';
import {
  readRawString,
  readLengthPrefixedString,
  writeLengthPrefixedString,
} from '../wasm/memory';

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
 * Logging helper for verbose mode
 */
export function log(state: WasmState, category: string, message: string, data?: unknown): void {
  if (state.config.verbose) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [${category}] ${message}`, data ? JSON.stringify(data) : '');
  }
}
