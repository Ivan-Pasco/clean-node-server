/**
 * Console bridge tests — createConsoleBridge
 *
 * Alignment: positive-path contract for all console output functions.
 * Category: contract
 *
 * Tests cover: print (no newline), printl (with newline), print_integer,
 * print_float, print_boolean, print_error, print_debug (verbose gating),
 * console_log, console_error, console_warn.
 *
 * Strategy: intercept process.stdout.write, console.log, console.error,
 * console.warn with vi.spyOn to capture output without producing real I/O.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createConsoleBridge } from '../src/bridge/console';
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
  vi.restoreAllMocks();
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Console bridge — string output functions', () => {
  it('print writes raw string bytes to stdout without a trailing newline', () => {
    const memory = new WebAssembly.Memory({ initial: 2 });
    const state = makeMockState(memory);
    const bridge = createConsoleBridge(() => state);
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const len = writeRawAt(memory, 64, 'hello');
    bridge.print(64, len);

    expect(spy).toHaveBeenCalledOnce();
    const written = spy.mock.calls[0][0] as string;
    expect(written).toBe('hello');
    expect(written.endsWith('\n')).toBe(false);
  });

  it('printl calls console.log with the decoded string', () => {
    const memory = new WebAssembly.Memory({ initial: 2 });
    const state = makeMockState(memory);
    const bridge = createConsoleBridge(() => state);
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const len = writeRawAt(memory, 128, 'world');
    bridge.printl(128, len);

    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0][0]).toBe('world');
  });

  it('console_log and console_warn route to their respective console methods', () => {
    const memory = new WebAssembly.Memory({ initial: 2 });
    const state = makeMockState(memory);
    const bridge = createConsoleBridge(() => state);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const logLen = writeRawAt(memory, 200, 'log-msg');
    bridge.console_log(200, logLen);
    expect(logSpy).toHaveBeenCalledWith('log-msg');

    const warnLen = writeRawAt(memory, 300, 'warn-msg');
    bridge.console_warn(300, warnLen);
    expect(warnSpy).toHaveBeenCalledWith('warn-msg');
  });
});

describe('Console bridge — numeric and boolean output', () => {
  it('print_integer floors the value and passes to console.log', () => {
    const state = makeMockState();
    const bridge = createConsoleBridge(() => state);
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    bridge.print_integer(42);
    expect(spy).toHaveBeenCalledWith(42);

    bridge.print_integer(3.9);
    expect(spy).toHaveBeenCalledWith(3); // Math.floor(3.9) = 3
  });

  it('print_float passes the value unchanged to console.log', () => {
    const state = makeMockState();
    const bridge = createConsoleBridge(() => state);
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    bridge.print_float(3.14);
    expect(spy).toHaveBeenCalledWith(3.14);
  });

  it('print_boolean outputs "true" for non-zero and "false" for zero', () => {
    const state = makeMockState();
    const bridge = createConsoleBridge(() => state);
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    bridge.print_boolean(1);
    expect(spy).toHaveBeenCalledWith('true');

    bridge.print_boolean(0);
    expect(spy).toHaveBeenCalledWith('false');

    bridge.print_boolean(42);
    expect(spy).toHaveBeenCalledWith('true');
  });
});

describe('Console bridge — error and debug routing', () => {
  it('print_error writes to stderr with trailing newline', () => {
    const memory = new WebAssembly.Memory({ initial: 2 });
    const state = makeMockState(memory);
    const bridge = createConsoleBridge(() => state);
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const len = writeRawAt(memory, 64, 'oops');
    bridge.print_error(64, len);

    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0][0]).toBe('oops\n');
  });

  it('console_error routes to console.error', () => {
    const memory = new WebAssembly.Memory({ initial: 2 });
    const state = makeMockState(memory);
    const bridge = createConsoleBridge(() => state);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const len = writeRawAt(memory, 64, 'err-msg');
    bridge.console_error(64, len);

    expect(spy).toHaveBeenCalledWith('err-msg');
  });

  it('print_debug suppressed when verbose=false, emitted when verbose=true', () => {
    const memory = new WebAssembly.Memory({ initial: 2 });
    const state = makeMockState(memory);
    const bridge = createConsoleBridge(() => state);
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const len = writeRawAt(memory, 64, 'dbg-msg');

    // verbose is false — no output
    bridge.print_debug(64, len);
    expect(spy).not.toHaveBeenCalled();

    // Enable verbose
    (state.config as { verbose: boolean }).verbose = true;
    bridge.print_debug(64, len);
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0][0]).toContain('dbg-msg');
  });
});
