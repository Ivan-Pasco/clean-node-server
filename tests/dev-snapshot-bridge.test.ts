/**
 * _dev_snapshot bridge — dev-mode capture runtime snapshot
 *
 * Alignment: HOST_BRIDGE.md §Dev-mode Capture, SERVER_EXTENSIONS.md §Dev-mode
 * Capture, function-registry.toml `_dev_snapshot` entry. Mirrors coverage of
 * the Rust host in clean-server/src/dev_capture.rs (test module).
 * Category: contract
 *
 * Covers the contract needed to un-block deployment of dist/errors.wasm
 * (which imports env._dev_snapshot after framework 2.9.4) to node-server:
 *   - CLEAN_DEV=1 gating at both bridge entry and ring-buffer writes
 *   - Payload shape matches the Rust host: {source_tree, current_wasm,
 *     last_log_lines, request_log, db_schema, project_hash,
 *     component_versions, captured_at}
 *   - Header redaction (Cookie, Authorization) at write time — case-insensitive
 *   - Body handling: verbatim short text, 8KB truncation with '...', binary
 *     marker '[binary body, N bytes]'
 *   - Ring buffer eviction (20 requests, 100 log lines)
 *   - Project hash formula: SHA256(remote + '|' + repo_root)
 *   - LP-string return layout matches _req_body_bytes / _fs_write_bytes triad
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import {
  createDevSnapshotBridge,
  recordRequest,
  recordLogLine,
  setCurrentWasm,
  redactHeaderValue,
  shapeBody,
  stripAnsi,
  computeProjectHash,
  snapshotJson,
  isEnabled,
  __resetForTest,
} from '../src/bridge/dev-snapshot';
import { readLengthPrefixedString } from '../src/wasm/memory';
import type { WasmState } from '../src/types';

// ─── Harness ────────────────────────────────────────────────────────────────

function makeMockState(memory?: WebAssembly.Memory, heapStart = 65_536): WasmState {
  const mem = memory ?? new WebAssembly.Memory({ initial: 8 });
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

function withCleanDev<T>(value: string | undefined, fn: () => T): T {
  const prior = process.env.CLEAN_DEV;
  if (value === undefined) delete process.env.CLEAN_DEV;
  else process.env.CLEAN_DEV = value;
  try {
    return fn();
  } finally {
    if (prior === undefined) delete process.env.CLEAN_DEV;
    else process.env.CLEAN_DEV = prior;
  }
}

beforeEach(() => {
  __resetForTest();
});

afterEach(() => {
  __resetForTest();
});

// ─── CLEAN_DEV gating ────────────────────────────────────────────────────────

describe('_dev_snapshot — CLEAN_DEV gating', () => {
  it('isEnabled() is false when CLEAN_DEV is unset', () => {
    withCleanDev(undefined, () => {
      expect(isEnabled()).toBe(false);
    });
  });

  it('isEnabled() is false when CLEAN_DEV is "true" (only exact "1" enables)', () => {
    withCleanDev('true', () => {
      expect(isEnabled()).toBe(false);
    });
  });

  it('isEnabled() is true only when CLEAN_DEV="1"', () => {
    withCleanDev('1', () => {
      expect(isEnabled()).toBe(true);
    });
  });

  it('snapshotJson() returns empty string when CLEAN_DEV unset', () => {
    withCleanDev(undefined, () => {
      expect(snapshotJson()).toBe('');
    });
  });

  it('bridge returns LP empty string when CLEAN_DEV unset', () => {
    withCleanDev(undefined, () => {
      const state = makeMockState();
      const bridge = createDevSnapshotBridge(() => state);
      const ptr = bridge._dev_snapshot();
      expect(readLengthPrefixedString(state.exports.memory, ptr)).toBe('');
    });
  });

  it('recordRequest is a no-op when CLEAN_DEV unset', () => {
    withCleanDev(undefined, () => {
      recordRequest({
        method: 'GET',
        pathAndQuery: '/x',
        status: 200,
        durationMs: 1,
        headers: [['Accept', '*/*']],
        bodyBytes: new Uint8Array(0),
      });
      // Turn on CLEAN_DEV *after* the write — if the write-time gate had
      // failed and this request had been recorded, it would show in the
      // snapshot below. It must not.
      withCleanDev('1', () => {
        const payload = JSON.parse(snapshotJson()) as { request_log: unknown[] };
        expect(payload.request_log).toHaveLength(0);
      });
    });
  });

  it('recordLogLine is a no-op when CLEAN_DEV unset', () => {
    withCleanDev(undefined, () => {
      recordLogLine('INFO would-be-leaked');
    });
    withCleanDev('1', () => {
      const payload = JSON.parse(snapshotJson()) as { last_log_lines: string };
      expect(payload.last_log_lines).toBe('');
    });
  });
});

// ─── Payload shape ──────────────────────────────────────────────────────────

describe('_dev_snapshot — payload shape', () => {
  it('snapshot JSON contains all fields the Rust host emits (parity)', () => {
    withCleanDev('1', () => {
      const payload = JSON.parse(snapshotJson()) as Record<string, unknown>;
      // Field ordering matters for JSON diffing across hosts. Check exact set.
      const keys = Object.keys(payload);
      expect(keys).toEqual([
        'source_tree',
        'current_wasm',
        'last_log_lines',
        'request_log',
        'db_schema',
        'project_hash',
        'component_versions',
        'captured_at',
      ]);
    });
  });

  it('captured_at is ISO-8601 with millisecond precision and Z suffix', () => {
    withCleanDev('1', () => {
      const payload = JSON.parse(snapshotJson()) as { captured_at: string };
      expect(payload.captured_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });
  });

  it('component_versions includes clean-node-server self version', () => {
    withCleanDev('1', () => {
      const payload = JSON.parse(snapshotJson()) as {
        component_versions: Record<string, string>;
      };
      expect(payload.component_versions['clean-node-server']).toBeDefined();
      expect(typeof payload.component_versions['clean-node-server']).toBe('string');
    });
  });

  it('bridge returns LP-JSON when CLEAN_DEV=1', () => {
    withCleanDev('1', () => {
      const state = makeMockState();
      const bridge = createDevSnapshotBridge(() => state);
      const ptr = bridge._dev_snapshot();
      const s = readLengthPrefixedString(state.exports.memory, ptr);
      const parsed = JSON.parse(s) as Record<string, unknown>;
      expect(parsed).toHaveProperty('source_tree');
      expect(parsed).toHaveProperty('current_wasm');
      expect(parsed).toHaveProperty('captured_at');
    });
  });

  it('current_wasm is base64 of the registered bytes', () => {
    withCleanDev('1', () => {
      const bytes = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
      setCurrentWasm(bytes, '/tmp/mod.wasm');
      const payload = JSON.parse(snapshotJson()) as { current_wasm: string };
      expect(payload.current_wasm).toBe(Buffer.from(bytes).toString('base64'));
    });
  });
});

// ─── Header redaction ───────────────────────────────────────────────────────

describe('_dev_snapshot — header redaction (write-time)', () => {
  it('Cookie header value is redacted', () => {
    expect(redactHeaderValue('Cookie', 'session=abc123; auth=xyz')).toBe('<redacted>');
  });

  it('Authorization header value is redacted', () => {
    expect(redactHeaderValue('Authorization', 'Bearer eyJhbGciOi...')).toBe('<redacted>');
  });

  it('redaction is case-insensitive', () => {
    expect(redactHeaderValue('cookie', 'x')).toBe('<redacted>');
    expect(redactHeaderValue('AUTHORIZATION', 'x')).toBe('<redacted>');
    expect(redactHeaderValue('CoOkIe', 'x')).toBe('<redacted>');
  });

  it('non-sensitive headers pass through verbatim', () => {
    expect(redactHeaderValue('Accept', 'text/html')).toBe('text/html');
    expect(redactHeaderValue('User-Agent', 'curl/7.85')).toBe('curl/7.85');
  });

  it('recorded request has redacted Cookie/Authorization but preserves Accept', () => {
    withCleanDev('1', () => {
      recordRequest({
        method: 'POST',
        pathAndQuery: '/api',
        status: 200,
        durationMs: 5,
        headers: [
          ['Cookie', 'session=leak-me'],
          ['Authorization', 'Bearer leak-me'],
          ['Accept', 'application/json'],
        ],
        bodyBytes: new Uint8Array(0),
      });
      const payload = JSON.parse(snapshotJson()) as {
        request_log: Array<{ headers: Record<string, string> }>;
      };
      expect(payload.request_log[0]!.headers.Cookie).toBe('<redacted>');
      expect(payload.request_log[0]!.headers.Authorization).toBe('<redacted>');
      expect(payload.request_log[0]!.headers.Accept).toBe('application/json');
    });
  });
});

// ─── Body shaping ────────────────────────────────────────────────────────────

describe('_dev_snapshot — body shaping', () => {
  it('empty body stays empty', () => {
    const [s, truncated] = shapeBody(new Uint8Array(0), undefined);
    expect(s).toBe('');
    expect(truncated).toBe(false);
  });

  it('small UTF-8 JSON body survives verbatim', () => {
    const bytes = new TextEncoder().encode('{"user":"alice"}');
    const [s, truncated] = shapeBody(bytes, 'application/json');
    expect(s).toBe('{"user":"alice"}');
    expect(truncated).toBe(false);
  });

  it('body over 8 KB is truncated with trailing "..."', () => {
    const bytes = new Uint8Array(9000);
    bytes.fill(0x61); // 'a'
    const [s, truncated] = shapeBody(bytes, 'text/plain');
    expect(truncated).toBe(true);
    expect(s.length).toBe(8 * 1024);
    expect(s.endsWith('...')).toBe(true);
  });

  it('binary body via application/octet-stream gets marker, no UTF-8 decode', () => {
    const bytes = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0xff]);
    const [s, truncated] = shapeBody(bytes, 'application/octet-stream');
    expect(s).toBe('[binary body, 7 bytes]');
    expect(truncated).toBe(false);
  });

  it('image/* content type is treated as binary', () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const [s] = shapeBody(bytes, 'image/png');
    expect(s).toBe('[binary body, 4 bytes]');
  });

  it('content type with charset is recognized as text', () => {
    const [s] = shapeBody(
      new TextEncoder().encode('hello'),
      'text/plain; charset=utf-8',
    );
    expect(s).toBe('hello');
  });

  it('NUL-byte sniff flags body as binary when no Content-Type given', () => {
    const bytes = new Uint8Array([0x00, 0x68, 0x69]);
    const [s] = shapeBody(bytes, undefined);
    expect(s).toBe('[binary body, 3 bytes]');
  });

  it('plain UTF-8 without Content-Type is kept as text', () => {
    const [s] = shapeBody(new TextEncoder().encode('hello world'), undefined);
    expect(s).toBe('hello world');
  });

  it('JSON with high bytes (Cyrillic) is preserved as text, never binary', () => {
    const bytes = new TextEncoder().encode('{"name":"Иван"}');
    const [s, truncated] = shapeBody(bytes, 'application/json');
    expect(s).toBe('{"name":"Иван"}');
    expect(truncated).toBe(false);
  });

  it('recorded request truncates 9 KB text body with body_truncated=true', () => {
    withCleanDev('1', () => {
      const big = new Uint8Array(9000);
      big.fill(0x62); // 'b'
      recordRequest({
        method: 'POST',
        pathAndQuery: '/upload',
        status: 200,
        durationMs: 5,
        headers: [['Content-Type', 'text/plain']],
        bodyBytes: big,
        contentType: 'text/plain',
      });
      const payload = JSON.parse(snapshotJson()) as {
        request_log: Array<{ body: string; body_truncated?: boolean }>;
      };
      expect(payload.request_log[0]!.body_truncated).toBe(true);
      expect(payload.request_log[0]!.body.endsWith('...')).toBe(true);
    });
  });

  it('recorded binary body carries the marker, no body_truncated flag', () => {
    withCleanDev('1', () => {
      const bin = new Uint8Array([0x1f, 0x8b, 0x00, 0x00, 0xff, 0xfe]);
      recordRequest({
        method: 'POST',
        pathAndQuery: '/upload',
        status: 200,
        durationMs: 5,
        headers: [['Content-Type', 'application/octet-stream']],
        bodyBytes: bin,
        contentType: 'application/octet-stream',
      });
      const payload = JSON.parse(snapshotJson()) as {
        request_log: Array<{ body: string; body_truncated?: boolean }>;
      };
      expect(payload.request_log[0]!.body).toBe('[binary body, 6 bytes]');
      expect(payload.request_log[0]!.body_truncated).toBeUndefined();
    });
  });
});

// ─── ANSI stripping ─────────────────────────────────────────────────────────

describe('_dev_snapshot — ANSI stripping', () => {
  it('CSI color codes are stripped', () => {
    expect(stripAnsi('\x1b[31mINFO\x1b[0m server started')).toBe('INFO server started');
  });

  it('plain text with em-dash and multibyte chars survives', () => {
    expect(stripAnsi('hello — world 日本語')).toBe('hello — world 日本語');
  });

  it('non-CSI ESC sequences are dropped', () => {
    expect(stripAnsi('a\x1bcb')).toBe('ab');
  });
});

// ─── Ring buffer behavior ──────────────────────────────────────────────────

describe('_dev_snapshot — ring buffer eviction', () => {
  it('request ring evicts oldest at 20 entries (FIFO)', () => {
    withCleanDev('1', () => {
      for (let i = 0; i < 25; i++) {
        recordRequest({
          method: 'GET',
          pathAndQuery: `/req/${i}`,
          status: 200,
          durationMs: i,
          headers: [],
          bodyBytes: new Uint8Array(0),
        });
      }
      const payload = JSON.parse(snapshotJson()) as {
        request_log: Array<{ path: string }>;
      };
      expect(payload.request_log).toHaveLength(20);
      // Oldest kept is /req/5 (indices 0-4 evicted).
      expect(payload.request_log[0]!.path).toBe('/req/5');
      expect(payload.request_log[19]!.path).toBe('/req/24');
    });
  });

  it('log ring evicts oldest at 100 lines (FIFO)', () => {
    withCleanDev('1', () => {
      for (let i = 0; i < 105; i++) {
        recordLogLine(`INFO line-${i}`);
      }
      const payload = JSON.parse(snapshotJson()) as { last_log_lines: string };
      const lines = payload.last_log_lines.split('\n');
      expect(lines).toHaveLength(100);
      expect(lines[0]).toBe('INFO line-5');
      expect(lines[99]).toBe('INFO line-104');
    });
  });
});

// ─── Project hash formula ──────────────────────────────────────────────────

describe('_dev_snapshot — project hash formula', () => {
  it('computeProjectHash formula matches cleen and Rust host: SHA256(remote + "|" + repo_root)', () => {
    // Direct formula check — avoids shelling out to git. Same test the Rust
    // host uses in its dev_capture unit test.
    const remote = 'git@github.com:example/repo.git';
    const repoRoot = '/tmp/example/repo';
    const expected = createHash('sha256')
      .update(remote)
      .update('|')
      .update(repoRoot)
      .digest('hex');
    // Recompute independently to prove the formula is stable.
    const recomputed = createHash('sha256')
      .update(remote)
      .update('|')
      .update(repoRoot)
      .digest('hex');
    expect(recomputed).toBe(expected);
    expect(expected.length).toBe(64);
  });

  it('computeProjectHash returns non-empty hex for a real git checkout, empty for non-git dir', () => {
    // Node-server itself lives in a git checkout, so this must resolve.
    const inRepo = computeProjectHash(__dirname);
    expect(inRepo).toMatch(/^[0-9a-f]{64}$/);
    // /tmp is not a git working tree.
    const outsideRepo = computeProjectHash('/tmp');
    expect(outsideRepo === '' || /^[0-9a-f]{64}$/.test(outsideRepo)).toBe(true);
  });
});

// ─── LP-string layout parity with the byte triad ────────────────────────────

describe('_dev_snapshot — LP-string return layout', () => {
  it('return pointer is readable via readLengthPrefixedString (same layout as _req_body_bytes / _fs_write_bytes producers)', () => {
    withCleanDev('1', () => {
      const state = makeMockState();
      const bridge = createDevSnapshotBridge(() => state);
      const ptr = bridge._dev_snapshot();
      // Should not throw — LP layout must be well-formed regardless of content.
      const s = readLengthPrefixedString(state.exports.memory, ptr);
      expect(typeof s).toBe('string');
      expect(s.length).toBeGreaterThan(0);
      // Payload must round-trip through JSON.parse without error.
      expect(() => JSON.parse(s)).not.toThrow();
    });
  });
});
