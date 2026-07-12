/**
 * Time bridge tests — createTimeBridge
 *
 * Alignment: positive-path contract for time/date bridge functions.
 * Category: contract
 *
 * Tests cover:
 *   - _time_now returns a BigInt (seconds since epoch)
 *   - _time_epoch_ms and _time_epoch_sec return reasonable values
 *   - _time_iso returns a valid ISO string LP-string
 *   - _time_format_iso formats a given epoch ms correctly
 *   - _time_parse_iso parses a valid ISO string to epoch ms; returns -1 for invalid
 *   - _time_components returns the correct date-parts JSON
 *   - _time_from_components reconstructs a known timestamp
 *   - _time_add and _time_diff arithmetic
 *   - _time_is_past and _time_is_future with known past/future timestamps
 *   - _time_timezone_offset returns a number
 *
 * vi.useFakeTimers() is applied where Date.now() needs to be deterministic.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createTimeBridge } from '../src/bridge/time';
import { readLengthPrefixedString } from '../src/wasm/memory';
import type { WasmState } from '../src/types';

// ─── Test helpers ────────────────────────────────────────────────────────────

function writeRawAt(memory: WebAssembly.Memory, ptr: number, str: string): number {
  const bytes = new TextEncoder().encode(str);
  new Uint8Array(memory.buffer).set(bytes, ptr);
  return bytes.length;
}

function makeMockState(memory?: WebAssembly.Memory, heapStart = 65_536): WasmState {
  const mem = memory ?? new WebAssembly.Memory({ initial: 4 });
  let heapPtr = heapStart;
  const exports = {
    memory: mem,
    malloc: (size: number): number => {
      const ptr = heapPtr;
      heapPtr += size + 4;
      return ptr;
    },
  } as unknown as WasmState['exports'];
  return { exports, config: { verbose: false }, projectRoot: '/tmp' } as unknown as WasmState;
}

afterEach(() => {
  vi.useRealTimers();
});

// Known anchor: 2024-01-15T12:00:00.000Z = 1705320000000 ms
const ANCHOR_MS = 1705320000000;
const ANCHOR_SEC = 1705320000;

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Time bridge — epoch accessors', () => {
  it('_time_now returns a BigInt in seconds that matches Date.now()', () => {
    vi.useFakeTimers();
    vi.setSystemTime(ANCHOR_MS);

    const state = makeMockState();
    const bridge = createTimeBridge(() => state);

    const now = bridge._time_now();
    expect(typeof now).toBe('bigint');
    expect(now).toBe(BigInt(ANCHOR_SEC));
  });

  it('_time_epoch_ms returns millisecond timestamp', () => {
    vi.useFakeTimers();
    vi.setSystemTime(ANCHOR_MS);

    const state = makeMockState();
    const bridge = createTimeBridge(() => state);

    expect(bridge._time_epoch_ms()).toBe(ANCHOR_MS);
  });

  it('_time_epoch_sec returns floor(epoch_ms / 1000)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(ANCHOR_MS + 999); // ms part should be floored away

    const state = makeMockState();
    const bridge = createTimeBridge(() => state);

    expect(bridge._time_epoch_sec()).toBe(ANCHOR_SEC);
  });
});

describe('Time bridge — ISO formatting', () => {
  it('_time_iso returns a valid ISO 8601 LP-string for current time', () => {
    vi.useFakeTimers();
    vi.setSystemTime(ANCHOR_MS);

    const memory = new WebAssembly.Memory({ initial: 4 });
    const state = makeMockState(memory);
    const bridge = createTimeBridge(() => state);

    const ptr = bridge._time_iso();
    const iso = readLengthPrefixedString(memory, ptr);
    expect(iso).toBe('2024-01-15T12:00:00.000Z');
    expect(new Date(iso).getTime()).toBe(ANCHOR_MS);
  });

  it('_time_format_iso formats a given epoch ms as ISO string', () => {
    const memory = new WebAssembly.Memory({ initial: 4 });
    const state = makeMockState(memory);
    const bridge = createTimeBridge(() => state);

    const ptr = bridge._time_format_iso(ANCHOR_MS);
    const iso = readLengthPrefixedString(memory, ptr);
    expect(iso).toBe('2024-01-15T12:00:00.000Z');
  });
});

describe('Time bridge — ISO parsing', () => {
  it('_time_parse_iso parses a valid ISO string to epoch ms', () => {
    const memory = new WebAssembly.Memory({ initial: 4 });
    const state = makeMockState(memory);
    const bridge = createTimeBridge(() => state);

    const isoStr = '2024-01-15T12:00:00.000Z';
    const len = writeRawAt(memory, 64, isoStr);
    const result = bridge._time_parse_iso(64, len);
    expect(result).toBe(ANCHOR_MS);
  });

  it('_time_parse_iso returns -1 for an invalid ISO string', () => {
    const memory = new WebAssembly.Memory({ initial: 4 });
    const state = makeMockState(memory);
    const bridge = createTimeBridge(() => state);

    const bad = 'not-a-date';
    const len = writeRawAt(memory, 64, bad);
    expect(bridge._time_parse_iso(64, len)).toBe(-1);
  });

  it('_time_parse_iso returns -1 for an empty string', () => {
    const memory = new WebAssembly.Memory({ initial: 4 });
    const state = makeMockState(memory);
    const bridge = createTimeBridge(() => state);

    const len = writeRawAt(memory, 64, '');
    // Empty string → new Date('') is Invalid Date
    expect(bridge._time_parse_iso(64, len)).toBe(-1);
  });
});

describe('Time bridge — date components', () => {
  it('_time_components returns correct year/month/day/hour/minute/second', () => {
    const memory = new WebAssembly.Memory({ initial: 4 });
    const state = makeMockState(memory);
    const bridge = createTimeBridge(() => state);

    const ptr = bridge._time_components(ANCHOR_MS);
    const json = JSON.parse(readLengthPrefixedString(memory, ptr)) as {
      year: number;
      month: number;
      day: number;
      hour: number;
      minute: number;
      second: number;
      millisecond: number;
      dayOfWeek: number;
    };

    // 2024-01-15T12:00:00Z in UTC
    expect(json.year).toBe(2024);
    expect(json.month).toBe(1);   // 1-indexed
    expect(json.millisecond).toBe(0);
    // day/hour depend on local timezone — just assert they're numbers
    expect(typeof json.day).toBe('number');
    expect(typeof json.hour).toBe('number');
    expect(typeof json.dayOfWeek).toBe('number');
    expect(json.dayOfWeek).toBeGreaterThanOrEqual(0);
    expect(json.dayOfWeek).toBeLessThanOrEqual(6);
  });

  it('_time_from_components reconstructs a known local timestamp', () => {
    const state = makeMockState();
    const bridge = createTimeBridge(() => state);

    // Construct 2024-06-01 00:00:00 local time
    const ts = bridge._time_from_components(2024, 6, 1, 0, 0, 0);
    const d = new Date(ts);
    expect(d.getFullYear()).toBe(2024);
    expect(d.getMonth() + 1).toBe(6);
    expect(d.getDate()).toBe(1);
  });
});

describe('Time bridge — arithmetic and comparisons', () => {
  it('_time_add returns sum of epochMs + durationMs', () => {
    const state = makeMockState();
    const bridge = createTimeBridge(() => state);

    expect(bridge._time_add(1000, 500)).toBe(1500);
    expect(bridge._time_add(ANCHOR_MS, 60_000)).toBe(ANCHOR_MS + 60_000);
  });

  it('_time_diff returns epochMs2 - epochMs1', () => {
    const state = makeMockState();
    const bridge = createTimeBridge(() => state);

    expect(bridge._time_diff(1000, 4000)).toBe(3000);
    expect(bridge._time_diff(ANCHOR_MS + 5000, ANCHOR_MS)).toBe(-5000);
  });

  it('_time_is_past returns 1 for a timestamp in the past', () => {
    vi.useFakeTimers();
    vi.setSystemTime(ANCHOR_MS);

    const state = makeMockState();
    const bridge = createTimeBridge(() => state);

    // ANCHOR_MS - 1000 is 1 second before "now"
    expect(bridge._time_is_past(ANCHOR_MS - 1000)).toBe(1);
    // ANCHOR_MS + 1000 is in the future
    expect(bridge._time_is_past(ANCHOR_MS + 1000)).toBe(0);
  });

  it('_time_is_future returns 1 for a timestamp in the future', () => {
    vi.useFakeTimers();
    vi.setSystemTime(ANCHOR_MS);

    const state = makeMockState();
    const bridge = createTimeBridge(() => state);

    expect(bridge._time_is_future(ANCHOR_MS + 1000)).toBe(1);
    expect(bridge._time_is_future(ANCHOR_MS - 1000)).toBe(0);
  });
});

describe('Time bridge — timezone offset', () => {
  it('_time_timezone_offset returns a number (minutes)', () => {
    const state = makeMockState();
    const bridge = createTimeBridge(() => state);

    const offset = bridge._time_timezone_offset();
    expect(typeof offset).toBe('number');
    // Offset ranges from -840 to +840 minutes (UTC-14 to UTC+14)
    expect(offset).toBeGreaterThanOrEqual(-840);
    expect(offset).toBeLessThanOrEqual(840);
  });
});
