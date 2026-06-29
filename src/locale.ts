/**
 * Internationalization (i18n) runtime for frame.locale — TypeScript port of
 * clean-server/src/locale.rs. Mirrors the Rust host's observable behavior so
 * apps using `t()`, `tc()`, and locale-aware formatters produce identical
 * output on either runtime.
 *
 * Scope: the subset frame.locale actually drives — translation lookup with
 * BCP-47 fallback, CLDR-simplified plural categories, locale-aware number,
 * currency, and date formatting for the ~30 locales the Rust host covers.
 *
 * Per-instance locale state replaces the Rust `task_local!` LOCALE cell. Each
 * worker thread owns one WASM instance, dispatches one request at a time, and
 * resets its current locale at request boundaries — so a single string per
 * WasmState is equivalent in observable behavior.
 */

// ---------------------------------------------------------------------------
// RTL detection
// ---------------------------------------------------------------------------

const RTL_LANGUAGES = new Set([
  'ar', 'he', 'fa', 'ur', 'yi', 'dv', 'ha', 'khw', 'ks', 'ku', 'ps', 'sd', 'ug',
]);

export function isRtl(locale: string): boolean {
  const primary = (locale.split('-')[0] ?? locale).toLowerCase();
  return RTL_LANGUAGES.has(primary);
}

// ---------------------------------------------------------------------------
// LocaleState — translation store
// ---------------------------------------------------------------------------

/**
 * Flat-keyed translation maps keyed by BCP-47 locale tag. Nested JSON objects
 * are flattened with dot-separated key paths (e.g. `{"common":{"save":"Save"}}`
 * → `common.save → Save`).
 */
export class LocaleState {
  defaultLocale: string;
  translations: Map<string, Map<string, string>>;
  /** Active locale for the current request (mirrors Rust `LOCALE` task-local). */
  currentLocale: string;

  constructor(defaultLocale: string = 'en') {
    this.defaultLocale = defaultLocale;
    this.translations = new Map();
    this.currentLocale = defaultLocale;
  }

  /**
   * Replace the translation map for `locale` with the flattened contents of
   * `jsonStr`. Throws on invalid JSON — `_i18n_load` is called from preamble
   * setup where a failure should be surfaced.
   */
  loadJson(locale: string, jsonStr: string): void {
    let value: unknown;
    try {
      value = JSON.parse(jsonStr);
    } catch (e) {
      throw new Error(`_i18n_load: invalid JSON for locale '${locale}': ${(e as Error).message}`);
    }
    const flat = new Map<string, string>();
    flattenJson(value, '', flat);
    this.translations.set(locale, flat);
  }

  private lookupRaw(key: string, locale: string): string | undefined {
    const exact = this.translations.get(locale)?.get(key);
    if (exact !== undefined) return exact;
    const dash = locale.indexOf('-');
    if (dash > 0) {
      const primary = locale.slice(0, dash);
      if (primary !== locale) {
        const v = this.translations.get(primary)?.get(key);
        if (v !== undefined) return v;
      }
    }
    if (locale !== this.defaultLocale) {
      const v = this.translations.get(this.defaultLocale)?.get(key);
      if (v !== undefined) return v;
    }
    return undefined;
  }

  /**
   * Translate `key` for `locale`, performing `{placeholder}` substitution from
   * `paramsJson` (an object). Returns the key verbatim when no translation
   * matches — matches the Rust host's `t()` fallback.
   */
  translate(key: string, locale: string, paramsJson: string): string {
    const template = this.lookupRaw(key, locale);
    if (template === undefined) return key;
    return interpolate(template, paramsJson);
  }

  /**
   * Pluralized translation. Uses CLDR-simplified plural categories per locale
   * (see `pluralCategory`). Per spec, `count === 0` prefers a `<key>_zero` form
   * when present, regardless of the locale's plural rules.
   */
  translateCount(key: string, count: number, locale: string, paramsJson: string): string {
    const merged = injectCount(paramsJson, count);
    if (count === 0) {
      const zeroKey = `${key}_zero`;
      if (this.lookupRaw(zeroKey, locale) !== undefined) {
        return this.translate(zeroKey, locale, merged);
      }
    }
    const category = pluralCategory(count, locale);
    const suffixed = `${key}_${category}`;
    if (this.lookupRaw(suffixed, locale) !== undefined) {
      return this.translate(suffixed, locale, merged);
    }
    const otherKey = `${key}_other`;
    if (this.lookupRaw(otherKey, locale) !== undefined) {
      return this.translate(otherKey, locale, merged);
    }
    return key;
  }
}

// ---------------------------------------------------------------------------
// JSON flattening
// ---------------------------------------------------------------------------

function flattenJson(value: unknown, prefix: string, out: Map<string, string>): void {
  if (value === null || value === undefined) return;
  if (typeof value === 'string') {
    out.set(prefix, value);
    return;
  }
  if (typeof value === 'number') {
    out.set(prefix, String(value));
    return;
  }
  if (typeof value === 'boolean') {
    out.set(prefix, value ? 'true' : 'false');
    return;
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const newPrefix = prefix === '' ? k : `${prefix}.${k}`;
      flattenJson(v, newPrefix, out);
    }
  }
}

// ---------------------------------------------------------------------------
// Interpolation helpers
// ---------------------------------------------------------------------------

function interpolate(template: string, paramsJson: string): string {
  if (!template.includes('{')) return template;
  let params: unknown;
  try {
    params = JSON.parse(paramsJson);
  } catch {
    return template;
  }
  if (params === null || typeof params !== 'object' || Array.isArray(params)) return template;
  let result = template;
  for (const [k, v] of Object.entries(params as Record<string, unknown>)) {
    const placeholder = `{${k}}`;
    let replacement: string;
    if (typeof v === 'string') replacement = v;
    else if (v === null || v === undefined) replacement = '';
    else replacement = String(v);
    result = result.split(placeholder).join(replacement);
  }
  return result;
}

function injectCount(paramsJson: string, count: number): string {
  let obj: Record<string, unknown>;
  try {
    const parsed = JSON.parse(paramsJson);
    obj = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    obj = {};
  }
  if (!('count' in obj)) obj.count = count;
  return JSON.stringify(obj);
}

// ---------------------------------------------------------------------------
// CLDR plural rules (simplified — mirrors locale.rs plural_category)
// ---------------------------------------------------------------------------

export type PluralCategory = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other';

export function pluralCategory(count: number, locale: string): PluralCategory {
  const primary = (locale.split('-')[0] ?? locale).toLowerCase();
  const abs = Math.abs(Math.trunc(count));

  switch (primary) {
    case 'ar': {
      if (abs === 0) return 'zero';
      if (abs === 1) return 'one';
      if (abs === 2) return 'two';
      if (abs >= 3 && abs <= 10) return 'few';
      if (abs >= 11 && abs <= 99) return 'many';
      const r100 = abs % 100;
      if (r100 >= 3 && r100 <= 10) return 'few';
      if (r100 >= 11 && r100 <= 99) return 'many';
      return 'other';
    }
    case 'he': {
      if (abs === 0) return 'zero';
      if (abs === 1) return 'one';
      if (abs === 2) return 'two';
      if (abs % 10 === 0) return 'many';
      return 'other';
    }
    case 'ru':
    case 'uk':
    case 'be':
      return slavicRu(abs);
    case 'pl': {
      if (abs === 1) return 'one';
      const r10 = abs % 10;
      const r100 = abs % 100;
      if (r10 >= 2 && r10 <= 4 && !(r100 >= 12 && r100 <= 14)) return 'few';
      if (r10 === 0 || r10 >= 5 || (r100 >= 10 && r100 <= 20)) return 'many';
      return 'other';
    }
    case 'cs':
    case 'sk':
      if (abs === 1) return 'one';
      if (abs >= 2 && abs <= 4) return 'few';
      return 'other';
    case 'sl': {
      const r100 = abs % 100;
      if (r100 === 1) return 'one';
      if (r100 === 2) return 'two';
      if (r100 === 3 || r100 === 4) return 'few';
      return 'other';
    }
    case 'fr':
    case 'pt':
      return abs <= 1 ? 'one' : 'other';
    case 'ja':
    case 'zh':
    case 'ko':
    case 'th':
    case 'vi':
    case 'id':
    case 'ms':
      return 'other';
    default:
      return abs === 1 ? 'one' : 'other';
  }
}

function slavicRu(abs: number): PluralCategory {
  const r10 = abs % 10;
  const r100 = abs % 100;
  if (r10 === 1 && r100 !== 11) return 'one';
  if (r10 >= 2 && r10 <= 4 && !(r100 >= 12 && r100 <= 14)) return 'few';
  return 'many';
}

// ---------------------------------------------------------------------------
// Number formatting
// ---------------------------------------------------------------------------

interface NumberFormatChars {
  group: string;
  decimal: string;
}

function numberFormatFor(locale: string): NumberFormatChars {
  const primary = (locale.split('-')[0] ?? locale).toLowerCase();
  const dotGroup = new Set([
    'de', 'nl', 'it', 'pl', 'cs', 'sk', 'hu', 'hr', 'bg', 'ro', 'tr', 'el',
    'ru', 'uk', 'be', 'sl', 'sr', 'no', 'fi', 'da', 'sv', 'nb',
  ]);
  if (dotGroup.has(primary)) return { group: '.', decimal: ',' };
  if (primary === 'fr') return { group: ' ', decimal: ',' };
  return { group: ',', decimal: '.' };
}

export function formatNumber(
  value: number,
  locale: string,
  decimals: number,
  useGrouping: boolean,
): string {
  if (Number.isNaN(value)) return 'NaN';
  if (!Number.isFinite(value)) return value > 0 ? '∞' : '-∞';
  const fmt = numberFormatFor(locale);
  const d = decimals < 0 ? 2 : Math.min(decimals, 20);
  const negative = value < 0;
  const absVal = Math.abs(value);
  const raw = absVal.toFixed(d);
  const dotPos = raw.indexOf('.');
  const intPart = dotPos === -1 ? raw : raw.slice(0, dotPos);
  const fracPart = dotPos === -1 ? '' : raw.slice(dotPos + 1);
  let intFormatted: string;
  if (useGrouping && intPart.length > 3) {
    const chars = intPart.split('');
    const out: string[] = [];
    let count = 0;
    for (let i = chars.length - 1; i >= 0; i--) {
      if (count > 0 && count % 3 === 0) out.push(fmt.group);
      out.push(chars[i]);
      count++;
    }
    intFormatted = out.reverse().join('');
  } else {
    intFormatted = intPart;
  }
  let result = '';
  if (negative) result += '-';
  result += intFormatted;
  if (d > 0 && fracPart !== '') {
    result += fmt.decimal;
    result += fracPart;
  }
  return result;
}

export function parseNumberOptions(optionsJson: string): { decimals: number; useGrouping: boolean } {
  let obj: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(optionsJson);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      obj = parsed as Record<string, unknown>;
    }
  } catch {
    /* fall through to defaults */
  }
  const maxFrac = obj.maximumFractionDigits;
  const minFrac = obj.minimumFractionDigits;
  let decimals = -1;
  const pick = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : null);
  const chosen = pick(maxFrac) ?? pick(minFrac);
  if (chosen !== null) decimals = Math.min(Math.max(chosen, 0), 20);
  const useGrouping = typeof obj.useGrouping === 'boolean' ? (obj.useGrouping as boolean) : true;
  return { decimals, useGrouping };
}

// ---------------------------------------------------------------------------
// Currency formatting
// ---------------------------------------------------------------------------

function currencySymbol(code: string, locale: string): string {
  const upper = code.toUpperCase();
  const primary = (locale.split('-')[0] ?? locale).toLowerCase();
  switch (upper) {
    case 'USD':
      return primary.startsWith('en') ? '$' : 'US$';
    case 'EUR':
      return '€';
    case 'GBP':
      return '£';
    case 'JPY':
      return '¥';
    case 'CNY':
    case 'RMB':
      return '¥';
    case 'CAD':
      return 'CA$';
    case 'AUD':
      return 'A$';
    case 'CHF':
      return 'Fr.';
    case 'INR':
      return '₹';
    case 'KRW':
      return '₩';
    case 'BRL':
      return 'R$';
    case 'MXN':
      return 'MX$';
    case 'SEK':
    case 'NOK':
      return 'kr';
    case 'DKK':
      return 'kr.';
    case 'PLN':
      return 'zł';
    case 'CZK':
      return 'Kč';
    case 'HUF':
      return 'Ft';
    case 'RUB':
      return '₽';
    case 'TRY':
      return '₺';
    case 'SAR':
      return '﷼';
    case 'AED':
      return 'د.إ';
    case 'SGD':
      return 'S$';
    case 'HKD':
      return 'HK$';
    case 'NZD':
      return 'NZ$';
    case 'ZAR':
      return 'R';
    case 'THB':
      return '฿';
    case 'IDR':
      return 'Rp';
    case 'MYR':
      return 'RM';
    case 'PHP':
      return '₱';
    case 'VND':
      return '₫';
    case 'EGP':
      return 'E£';
    case 'UAH':
      return '₴';
    case 'RON':
      return 'lei';
    default:
      return upper;
  }
}

export function formatCurrency(value: number, currencyCode: string, locale: string): string {
  const upper = currencyCode.toUpperCase();
  const symbol = currencySymbol(upper, locale);
  const zeroDecimals = new Set(['JPY', 'KRW', 'VND', 'IDR', 'HUF', 'CLP', 'ISK', 'PYG', 'UGX', 'RWF']);
  const decimals = zeroDecimals.has(upper) ? 0 : 2;
  const numberStr = formatNumber(value, locale, decimals, true);
  const primary = (locale.split('-')[0] ?? locale).toLowerCase();
  const suffixGroup = new Set(['sv', 'nb', 'da', 'pl', 'cs', 'sk', 'hu', 'ro']);
  if (suffixGroup.has(primary)) return `${numberStr} ${symbol}`;
  if (primary === 'fr') return `${numberStr} ${symbol}`;
  return `${symbol}${numberStr}`;
}

// ---------------------------------------------------------------------------
// Date formatting
// ---------------------------------------------------------------------------

const MONTH_ABBR: Record<string, string[]> = {
  fr: ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'],
  de: ['Jan.', 'Feb.', 'Mär.', 'Apr.', 'Mai', 'Juni', 'Juli', 'Aug.', 'Sep.', 'Okt.', 'Nov.', 'Dez.'],
  es: ['ene.', 'feb.', 'mar.', 'abr.', 'may.', 'jun.', 'jul.', 'ago.', 'sep.', 'oct.', 'nov.', 'dic.'],
  pt: ['jan.', 'fev.', 'mar.', 'abr.', 'mai.', 'jun.', 'jul.', 'ago.', 'set.', 'out.', 'nov.', 'dez.'],
  ja: ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'],
  zh: ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'],
  ko: ['1월', '2월', '3월', '4월', '5월', '6월', '7월', '8월', '9월', '10월', '11월', '12월'],
  default: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
};

const MONTH_FULL: Record<string, string[]> = {
  fr: ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'],
  de: ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'],
  es: ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'],
  pt: ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'],
  ja: MONTH_ABBR.ja,
  zh: MONTH_ABBR.zh,
  ko: MONTH_ABBR.ko,
  default: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
};

// Weekday tables — index 0 = Sunday, 1 = Monday, ..., 6 = Saturday (matches Date.getUTCDay()).
const WEEKDAY_FULL: Record<string, string[]> = {
  fr: ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'],
  de: ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'],
  es: ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'],
  pt: ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'],
  ja: ['日曜日', '月曜日', '火曜日', '水曜日', '木曜日', '金曜日', '土曜日'],
  zh: ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'],
  ko: ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일'],
  default: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
};

function table<T>(t: Record<string, T[]>, primary: string): T[] {
  return t[primary] ?? t.default;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * `timestampSeconds` is the Unix epoch in seconds (matching the Rust host).
 * The bridge multiplies the registry's `epoch_ms` float by 1/1000 before
 * calling in — see `_i18n_format_date`.
 */
export function formatDate(timestampSeconds: number, style: string, locale: string): string {
  if (Number.isNaN(timestampSeconds) || !Number.isFinite(timestampSeconds)) return 'Invalid Date';
  const ms = Math.trunc(timestampSeconds) * 1000;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return 'Invalid Date';
  const primary = (locale.split('-')[0] ?? locale).toLowerCase();
  switch (style) {
    case 'short':
      return formatDateShort(date, primary);
    case 'medium':
      return formatDateMedium(date, primary);
    case 'long':
      return formatDateLong(date, primary);
    case 'full':
      return formatDateFull(date, primary);
    default:
      // Unknown style: return ISO-ish fallback. The Rust host passes the
      // unknown string to chrono::format, which differs from Date's API;
      // the realistic frame.locale call sites only pass the four documented
      // styles, so we treat anything else as `medium`.
      return formatDateMedium(date, primary);
  }
}

function formatDateShort(d: Date, primary: string): string {
  const y = d.getUTCFullYear() % 100;
  const m = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  if (primary === 'en') return `${m}/${day}/${pad2(y)}`;
  const dotGroup = new Set([
    'de', 'nl', 'pl', 'cs', 'sk', 'hu', 'hr', 'sl', 'sr', 'bg', 'ru', 'uk', 'be', 'ro', 'tr', 'el',
  ]);
  if (dotGroup.has(primary)) return `${pad2(day)}.${pad2(m)}.${pad2(y)}`;
  const slashGroup = new Set(['fr', 'pt', 'es', 'it', 'nb', 'da', 'sv', 'fi', 'et', 'lv', 'lt']);
  if (slashGroup.has(primary)) return `${pad2(day)}/${pad2(m)}/${pad2(y)}`;
  if (primary === 'ja' || primary === 'zh' || primary === 'ko') return `${pad2(y)}/${pad2(m)}/${pad2(day)}`;
  return `${m}/${day}/${pad2(y)}`;
}

function formatDateMedium(d: Date, primary: string): string {
  const abbr = table(MONTH_ABBR, primary)[d.getUTCMonth()];
  const day = d.getUTCDate();
  const y = d.getUTCFullYear();
  const dayMonthYearGroup = new Set([
    'fr', 'de', 'es', 'pt', 'it', 'pl', 'cs', 'sk', 'hu', 'ro', 'nl',
    'sv', 'nb', 'da', 'fi', 'tr',
  ]);
  if (dayMonthYearGroup.has(primary)) return `${day} ${abbr} ${y}`;
  if (primary === 'ja' || primary === 'zh') return `${y}年${abbr}日`;
  if (primary === 'ko') return `${y}년 ${abbr} ${day}일`;
  return `${abbr} ${day}, ${y}`;
}

function formatDateLong(d: Date, primary: string): string {
  const full = table(MONTH_FULL, primary)[d.getUTCMonth()];
  const day = d.getUTCDate();
  const y = d.getUTCFullYear();
  if (primary === 'fr') return `${day} ${full} ${y}`;
  if (primary === 'de') return `${day}. ${full} ${y}`;
  if (primary === 'es' || primary === 'pt' || primary === 'it' || primary === 'nl') {
    return `${day} de ${full} de ${y}`;
  }
  if (primary === 'ja' || primary === 'zh') return `${y}年${full}${day}日`;
  if (primary === 'ko') return `${y}년 ${full} ${day}일`;
  return `${full} ${day}, ${y}`;
}

function formatDateFull(d: Date, primary: string): string {
  const dayName = table(WEEKDAY_FULL, primary)[d.getUTCDay()];
  const long = formatDateLong(d, primary);
  if (primary === 'ja' || primary === 'zh' || primary === 'ko') return `${long}(${dayName})`;
  return `${dayName}, ${long}`;
}
