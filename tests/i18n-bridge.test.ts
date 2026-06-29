/**
 * i18n bridge integration tests.
 *
 * Exercises createI18nBridge against a minimal WasmState backed by a real
 * WebAssembly.Memory + bump allocator. Verifies the bridge reads ptr/len
 * arguments and returns LP-encoded string pointers callers can decode.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createI18nBridge } from '../src/bridge/i18n';
import { LocaleState } from '../src/locale';
import { readLengthPrefixedString } from '../src/wasm/memory';
import type { WasmState } from '../src/types';

function writeLPAt(memory: WebAssembly.Memory, ptr: number, str: string): number {
  const bytes = new TextEncoder().encode(str);
  const view = new DataView(memory.buffer);
  view.setUint32(ptr, bytes.length, true);
  new Uint8Array(memory.buffer).set(bytes, ptr + 4);
  return ptr + 4 + bytes.length;
}

function writeRawAt(memory: WebAssembly.Memory, ptr: number, str: string): { ptr: number; len: number } {
  const bytes = new TextEncoder().encode(str);
  new Uint8Array(memory.buffer).set(bytes, ptr);
  return { ptr, len: bytes.length };
}

function makeState(memory: WebAssembly.Memory, heapStart: number, locale = new LocaleState('en')): WasmState {
  let heapPtr = heapStart;
  const exports = {
    memory,
    malloc: (size: number): number => {
      const ptr = heapPtr;
      heapPtr += size + 4;
      return ptr;
    },
  } as unknown as WasmState['exports'];
  return { exports, locale } as unknown as WasmState;
}

describe('i18n bridge', () => {
  let memory: WebAssembly.Memory;
  const HEAP_START = 4096;

  beforeEach(() => {
    memory = new WebAssembly.Memory({ initial: 2 });
  });

  it('_i18n_load + _i18n_t round-trips a translation', () => {
    const state = makeState(memory, HEAP_START);
    const bridge = createI18nBridge(() => state);
    const locale = writeRawAt(memory, 8,'en');
    const json = writeRawAt(memory, 16, JSON.stringify({ greeting: 'Hello, {name}!' }));
    bridge._i18n_load(locale.ptr, locale.len, json.ptr, json.len);

    const key = writeRawAt(memory, 256, 'greeting');
    const params = writeRawAt(memory, 384, JSON.stringify({ name: 'Alice' }));
    const ptr = bridge._i18n_t(key.ptr, key.len, params.ptr, params.len);
    expect(readLengthPrefixedString(memory, ptr)).toBe('Hello, Alice!');
  });

  it('_i18n_t returns the key verbatim on miss', () => {
    const state = makeState(memory, HEAP_START);
    const bridge = createI18nBridge(() => state);
    const key = writeRawAt(memory, 8,'missing.key');
    const ptr = bridge._i18n_t(key.ptr, key.len, 0, 0);
    expect(readLengthPrefixedString(memory, ptr)).toBe('missing.key');
  });

  it('_i18n_set_locale + _i18n_locale round-trip', () => {
    const state = makeState(memory, HEAP_START);
    const bridge = createI18nBridge(() => state);
    expect(readLengthPrefixedString(memory, bridge._i18n_locale())).toBe('en');
    const fr = writeRawAt(memory, 8,'fr-CA');
    bridge._i18n_set_locale(fr.ptr, fr.len);
    expect(state.locale.currentLocale).toBe('fr-CA');
    expect(readLengthPrefixedString(memory, bridge._i18n_locale())).toBe('fr-CA');
  });

  it('falls back to the default locale when the active locale has no entry', () => {
    const state = makeState(memory, HEAP_START);
    const bridge = createI18nBridge(() => state);
    const locale = writeRawAt(memory, 8,'en');
    const json = writeRawAt(memory, 16, JSON.stringify({ save: 'Save' }));
    bridge._i18n_load(locale.ptr, locale.len, json.ptr, json.len);

    const fr = writeRawAt(memory, 256, 'fr');
    bridge._i18n_set_locale(fr.ptr, fr.len);
    const key = writeRawAt(memory, 384, 'save');
    const ptr = bridge._i18n_t(key.ptr, key.len, 0, 0);
    expect(readLengthPrefixedString(memory, ptr)).toBe('Save');
  });

  it('_i18n_t_count selects the correct plural form for English', () => {
    const state = makeState(memory, HEAP_START);
    const bridge = createI18nBridge(() => state);
    const locale = writeRawAt(memory, 8,'en');
    const json = writeRawAt(
      memory,
      16,
      JSON.stringify({
        users_zero: 'No users',
        users_one: 'One user',
        users_other: '{count} users',
      }),
    );
    bridge._i18n_load(locale.ptr, locale.len, json.ptr, json.len);

    const key = writeRawAt(memory, 512, 'users');
    expect(readLengthPrefixedString(memory, bridge._i18n_t_count(key.ptr, key.len, 0, 0, 0))).toBe(
      'No users',
    );
    expect(readLengthPrefixedString(memory, bridge._i18n_t_count(key.ptr, key.len, 1, 0, 0))).toBe(
      'One user',
    );
    expect(readLengthPrefixedString(memory, bridge._i18n_t_count(key.ptr, key.len, 5, 0, 0))).toBe(
      '5 users',
    );
  });

  it('_i18n_format_number respects locale + options', () => {
    const state = makeState(memory, HEAP_START);
    const bridge = createI18nBridge(() => state);
    const locale = writeRawAt(memory, 8,'de');
    const opts = writeRawAt(memory, 16, '{}');
    const ptr = bridge._i18n_format_number(1299.99, locale.ptr, locale.len, opts.ptr, opts.len);
    expect(readLengthPrefixedString(memory, ptr)).toBe('1.299,99');
  });

  it('_i18n_format_currency formats USD in en-US', () => {
    const state = makeState(memory, HEAP_START);
    const bridge = createI18nBridge(() => state);
    const code = writeRawAt(memory, 8,'USD');
    const locale = writeRawAt(memory, 16, 'en-US');
    const ptr = bridge._i18n_format_currency(1299.99, code.ptr, code.len, locale.ptr, locale.len);
    expect(readLengthPrefixedString(memory, ptr)).toBe('$1,299.99');
  });

  it('_i18n_format_date takes epoch ms and formats per style', () => {
    const state = makeState(memory, HEAP_START);
    const bridge = createI18nBridge(() => state);
    const style = writeRawAt(memory, 8,'medium');
    const locale = writeRawAt(memory, 16, 'en-US');
    // 2026-01-01 00:00:00 UTC
    const ptr = bridge._i18n_format_date(
      1767225600000,
      style.ptr,
      style.len,
      locale.ptr,
      locale.len,
    );
    expect(readLengthPrefixedString(memory, ptr)).toBe('Jan 1, 2026');
  });
});
