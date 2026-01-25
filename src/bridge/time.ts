import { WasmState } from '../types';
import { readString, writeString } from './helpers';

/**
 * Create time/date bridge functions
 */
export function createTimeBridge(getState: () => WasmState) {
  return {
    /**
     * Get current time as JSON with ISO string and epoch
     *
     * @returns Pointer to JSON { iso: string, epoch: number }
     */
    _time_now(): number {
      const state = getState();
      const now = new Date();

      return writeString(state, JSON.stringify({
        iso: now.toISOString(),
        epoch: now.getTime(),
      }));
    },

    /**
     * Get current Unix timestamp (milliseconds)
     */
    _time_epoch_ms(): number {
      return Date.now();
    },

    /**
     * Get current Unix timestamp (seconds)
     */
    _time_epoch_sec(): number {
      return Math.floor(Date.now() / 1000);
    },

    /**
     * Get ISO string for current time
     */
    _time_iso(): number {
      const state = getState();
      return writeString(state, new Date().toISOString());
    },

    /**
     * Format a timestamp as ISO string
     */
    _time_format_iso(epochMs: number): number {
      const state = getState();
      const date = new Date(epochMs);
      return writeString(state, date.toISOString());
    },

    /**
     * Parse ISO string to epoch milliseconds
     *
     * @returns Epoch milliseconds or -1 on error
     */
    _time_parse_iso(isoPtr: number, isoLen: number): number {
      const state = getState();
      const iso = readString(state, isoPtr, isoLen);

      try {
        const date = new Date(iso);
        if (isNaN(date.getTime())) {
          return -1;
        }
        return date.getTime();
      } catch {
        return -1;
      }
    },

    /**
     * Get date components as JSON
     */
    _time_components(epochMs: number): number {
      const state = getState();
      const date = new Date(epochMs);

      return writeString(state, JSON.stringify({
        year: date.getFullYear(),
        month: date.getMonth() + 1, // 1-indexed
        day: date.getDate(),
        hour: date.getHours(),
        minute: date.getMinutes(),
        second: date.getSeconds(),
        millisecond: date.getMilliseconds(),
        dayOfWeek: date.getDay(), // 0 = Sunday
      }));
    },

    /**
     * Create timestamp from components
     */
    _time_from_components(
      year: number,
      month: number,
      day: number,
      hour: number,
      minute: number,
      second: number
    ): number {
      const date = new Date(year, month - 1, day, hour, minute, second);
      return date.getTime();
    },

    /**
     * Add duration to timestamp
     */
    _time_add(epochMs: number, durationMs: number): number {
      return epochMs + durationMs;
    },

    /**
     * Calculate difference between two timestamps
     */
    _time_diff(epochMs1: number, epochMs2: number): number {
      return epochMs2 - epochMs1;
    },

    /**
     * Format timestamp as human-readable locale string
     */
    _time_format_locale(epochMs: number, localePtr: number, localeLen: number): number {
      const state = getState();
      const locale = localeLen > 0 ? readString(state, localePtr, localeLen) : 'en-US';
      const date = new Date(epochMs);

      try {
        return writeString(state, date.toLocaleString(locale));
      } catch {
        return writeString(state, date.toLocaleString());
      }
    },

    /**
     * Get timezone offset in minutes
     */
    _time_timezone_offset(): number {
      return new Date().getTimezoneOffset();
    },

    /**
     * Check if timestamp is in the past
     */
    _time_is_past(epochMs: number): number {
      return epochMs < Date.now() ? 1 : 0;
    },

    /**
     * Check if timestamp is in the future
     */
    _time_is_future(epochMs: number): number {
      return epochMs > Date.now() ? 1 : 0;
    },

    /**
     * Sleep for a duration (blocking)
     * Note: This is a synchronous sleep, use with caution
     */
    _time_sleep(ms: number): void {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        // Busy wait - not ideal but necessary for WASM sync
      }
    },
  };
}
