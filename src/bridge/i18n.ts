/**
 * frame.locale (i18n) bridge — node-server stubs.
 *
 * The frame.locale runtime is implemented in clean-server (Rust) at
 * clean-server/src/locale.rs (~963 lines: translation maps, BCP 47
 * task-local state, CLDR plural form selection, locale-aware number /
 * currency / date formatting).
 *
 * Porting the full implementation to TypeScript is tracked in
 * foundation/management/cross-component-prompts/
 *   all-host-bridge-parity-enforcement.md (Step 4 — node-server i18n).
 *
 * Until then, these stubs satisfy the WASM linker contract (every
 * registered import has a matching callable) but throw on any actual
 * call, so apps using i18n on node-server fail loudly with a clear
 * message instead of crashing in WASM linking or returning silently
 * wrong values.
 *
 * Signature reference: foundation/platform-architecture/function-registry.toml
 * (entries with category = "locale").
 */
import { WasmState } from '../types';
import { writeString } from './helpers';

const NOT_IMPLEMENTED =
  'frame.locale is not yet implemented on clean-node-server. ' +
  'See foundation/management/cross-component-prompts/' +
  'all-host-bridge-parity-enforcement.md for status.';

function notImplemented(fn: string): never {
  throw new Error(`${fn}: ${NOT_IMPLEMENTED}`);
}

export function createI18nBridge(getState: () => WasmState) {
  return {
    // _i18n_load(locale: string, json: string) -> void
    _i18n_load(_localePtr: number, _jsonPtr: number): void {
      notImplemented('_i18n_load');
    },

    // _i18n_set_locale(locale: string) -> void
    _i18n_set_locale(_localePtr: number): void {
      notImplemented('_i18n_set_locale');
    },

    // _i18n_locale() -> ptr (LP-string)
    _i18n_locale(): number {
      notImplemented('_i18n_locale');
    },

    // _i18n_t(key: string, params_json: string) -> ptr (LP-string)
    _i18n_t(_keyPtr: number, _paramsPtr: number): number {
      notImplemented('_i18n_t');
    },

    // _i18n_t_count(key: string, count: i64, params_json: string) -> ptr
    _i18n_t_count(_keyPtr: number, _count: bigint, _paramsPtr: number): number {
      notImplemented('_i18n_t_count');
    },

    // _i18n_format_number(value: f64, locale: string, opts_json: string) -> ptr
    _i18n_format_number(_value: number, _localePtr: number, _optsPtr: number): number {
      notImplemented('_i18n_format_number');
    },

    // _i18n_format_currency(value: f64, locale: string, opts_json: string) -> ptr
    _i18n_format_currency(_value: number, _localePtr: number, _optsPtr: number): number {
      notImplemented('_i18n_format_currency');
    },

    // _i18n_format_date(epoch_ms: f64, locale: string, opts_json: string) -> ptr
    _i18n_format_date(_epoch: number, _localePtr: number, _optsPtr: number): number {
      notImplemented('_i18n_format_date');
    },
  };
}
