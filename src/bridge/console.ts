import { WasmState } from '../types';
import { readString } from './helpers';

/**
 * Create console bridge functions
 *
 * Provides print functions for WASM modules:
 * - print: Write string without newline
 * - printl: Write string with newline
 * - print_integer: Write integer
 * - print_float: Write float
 * - print_boolean: Write boolean
 */
export function createConsoleBridge(getState: () => WasmState) {
  return {
    /**
     * Print a string without newline
     * @param ptr - Pointer to string data
     * @param len - Length of string in bytes
     */
    print(ptr: number, len: number): void {
      const state = getState();
      const str = readString(state, ptr, len);
      process.stdout.write(str);
    },

    /**
     * Print a string with newline
     * @param ptr - Pointer to string data
     * @param len - Length of string in bytes
     */
    printl(ptr: number, len: number): void {
      const state = getState();
      const str = readString(state, ptr, len);
      console.log(str);
    },

    /**
     * Print an integer value
     * @param value - Integer value to print
     */
    print_integer(value: number): void {
      console.log(Math.floor(value));
    },

    /**
     * Print a float value
     * @param value - Float value to print
     */
    print_float(value: number): void {
      console.log(value);
    },

    /**
     * Print a boolean value
     * @param value - Boolean value (0 = false, non-zero = true)
     */
    print_boolean(value: number): void {
      console.log(value !== 0 ? 'true' : 'false');
    },

    /**
     * Print an error message to stderr
     * @param ptr - Pointer to string data
     * @param len - Length of string in bytes
     */
    print_error(ptr: number, len: number): void {
      const state = getState();
      const str = readString(state, ptr, len);
      process.stderr.write(str + '\n');
    },

    /**
     * Print a debug message (only in verbose mode)
     * @param ptr - Pointer to string data
     * @param len - Length of string in bytes
     */
    print_debug(ptr: number, len: number): void {
      const state = getState();
      if (state.config.verbose) {
        const str = readString(state, ptr, len);
        console.log(`[DEBUG] ${str}`);
      }
    },
  };
}
