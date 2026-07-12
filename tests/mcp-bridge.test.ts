/**
 * MCP bridge tests — createMcpBridge
 *
 * Alignment: positive-path contract for bridge method surface and
 *   graceful behaviour on paths that don't require workers.
 * Category: contract
 *
 * The MCP bridge spawns worker threads for its real protocol I/O, so this
 * suite avoids any real I/O. It verifies:
 *   1. The bridge object exposes all documented methods.
 *   2. _mcp_stdio_write routes to stdout when no HTTP worker is wired.
 *   3. _mcp_http_respond returns 0 when no worker / request-id is active.
 *   4. _mcp_sse_send returns 0 when no HTTP worker is wired.
 *   5. _mcp_log writes to stderr without throwing.
 *   6. _mcp_http_accept returns an LP-string when control buffers aren't set.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createMcpBridge } from '../src/bridge/mcp';
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

describe('MCP bridge — method surface', () => {
  it('bridge exposes all six documented methods', () => {
    const state = makeMockState();
    const bridge = createMcpBridge(() => state);

    const methods = [
      '_mcp_stdio_read',
      '_mcp_stdio_write',
      '_mcp_http_serve',
      '_mcp_http_accept',
      '_mcp_http_respond',
      '_mcp_sse_send',
      '_mcp_log',
    ];

    for (const m of methods) {
      expect(typeof (bridge as Record<string, unknown>)[m], `method ${m}`).toBe('function');
    }
  });
});

describe('MCP bridge — _mcp_stdio_write (no worker path)', () => {
  it('writes message to stdout and returns 1 when no HTTP worker is active', () => {
    const memory = new WebAssembly.Memory({ initial: 4 });
    const state = makeMockState(memory);
    const bridge = createMcpBridge(() => state);
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const len = writeRawAt(memory, 128, '{"jsonrpc":"2.0","id":1}');
    const rc = bridge._mcp_stdio_write(128, len);

    expect(rc).toBe(1);
    expect(spy).toHaveBeenCalledOnce();
    const written = spy.mock.calls[0][0] as string;
    expect(written).toContain('{"jsonrpc":"2.0","id":1}');
  });

  it('appends a newline to the written message', () => {
    const memory = new WebAssembly.Memory({ initial: 4 });
    const state = makeMockState(memory);
    const bridge = createMcpBridge(() => state);
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const msg = 'ping';
    const len = writeRawAt(memory, 64, msg);
    bridge._mcp_stdio_write(64, len);

    const written = spy.mock.calls[0][0] as string;
    expect(written.endsWith('\n')).toBe(true);
    expect(written).toBe(msg + '\n');
  });
});

describe('MCP bridge — _mcp_http_respond (no worker)', () => {
  it('returns 0 when no HTTP worker is active', () => {
    const memory = new WebAssembly.Memory({ initial: 4 });
    const state = makeMockState(memory);
    const bridge = createMcpBridge(() => state);

    const len = writeRawAt(memory, 64, '{"result":"ok"}');
    const rc = bridge._mcp_http_respond(64, len);
    expect(rc).toBe(0);
  });
});

describe('MCP bridge — _mcp_sse_send (no worker)', () => {
  it('returns 0 when no HTTP worker is wired', () => {
    const memory = new WebAssembly.Memory({ initial: 4 });
    const state = makeMockState(memory);
    const bridge = createMcpBridge(() => state);

    const clientLen = writeRawAt(memory, 64, 'client-abc');
    const eventLen = writeRawAt(memory, 128, 'data: hello\n\n');
    const rc = bridge._mcp_sse_send(64, clientLen, 128, eventLen);
    expect(rc).toBe(0);
  });
});

describe('MCP bridge — _mcp_log', () => {
  it('writes level and message to stderr and returns 1', () => {
    const memory = new WebAssembly.Memory({ initial: 4 });
    const state = makeMockState(memory);
    const bridge = createMcpBridge(() => state);
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const lvlLen = writeRawAt(memory, 64, 'info');
    const msgLen = writeRawAt(memory, 128, 'server started');
    const rc = bridge._mcp_log(64, lvlLen, 128, msgLen);

    expect(rc).toBe(1);
    expect(spy).toHaveBeenCalledOnce();
    const written = spy.mock.calls[0][0] as string;
    expect(written).toContain('info');
    expect(written).toContain('server started');
  });

  it('_mcp_log works for multiple log levels without throwing', () => {
    const memory = new WebAssembly.Memory({ initial: 4 });
    const state = makeMockState(memory);
    const bridge = createMcpBridge(() => state);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    for (const level of ['debug', 'warn', 'error']) {
      const ll = writeRawAt(memory, 64, level);
      const ml = writeRawAt(memory, 200, `message for ${level}`);
      expect(() => bridge._mcp_log(64, ll, 200, ml)).not.toThrow();
    }
  });
});

describe('MCP bridge — _mcp_http_accept (no buffers)', () => {
  it('returns an LP-string pointer (empty) when control buffers are not set', () => {
    // _mcp_http_accept uses Atomics.wait when buffers are present.
    // When httpReqCtrl is undefined it returns writeString(state, '').
    const memory = new WebAssembly.Memory({ initial: 4 });
    const state = makeMockState(memory);
    const bridge = createMcpBridge(() => state);

    const ptr = bridge._mcp_http_accept();
    // ptr should be a valid LP-string pointer pointing to an empty string
    expect(ptr).toBeGreaterThan(0);
    const result = readLengthPrefixedString(memory, ptr);
    expect(result).toBe('');
  });
});
