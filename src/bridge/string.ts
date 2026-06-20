import { WasmState } from '../types';
import { readString, readPrefixedString, writeString } from './helpers';

/**
 * Concatenate two length-prefixed strings at the BYTE level.
 *
 * NSR002: the compiler emits byte-position substring inline (e.g. for
 * `s.substring(i, i + 1)`), so when WASM code iterates a string in a
 * `i = 0; while i < s.length(): i = i + 1` loop and the string contains
 * multibyte UTF-8 (em-dash E2 80 94, arrow E2 86 92, CJK, emoji), each
 * iteration produces a length-prefixed fragment containing a single
 * continuation byte. Decoding [E2] alone as UTF-8 yields U+FFFD, decoding
 * [80] alone yields another U+FFFD, etc. The previous string_concat read
 * each input through TextDecoder before JS-concatenating, so every
 * multibyte char emerged from the loop as three U+FFFD characters — visible
 * on production cleanlanguage.dev /tutorials as 38 replacement chars and a
 * truncated body where the byte/char-count mismatch broke downstream loops.
 *
 * Byte-level concat reassembles the fragments into a valid UTF-8 sequence
 * BEFORE any decoding happens, so the final state.response.body decode at
 * the response boundary sees clean UTF-8. Rust clean-server's bridge has the
 * same property because Rust's Vec<u8> path never invokes a string decoder
 * mid-concat — this brings node-server into parity with it.
 *
 * Ownership: the returned pointer is ALWAYS a fresh allocation (except when
 * both inputs are empty, which returns the 0-pointer empty marker). The
 * 0.1.63 version of this function returned one of the input pointers
 * verbatim when the other was empty as a malloc-saving optimization; that
 * aliased the input into the result and crashed prod /tutorials with a
 * deterministic "memory access out of bounds" WASM trap on the 30-card
 * render loop, because the compiler-emitted accumulator pattern reuses /
 * recycles its inputs after a concat call. Rust clean-server's bridge also
 * always allocates a fresh Vec<u8>, so this brings node-server into parity.
 */
function concatLengthPrefixed(state: WasmState, lpA: number, lpB: number): number {
  const memory = state.exports.memory;

  let lenA = 0;
  let lenB = 0;
  if (lpA !== 0) {
    lenA = new DataView(memory.buffer).getUint32(lpA, true);
  }
  if (lpB !== 0) {
    lenB = new DataView(memory.buffer).getUint32(lpB, true);
  }
  if (lenA === 0 && lenB === 0) return 0;

  const totalLen = lenA + lenB;
  const ptr = state.exports.malloc(4 + totalLen);
  if (ptr === 0) {
    const bufferMB = (memory.buffer.byteLength / 1024 / 1024).toFixed(1);
    throw new Error(
      `WASM malloc returned null in string.concat: need ${4 + totalLen} bytes, ` +
      `buffer is ${bufferMB} MB.`,
    );
  }

  // Snap buffer AFTER malloc — malloc may have grown WASM memory, which detaches
  // the previous ArrayBuffer. All reads + writes from here use this snapshot.
  const buffer = memory.buffer;
  const bytes = new Uint8Array(buffer);
  new DataView(buffer).setUint32(ptr, totalLen, true);
  if (lenA > 0) bytes.copyWithin(ptr + 4, lpA + 4, lpA + 4 + lenA);
  if (lenB > 0) bytes.copyWithin(ptr + 4 + lenA, lpB + 4, lpB + 4 + lenB);
  return ptr;
}

/**
 * Create string bridge functions
 *
 * Provides string manipulation operations for WASM modules.
 */
export function createStringBridge(getState: () => WasmState) {
  return {
    /**
     * Concatenate two strings.
     * ABI: LP-pointer convention — WASM calls this directly with one i32 per string
     * (a pointer to [4-byte LE length][UTF-8 content]). No compiler wrapper unpacks
     * these into ptr+len pairs, so do NOT use (ptr, len, ptr, len) signatures here.
     *
     * NSR002: this is byte-level concatenation. The previous decode-via-TextDecoder
     * round-trip mangled multibyte UTF-8 fragments emitted by the compiler's
     * byte-position substring. See concatLengthPrefixed above for the full
     * write-up.
     */
    'string.concat'(lpA: number, lpB: number): number {
      return concatLengthPrefixed(getState(), lpA, lpB);
    },

    string_concat(lpA: number, lpB: number): number {
      return concatLengthPrefixed(getState(), lpA, lpB);
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
    // LP-pointer convention: one i32 LP-pointer per argument (no compiler wrapper)
    string_replace(lpSubject: number, lpPattern: number, lpReplacement: number): number {
      const state = getState();
      const str = readPrefixedString(state, lpSubject);
      const pattern = readPrefixedString(state, lpPattern);
      const replacement = readPrefixedString(state, lpReplacement);
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
     * Split string by delimiter — returns a Clean Language list<string> pointer.
     *
     * Layout consumed by the compiler's iterate codegen (HOST_BRIDGE_STRING_SPLIT):
     *   [0..4]   length    (u32 LE)
     *   [4..8]   capacity  (u32 LE)
     *   [8..12]  type_id   (u32 LE, 3 = string — informational)
     *   [12..16] padding
     *   [16+i*4] LP-string pointer for element i
     *
     * Returning a JSON-encoded LP string here would break `iterate part in parts`:
     * the loop reads size from offset 0, so it would consume the JSON byte length
     * (e.g. 17 for `["a","b","c","d"]`) and walk garbage off the end of the JSON.
     */
    // LP-pointer convention: one i32 LP-pointer per argument (no compiler wrapper)
    string_split(lpStr: number, lpDelim: number): number {
      const state = getState();
      const str = readPrefixedString(state, lpStr);
      const delim = readPrefixedString(state, lpDelim);
      const parts = str.split(delim);

      const elementPtrs = parts.map((p) => writeString(state, p));

      const HEADER_SIZE = 16;
      const ELEM_SIZE = 4;
      const listSize = HEADER_SIZE + parts.length * ELEM_SIZE;
      const listPtr = state.exports.malloc(listSize);
      if (listPtr === 0) {
        throw new Error(
          `string_split: malloc returned null for ${listSize}-byte list block`
        );
      }

      // Re-snap memory after malloc — it may have grown and detached the prior buffer.
      const view = new DataView(state.exports.memory.buffer);
      view.setUint32(listPtr, parts.length, true);
      view.setUint32(listPtr + 4, parts.length, true);
      view.setUint32(listPtr + 8, 3, true);
      view.setUint32(listPtr + 12, 0, true);
      for (let i = 0; i < elementPtrs.length; i++) {
        view.setUint32(listPtr + HEADER_SIZE + i * ELEM_SIZE, elementPtrs[i], true);
      }
      return listPtr;
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
    // LP-pointer convention: one i32 LP-pointer per argument (no compiler wrapper).
    // Returns 0 for equal, 1 for different — compiler codegen uses i32.eqz after this call.
    string_compare(lpA: number, lpB: number): number {
      const state = getState();
      return readPrefixedString(state, lpA) === readPrefixedString(state, lpB) ? 0 : 1;
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

    _html_escape(ptr: number, len: number): number {
      const state = getState();
      const str = readString(state, ptr, len);
      const escaped = str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
      return writeString(state, escaped);
    },

    _html_raw(ptr: number, len: number): number {
      const state = getState();
      return writeString(state, readString(state, ptr, len));
    },

    // Compile-time pattern IDs: 0=email 1=url 2=uuid 3=phone 4=date 5=integer 6=number 7=alphanumeric
    string_matches(ptr: number, len: number, patternId: number): number {
      const state = getState();
      const str = readString(state, ptr, len);
      const patterns: RegExp[] = [
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
        /^https?:\/\/[^\s$.?#].[^\s]*$/i,
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
        /^\+?[\d\s\-(). ]{7,}$/,
        /^\d{4}-\d{2}-\d{2}$/,
        /^-?\d+$/,
        /^-?\d+(\.\d+)?$/,
        /^[a-zA-Z0-9]+$/,
      ];
      const pattern = patterns[patternId];
      return pattern !== undefined && pattern.test(str) ? 1 : 0;
    },
  };
}
