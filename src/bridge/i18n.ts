/**
 * frame.locale (i18n) bridge — TypeScript port of clean-server/src/locale.rs.
 *
 * Wire bridge functions to the per-instance `LocaleState` carried on
 * `WasmState.locale`. Translation maps load via `_i18n_load` at startup, and
 * the active locale lives in `state.locale.currentLocale` for the duration of
 * each request (the request worker owns one WASM instance and dispatches one
 * request at a time, so a single string equals the Rust task-local cell).
 *
 * Signatures match foundation/platform-architecture/function-registry.toml
 * (category = "locale"). All string returns are length-prefixed WASM
 * allocations via `writeString` per the host bridge convention.
 */
import { WasmState } from '../types';
import {
  formatCurrency,
  formatDate,
  formatNumber,
  parseNumberOptions,
} from '../locale';
import { readString, writeString } from './helpers';

export function createI18nBridge(getState: () => WasmState) {
  return {
    /**
     * `_i18n_load(locale_ptr, locale_len, json_ptr, json_len) -> void`
     *
     * Compiler emits the raw ptr+len convention for string args here.
     * Replaces the translation map for `locale` with the flattened contents.
     */
    _i18n_load(localePtr: number, localeLen: number, jsonPtr: number, jsonLen: number): void {
      const state = getState();
      const locale = readString(state, localePtr, localeLen);
      const json = readString(state, jsonPtr, jsonLen);
      state.locale.loadJson(locale, json);
    },

    /**
     * `_i18n_set_locale(locale_ptr, locale_len) -> void`
     *
     * Sets the active locale on the current instance. Persists until the next
     * call or until the worker is recycled.
     */
    _i18n_set_locale(localePtr: number, localeLen: number): void {
      const state = getState();
      state.locale.currentLocale = readString(state, localePtr, localeLen);
    },

    /**
     * `_i18n_locale() -> ptr` (LP-string)
     */
    _i18n_locale(): number {
      const state = getState();
      return writeString(state, state.locale.currentLocale);
    },

    /**
     * `_i18n_t(key_ptr, key_len, params_ptr, params_len) -> ptr` (LP-string)
     *
     * Translates `key` using the active locale (BCP-47 fallback to primary
     * subtag, then to the default locale). Returns the key verbatim when no
     * translation matches.
     */
    _i18n_t(keyPtr: number, keyLen: number, paramsPtr: number, paramsLen: number): number {
      const state = getState();
      const key = readString(state, keyPtr, keyLen);
      const params = paramsLen > 0 ? readString(state, paramsPtr, paramsLen) : '{}';
      const out = state.locale.translate(key, state.locale.currentLocale, params || '{}');
      return writeString(state, out);
    },

    /**
     * `_i18n_t_count(key_ptr, key_len, count, params_ptr, params_len) -> ptr`
     *
     * `count` is i32 in the registry; JavaScript receives it as a number
     * (WASM i32 → JS number). Pluralization is CLDR-simplified.
     */
    _i18n_t_count(
      keyPtr: number,
      keyLen: number,
      count: number,
      paramsPtr: number,
      paramsLen: number,
    ): number {
      const state = getState();
      const key = readString(state, keyPtr, keyLen);
      const params = paramsLen > 0 ? readString(state, paramsPtr, paramsLen) : '{}';
      const out = state.locale.translateCount(key, count, state.locale.currentLocale, params || '{}');
      return writeString(state, out);
    },

    /**
     * `_i18n_format_number(value: f64, locale_ptr, locale_len, opts_ptr, opts_len) -> ptr`
     */
    _i18n_format_number(
      value: number,
      localePtr: number,
      localeLen: number,
      optsPtr: number,
      optsLen: number,
    ): number {
      const state = getState();
      const locale = localeLen > 0 ? readString(state, localePtr, localeLen) : state.locale.currentLocale;
      const opts = optsLen > 0 ? readString(state, optsPtr, optsLen) : '{}';
      const { decimals, useGrouping } = parseNumberOptions(opts || '{}');
      return writeString(state, formatNumber(value, locale, decimals, useGrouping));
    },

    /**
     * `_i18n_format_currency(value: f64, code_ptr, code_len, locale_ptr, locale_len) -> ptr`
     *
     * Note registry params order: (value, currency_code, locale). The Rust
     * host's `format_currency(value, code, locale)` matches.
     */
    _i18n_format_currency(
      value: number,
      codePtr: number,
      codeLen: number,
      localePtr: number,
      localeLen: number,
    ): number {
      const state = getState();
      const code = readString(state, codePtr, codeLen);
      const locale = localeLen > 0 ? readString(state, localePtr, localeLen) : state.locale.currentLocale;
      return writeString(state, formatCurrency(value, code, locale));
    },

    /**
     * `_i18n_format_date(epoch_ms: f64, style_ptr, style_len, locale_ptr, locale_len) -> ptr`
     *
     * Registry documents the value as Unix epoch milliseconds. Internally
     * `formatDate` works in seconds (matching the Rust host's `format_date`
     * signature), so convert at the bridge boundary.
     */
    _i18n_format_date(
      epochMs: number,
      stylePtr: number,
      styleLen: number,
      localePtr: number,
      localeLen: number,
    ): number {
      const state = getState();
      const style = styleLen > 0 ? readString(state, stylePtr, styleLen) : 'medium';
      const locale = localeLen > 0 ? readString(state, localePtr, localeLen) : state.locale.currentLocale;
      const seconds = epochMs / 1000;
      return writeString(state, formatDate(seconds, style, locale));
    },
  };
}
