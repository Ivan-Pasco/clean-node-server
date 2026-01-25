import { WasmState } from '../types';
import { readString, writeString } from './helpers';

/**
 * Create input bridge functions
 *
 * These are stubs for input functions in a server context.
 * In a CLI context, these would read from stdin.
 * In a server context, these return default/empty values.
 */
export function createInputBridge(getState: () => WasmState) {
  return {
    /**
     * Read string input (returns empty in server context)
     */
    input(promptPtr: number, promptLen: number): number {
      const state = getState();
      // In server context, return empty string
      return writeString(state, '');
    },

    /**
     * Read integer input (returns 0 in server context)
     */
    input_integer(promptPtr: number, promptLen: number): number {
      // Return 0 as default
      return 0;
    },

    /**
     * Read float input (returns 0.0 in server context)
     */
    input_float(promptPtr: number, promptLen: number): number {
      // Return 0.0 as default
      return 0.0;
    },

    /**
     * Read yes/no input (returns 0/false in server context)
     */
    input_yesno(promptPtr: number, promptLen: number): number {
      // Return 0 (false) as default
      return 0;
    },

    /**
     * Read range input (returns min value in server context)
     */
    input_range(promptPtr: number, promptLen: number, min: number, max: number): number {
      // Return min value as default
      return min;
    },
  };
}
