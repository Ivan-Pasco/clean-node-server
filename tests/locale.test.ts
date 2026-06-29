/**
 * Locale tests — TypeScript port of clean-server/src/locale.rs::tests.
 *
 * These mirror the Rust tests to keep cross-host observable behavior aligned.
 * The cases were copied verbatim where possible; only the test API shape
 * differs.
 */

import { describe, it, expect } from 'vitest';
import {
  LocaleState,
  formatCurrency,
  formatDate,
  formatNumber,
  isRtl,
  parseNumberOptions,
  pluralCategory,
} from '../src/locale';

describe('LocaleState — translate', () => {
  it('returns the translation when the key is found', () => {
    const s = new LocaleState('en');
    s.loadJson('en', JSON.stringify({ common: { save: 'Save' } }));
    expect(s.translate('common.save', 'en', '{}')).toBe('Save');
  });

  it('falls back to the default locale when the requested locale is missing', () => {
    const s = new LocaleState('en');
    s.loadJson('en', JSON.stringify({ common: { save: 'Save' } }));
    expect(s.translate('common.save', 'fr', '{}')).toBe('Save');
  });

  it('returns the key verbatim when no translation matches', () => {
    const s = new LocaleState('en');
    expect(s.translate('missing.key', 'en', '{}')).toBe('missing.key');
  });

  it('interpolates {placeholders} from params JSON', () => {
    const s = new LocaleState('en');
    s.loadJson('en', JSON.stringify({ greeting: 'Hello, {name}!' }));
    expect(s.translate('greeting', 'en', JSON.stringify({ name: 'Alice' }))).toBe('Hello, Alice!');
  });

  it('falls back from BCP-47 region to the primary subtag', () => {
    const s = new LocaleState('en');
    s.loadJson('fr', JSON.stringify({ save: 'Sauvegarder' }));
    expect(s.translate('save', 'fr-CA', '{}')).toBe('Sauvegarder');
  });

  it('flattens nested JSON keys with dot notation', () => {
    const s = new LocaleState('en');
    s.loadJson('en', JSON.stringify({ users: { greeting: 'Hello', bye: 'Goodbye' } }));
    expect(s.translate('users.greeting', 'en', '{}')).toBe('Hello');
    expect(s.translate('users.bye', 'en', '{}')).toBe('Goodbye');
  });
});

describe('LocaleState — translateCount (CLDR-simplified plurals)', () => {
  it('uses _zero / _one / _other for English', () => {
    const s = new LocaleState('en');
    s.loadJson(
      'en',
      JSON.stringify({
        users_zero: 'No users',
        users_one: 'One user',
        users_other: '{count} users',
      }),
    );
    expect(s.translateCount('users', 0, 'en', '{}')).toBe('No users');
    expect(s.translateCount('users', 1, 'en', '{}')).toBe('One user');
    expect(s.translateCount('users', 5, 'en', '{}')).toBe('5 users');
  });

  it('falls back to _other when no _zero is declared', () => {
    const s = new LocaleState('en');
    s.loadJson('en', JSON.stringify({ items_one: 'One item', items_other: '{count} items' }));
    expect(s.translateCount('items', 0, 'en', '{}')).toBe('0 items');
    expect(s.translateCount('items', 5, 'en', '{}')).toBe('5 items');
  });
});

describe('pluralCategory', () => {
  it('classifies English plurals', () => {
    expect(pluralCategory(1, 'en')).toBe('one');
    expect(pluralCategory(0, 'en')).toBe('other');
    expect(pluralCategory(5, 'en')).toBe('other');
  });

  it('classifies Russian plurals (one/few/many)', () => {
    expect(pluralCategory(1, 'ru')).toBe('one');
    expect(pluralCategory(11, 'ru')).toBe('many');
    expect(pluralCategory(2, 'ru')).toBe('few');
    expect(pluralCategory(5, 'ru')).toBe('many');
  });

  it('classifies French (1 or 0 → one)', () => {
    expect(pluralCategory(0, 'fr')).toBe('one');
    expect(pluralCategory(1, 'fr')).toBe('one');
    expect(pluralCategory(2, 'fr')).toBe('other');
  });

  it('returns "other" for invariant-plural locales', () => {
    expect(pluralCategory(1, 'ja')).toBe('other');
    expect(pluralCategory(100, 'zh')).toBe('other');
  });
});

describe('formatNumber', () => {
  it('formats English with comma grouping and decimal point', () => {
    expect(formatNumber(1299.99, 'en-US', 2, true)).toBe('1,299.99');
  });

  it('formats German with dot grouping and comma decimal', () => {
    expect(formatNumber(1299.99, 'de', 2, true)).toBe('1.299,99');
  });

  it('omits grouping when requested', () => {
    expect(formatNumber(1299.99, 'en', 2, false)).toBe('1299.99');
  });

  it('parses options JSON with sensible defaults', () => {
    expect(parseNumberOptions('{}')).toEqual({ decimals: -1, useGrouping: true });
    expect(parseNumberOptions('{"maximumFractionDigits":4}')).toEqual({ decimals: 4, useGrouping: true });
    expect(parseNumberOptions('{"useGrouping":false}')).toEqual({ decimals: -1, useGrouping: false });
  });
});

describe('formatCurrency', () => {
  it('formats USD in en-US with a leading $', () => {
    expect(formatCurrency(1299.99, 'USD', 'en-US')).toBe('$1,299.99');
  });

  it('drops decimals for currencies that do not use them (JPY)', () => {
    expect(formatCurrency(1299.0, 'JPY', 'ja')).toBe('¥1,299');
  });
});

describe('formatDate', () => {
  // 2026-01-01 00:00:00 UTC = 1767225600 seconds
  const epoch2026 = 1767225600;

  it('formats English medium', () => {
    expect(formatDate(epoch2026, 'medium', 'en-US')).toBe('Jan 1, 2026');
  });

  it('formats English short (en-US)', () => {
    expect(formatDate(epoch2026, 'short', 'en-US')).toBe('1/1/26');
  });

  it('formats English long', () => {
    expect(formatDate(epoch2026, 'long', 'en')).toBe('January 1, 2026');
  });

  it('formats English full', () => {
    expect(formatDate(epoch2026, 'full', 'en')).toBe('Thursday, January 1, 2026');
  });

  it('returns "Invalid Date" for NaN', () => {
    expect(formatDate(NaN, 'short', 'en')).toBe('Invalid Date');
  });
});

describe('isRtl', () => {
  it('recognizes Arabic and Hebrew as RTL', () => {
    expect(isRtl('ar')).toBe(true);
    expect(isRtl('ar-SA')).toBe(true);
  });

  it('recognizes Latin scripts as LTR', () => {
    expect(isRtl('en')).toBe(false);
    expect(isRtl('fr-CA')).toBe(false);
  });
});
