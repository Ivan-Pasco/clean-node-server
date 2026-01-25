import { WasmState } from '../types';
import { readString, writeString } from './helpers';

/**
 * Create string bridge functions
 *
 * Provides string manipulation operations for WASM modules.
 */
export function createStringBridge(getState: () => WasmState) {
  return {
    /**
     * Concatenate two strings
     */
    string_concat(
      ptr1: number,
      len1: number,
      ptr2: number,
      len2: number
    ): number {
      const state = getState();
      const str1 = readString(state, ptr1, len1);
      const str2 = readString(state, ptr2, len2);
      return writeString(state, str1 + str2);
    },

    /**
     * Get substring
     */
    string_substring(
      ptr: number,
      len: number,
      start: number,
      end: number
    ): number {
      const state = getState();
      const str = readString(state, ptr, len);
      return writeString(state, str.substring(start, end));
    },

    /**
     * Get string length (in characters, not bytes)
     */
    string_length(ptr: number, len: number): number {
      const state = getState();
      const str = readString(state, ptr, len);
      return str.length;
    },

    /**
     * Trim whitespace from both ends
     */
    string_trim(ptr: number, len: number): number {
      const state = getState();
      const str = readString(state, ptr, len);
      return writeString(state, str.trim());
    },

    /**
     * Trim whitespace from start
     */
    string_trim_start(ptr: number, len: number): number {
      const state = getState();
      const str = readString(state, ptr, len);
      return writeString(state, str.trimStart());
    },

    /**
     * Trim whitespace from end
     */
    string_trim_end(ptr: number, len: number): number {
      const state = getState();
      const str = readString(state, ptr, len);
      return writeString(state, str.trimEnd());
    },

    /**
     * Convert to uppercase
     */
    string_to_upper(ptr: number, len: number): number {
      const state = getState();
      const str = readString(state, ptr, len);
      return writeString(state, str.toUpperCase());
    },

    /**
     * Convert to lowercase
     */
    string_to_lower(ptr: number, len: number): number {
      const state = getState();
      const str = readString(state, ptr, len);
      return writeString(state, str.toLowerCase());
    },

    /**
     * Replace all occurrences of a pattern
     */
    string_replace(
      ptr: number,
      len: number,
      patternPtr: number,
      patternLen: number,
      replacementPtr: number,
      replacementLen: number
    ): number {
      const state = getState();
      const str = readString(state, ptr, len);
      const pattern = readString(state, patternPtr, patternLen);
      const replacement = readString(state, replacementPtr, replacementLen);
      return writeString(state, str.split(pattern).join(replacement));
    },

    /**
     * Replace first occurrence of a pattern
     */
    string_replace_first(
      ptr: number,
      len: number,
      patternPtr: number,
      patternLen: number,
      replacementPtr: number,
      replacementLen: number
    ): number {
      const state = getState();
      const str = readString(state, ptr, len);
      const pattern = readString(state, patternPtr, patternLen);
      const replacement = readString(state, replacementPtr, replacementLen);
      return writeString(state, str.replace(pattern, replacement));
    },

    /**
     * Split string by delimiter (returns JSON array)
     */
    string_split(
      ptr: number,
      len: number,
      delimPtr: number,
      delimLen: number
    ): number {
      const state = getState();
      const str = readString(state, ptr, len);
      const delim = readString(state, delimPtr, delimLen);
      const parts = str.split(delim);
      return writeString(state, JSON.stringify(parts));
    },

    /**
     * Join array of strings (input is JSON array)
     */
    string_join(
      ptr: number,
      len: number,
      delimPtr: number,
      delimLen: number
    ): number {
      const state = getState();
      const jsonArray = readString(state, ptr, len);
      const delim = readString(state, delimPtr, delimLen);
      try {
        const parts = JSON.parse(jsonArray) as string[];
        return writeString(state, parts.join(delim));
      } catch {
        return writeString(state, '');
      }
    },

    /**
     * Find index of substring (-1 if not found)
     */
    string_index_of(
      ptr: number,
      len: number,
      searchPtr: number,
      searchLen: number
    ): number {
      const state = getState();
      const str = readString(state, ptr, len);
      const search = readString(state, searchPtr, searchLen);
      return str.indexOf(search);
    },

    /**
     * Find last index of substring (-1 if not found)
     */
    string_last_index_of(
      ptr: number,
      len: number,
      searchPtr: number,
      searchLen: number
    ): number {
      const state = getState();
      const str = readString(state, ptr, len);
      const search = readString(state, searchPtr, searchLen);
      return str.lastIndexOf(search);
    },

    /**
     * Check if string starts with prefix
     */
    string_starts_with(
      ptr: number,
      len: number,
      prefixPtr: number,
      prefixLen: number
    ): number {
      const state = getState();
      const str = readString(state, ptr, len);
      const prefix = readString(state, prefixPtr, prefixLen);
      return str.startsWith(prefix) ? 1 : 0;
    },

    /**
     * Check if string ends with suffix
     */
    string_ends_with(
      ptr: number,
      len: number,
      suffixPtr: number,
      suffixLen: number
    ): number {
      const state = getState();
      const str = readString(state, ptr, len);
      const suffix = readString(state, suffixPtr, suffixLen);
      return str.endsWith(suffix) ? 1 : 0;
    },

    /**
     * Check if string contains substring
     */
    string_contains(
      ptr: number,
      len: number,
      searchPtr: number,
      searchLen: number
    ): number {
      const state = getState();
      const str = readString(state, ptr, len);
      const search = readString(state, searchPtr, searchLen);
      return str.includes(search) ? 1 : 0;
    },

    /**
     * Get character at index
     */
    string_char_at(ptr: number, len: number, index: number): number {
      const state = getState();
      const str = readString(state, ptr, len);
      if (index < 0 || index >= str.length) {
        return writeString(state, '');
      }
      return writeString(state, str.charAt(index));
    },

    /**
     * Get character code at index
     */
    string_char_code_at(ptr: number, len: number, index: number): number {
      const state = getState();
      const str = readString(state, ptr, len);
      if (index < 0 || index >= str.length) {
        return -1;
      }
      return str.charCodeAt(index);
    },

    /**
     * Create string from character code
     */
    string_from_char_code(code: number): number {
      const state = getState();
      return writeString(state, String.fromCharCode(code));
    },

    /**
     * Repeat string n times
     */
    string_repeat(ptr: number, len: number, count: number): number {
      const state = getState();
      const str = readString(state, ptr, len);
      if (count < 0) {
        return writeString(state, '');
      }
      return writeString(state, str.repeat(count));
    },

    /**
     * Pad string at start
     */
    string_pad_start(
      ptr: number,
      len: number,
      targetLength: number,
      padPtr: number,
      padLen: number
    ): number {
      const state = getState();
      const str = readString(state, ptr, len);
      const padStr = readString(state, padPtr, padLen);
      return writeString(state, str.padStart(targetLength, padStr));
    },

    /**
     * Pad string at end
     */
    string_pad_end(
      ptr: number,
      len: number,
      targetLength: number,
      padPtr: number,
      padLen: number
    ): number {
      const state = getState();
      const str = readString(state, ptr, len);
      const padStr = readString(state, padPtr, padLen);
      return writeString(state, str.padEnd(targetLength, padStr));
    },

    /**
     * Reverse string
     */
    string_reverse(ptr: number, len: number): number {
      const state = getState();
      const str = readString(state, ptr, len);
      return writeString(state, [...str].reverse().join(''));
    },

    // Type conversion functions

    /**
     * Convert integer to string
     */
    int_to_string(value: number): number {
      const state = getState();
      return writeString(state, Math.floor(value).toString());
    },

    /**
     * Convert float to string
     */
    float_to_string(value: number): number {
      const state = getState();
      return writeString(state, value.toString());
    },

    /**
     * Convert float to string with fixed decimal places
     */
    float_to_string_fixed(value: number, decimals: number): number {
      const state = getState();
      return writeString(state, value.toFixed(decimals));
    },

    /**
     * Convert boolean to string
     */
    bool_to_string(value: number): number {
      const state = getState();
      return writeString(state, value !== 0 ? 'true' : 'false');
    },

    /**
     * Parse string to integer
     */
    string_to_int(ptr: number, len: number): number {
      const state = getState();
      const str = readString(state, ptr, len);
      const result = parseInt(str, 10);
      return Number.isNaN(result) ? 0 : result;
    },

    /**
     * Parse string to float
     */
    string_to_float(ptr: number, len: number): number {
      const state = getState();
      const str = readString(state, ptr, len);
      const result = parseFloat(str);
      return Number.isNaN(result) ? 0.0 : result;
    },

    /**
     * Parse string to boolean
     */
    string_to_bool(ptr: number, len: number): number {
      const state = getState();
      const str = readString(state, ptr, len).toLowerCase().trim();
      return str === 'true' || str === '1' || str === 'yes' ? 1 : 0;
    },

    /**
     * Compare two strings (returns -1, 0, or 1)
     */
    string_compare(
      ptr1: number,
      len1: number,
      ptr2: number,
      len2: number
    ): number {
      const state = getState();
      const str1 = readString(state, ptr1, len1);
      const str2 = readString(state, ptr2, len2);
      return str1.localeCompare(str2);
    },

    /**
     * Check if two strings are equal
     */
    string_equals(
      ptr1: number,
      len1: number,
      ptr2: number,
      len2: number
    ): number {
      const state = getState();
      const str1 = readString(state, ptr1, len1);
      const str2 = readString(state, ptr2, len2);
      return str1 === str2 ? 1 : 0;
    },

    /**
     * Check if two strings are equal (case insensitive)
     */
    string_equals_ignore_case(
      ptr1: number,
      len1: number,
      ptr2: number,
      len2: number
    ): number {
      const state = getState();
      const str1 = readString(state, ptr1, len1).toLowerCase();
      const str2 = readString(state, ptr2, len2).toLowerCase();
      return str1 === str2 ? 1 : 0;
    },

    /**
     * Check if string is empty
     */
    string_is_empty(ptr: number, len: number): number {
      const state = getState();
      const str = readString(state, ptr, len);
      return str.length === 0 ? 1 : 0;
    },

    /**
     * Check if string is blank (empty or whitespace only)
     */
    string_is_blank(ptr: number, len: number): number {
      const state = getState();
      const str = readString(state, ptr, len);
      return str.trim().length === 0 ? 1 : 0;
    },
  };
}
