/**
 * _fs_write_bytes bridge — binary-safe atomic file write with allowlist
 *
 * Alignment: HOST_BRIDGE.md §File I/O, function-registry.toml entry
 * `_fs_write_bytes`. Mirrors the Rust-host coverage
 * (host-bridge/src/wasm_linker/file_io.rs).
 * Category: contract
 *
 * Covers the contract needed to un-stub the errors dashboard's
 * POST /api/v1/reports/tarball-upload endpoint on the Node runtime:
 *   - Byte fidelity: null bytes, 0xFF, gzip magic survive verbatim
 *   - Return-code taxonomy per HOST_BRIDGE.md (0/1/2/3/4/5)
 *   - Allowlist enforcement via CLEAN_FS_WRITE_ROOT
 *   - Atomic rename — no `.tmp` left after success OR failure
 *   - Parent directory creation and parent-is-file rejection
 *   - Overwrite semantics
 *   - Content-length parity against the LP buffer prefix
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createFsWriteBytesBridge } from '../src/bridge/fs-write-bytes';
import { writeLengthPrefixedBytes } from '../src/wasm/memory';
import type { WasmState } from '../src/types';

// ─── Return codes (mirrors bridge/fs-write-bytes.ts) ────────────────────────
const OK = 0;
const ERR_PERMISSION_DENIED = 1;
// const ERR_DISK_FULL = 2;  // Not exercised — hard to trigger portably.
const ERR_INVALID_PATH = 3;
const ERR_PARENT_NOT_DIR = 4;
// const ERR_IO = 5;         // Fallback; not exercised directly.

// ─── Harness ────────────────────────────────────────────────────────────────

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

function writeRawAt(memory: WebAssembly.Memory, ptr: number, str: string): number {
  const bytes = new TextEncoder().encode(str);
  new Uint8Array(memory.buffer).set(bytes, ptr);
  return bytes.length;
}

/**
 * Build a bridge instance plus the WASM-memory representation of the two
 * bridge arguments. Returns the numeric args to hand `_fs_write_bytes`
 * verbatim, plus the state (so tests can vary the heap layout if needed).
 */
function stagePath(memory: WebAssembly.Memory, str: string, at: number): {
  ptr: number;
  len: number;
} {
  const len = writeRawAt(memory, at, str);
  return { ptr: at, len };
}

let tmpRoot: string;
let previousEnvRoot: string | undefined;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-write-bytes-'));
  previousEnvRoot = process.env.CLEAN_FS_WRITE_ROOT;
  process.env.CLEAN_FS_WRITE_ROOT = tmpRoot;
});

afterEach(() => {
  if (previousEnvRoot === undefined) delete process.env.CLEAN_FS_WRITE_ROOT;
  else process.env.CLEAN_FS_WRITE_ROOT = previousEnvRoot;
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch { /* best-effort cleanup */ }
});

// ─── Byte fidelity ──────────────────────────────────────────────────────────

describe('_fs_write_bytes — byte fidelity', () => {
  it('preserves null bytes verbatim', () => {
    const memory = new WebAssembly.Memory({ initial: 4 });
    const state = makeMockState(memory);
    const bridge = createFsWriteBytesBridge(() => state);

    const payload = new Uint8Array([0x00, 0x01, 0x00, 0x00, 0xab, 0x00]);
    const bytesPtr = writeLengthPrefixedBytes(state.exports, payload);

    const file = 'null-bytes.bin';
    const p = stagePath(memory, file, 256);

    expect(bridge._fs_write_bytes(p.ptr, p.len, bytesPtr)).toBe(OK);
    const onDisk = fs.readFileSync(path.join(tmpRoot, file));
    expect(Array.from(onDisk)).toEqual(Array.from(payload));
  });

  it('preserves 0xFF and high bytes verbatim', () => {
    const memory = new WebAssembly.Memory({ initial: 4 });
    const state = makeMockState(memory);
    const bridge = createFsWriteBytesBridge(() => state);

    const payload = new Uint8Array([0xff, 0xfe, 0xfd, 0xc0, 0xc1, 0x80]);
    const bytesPtr = writeLengthPrefixedBytes(state.exports, payload);

    const file = 'high-bytes.bin';
    const p = stagePath(memory, file, 256);

    expect(bridge._fs_write_bytes(p.ptr, p.len, bytesPtr)).toBe(OK);
    const onDisk = fs.readFileSync(path.join(tmpRoot, file));
    expect(Array.from(onDisk)).toEqual(Array.from(payload));
  });

  it('preserves gzip magic (1f 8b 08) and gzipped body', () => {
    const memory = new WebAssembly.Memory({ initial: 4 });
    const state = makeMockState(memory);
    const bridge = createFsWriteBytesBridge(() => state);

    const gz = new Uint8Array(128);
    gz[0] = 0x1f;
    gz[1] = 0x8b;
    gz[2] = 0x08;
    for (let i = 3; i < gz.length; i++) gz[i] = (i * 53) & 0xff;
    const bytesPtr = writeLengthPrefixedBytes(state.exports, gz);

    const file = 'upload.tar.gz';
    const p = stagePath(memory, file, 256);

    expect(bridge._fs_write_bytes(p.ptr, p.len, bytesPtr)).toBe(OK);
    const onDisk = fs.readFileSync(path.join(tmpRoot, file));
    expect(onDisk[0]).toBe(0x1f);
    expect(onDisk[1]).toBe(0x8b);
    expect(onDisk[2]).toBe(0x08);
    expect(Array.from(onDisk)).toEqual(Array.from(gz));
  });

  it('zero-length write succeeds and creates an empty file', () => {
    const memory = new WebAssembly.Memory({ initial: 4 });
    const state = makeMockState(memory);
    const bridge = createFsWriteBytesBridge(() => state);

    const bytesPtr = writeLengthPrefixedBytes(state.exports, new Uint8Array(0));
    const file = 'empty.bin';
    const p = stagePath(memory, file, 256);

    expect(bridge._fs_write_bytes(p.ptr, p.len, bytesPtr)).toBe(OK);
    expect(fs.statSync(path.join(tmpRoot, file)).size).toBe(0);
  });

  it('size on disk equals the length prefix embedded in the LP buffer', () => {
    const memory = new WebAssembly.Memory({ initial: 4 });
    const state = makeMockState(memory);
    const bridge = createFsWriteBytesBridge(() => state);

    // 4 KB payload — enough that any accidental truncation or double-buffering
    // step would show up as a wrong on-disk size.
    const payload = new Uint8Array(4096);
    for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff;
    const bytesPtr = writeLengthPrefixedBytes(state.exports, payload);

    const file = 'sized.bin';
    const p = stagePath(memory, file, 256);
    expect(bridge._fs_write_bytes(p.ptr, p.len, bytesPtr)).toBe(OK);

    expect(fs.statSync(path.join(tmpRoot, file)).size).toBe(payload.length);
  });
});

// ─── Allowlist enforcement ──────────────────────────────────────────────────

describe('_fs_write_bytes — allowlist enforcement', () => {
  it('rejects with ERR_INVALID_PATH when CLEAN_FS_WRITE_ROOT is unset', () => {
    delete process.env.CLEAN_FS_WRITE_ROOT;

    const memory = new WebAssembly.Memory({ initial: 4 });
    const state = makeMockState(memory);
    const bridge = createFsWriteBytesBridge(() => state);

    const bytesPtr = writeLengthPrefixedBytes(state.exports, new Uint8Array([0x01]));
    const p = stagePath(memory, 'anywhere.bin', 256);

    expect(bridge._fs_write_bytes(p.ptr, p.len, bytesPtr)).toBe(ERR_INVALID_PATH);
  });

  it('rejects an absolute path outside CLEAN_FS_WRITE_ROOT', () => {
    const memory = new WebAssembly.Memory({ initial: 4 });
    const state = makeMockState(memory);
    const bridge = createFsWriteBytesBridge(() => state);

    const bytesPtr = writeLengthPrefixedBytes(state.exports, new Uint8Array([0x01]));
    // A sibling temp dir that is definitely NOT under CLEAN_FS_WRITE_ROOT.
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));
    const target = path.join(outside, 'escape.bin');
    const p = stagePath(memory, target, 256);

    expect(bridge._fs_write_bytes(p.ptr, p.len, bytesPtr)).toBe(ERR_INVALID_PATH);
    expect(fs.existsSync(target)).toBe(false);
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('rejects a path containing ".." even if it resolves inside the root', () => {
    const memory = new WebAssembly.Memory({ initial: 4 });
    const state = makeMockState(memory);
    const bridge = createFsWriteBytesBridge(() => state);

    const bytesPtr = writeLengthPrefixedBytes(state.exports, new Uint8Array([0x01]));
    // `sub/../file.bin` normalizes to `file.bin` inside root — resolve() would
    // let it through, but the raw-segment check must reject it on principle
    // (matches the Rust host's stricter policy).
    const p = stagePath(memory, 'sub/../file.bin', 256);

    expect(bridge._fs_write_bytes(p.ptr, p.len, bytesPtr)).toBe(ERR_INVALID_PATH);
  });

  it('rejects a path containing null bytes', () => {
    const memory = new WebAssembly.Memory({ initial: 4 });
    const state = makeMockState(memory);
    const bridge = createFsWriteBytesBridge(() => state);

    const bytesPtr = writeLengthPrefixedBytes(state.exports, new Uint8Array([0x01]));
    // Write the path bytes directly — writeRawAt via TextEncoder loses NULs.
    const raw = 'foo\0bar.bin';
    const encoded = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) encoded[i] = raw.charCodeAt(i);
    new Uint8Array(memory.buffer).set(encoded, 256);

    expect(bridge._fs_write_bytes(256, raw.length, bytesPtr)).toBe(ERR_INVALID_PATH);
  });

  it('rejects writes under /proc even when CLEAN_FS_WRITE_ROOT covers it', () => {
    // Force root = "/" to exercise the system-prefix guard. Even a misconfigured
    // root that technically allows everything must not let /proc through.
    process.env.CLEAN_FS_WRITE_ROOT = '/';

    const memory = new WebAssembly.Memory({ initial: 4 });
    const state = makeMockState(memory);
    const bridge = createFsWriteBytesBridge(() => state);

    const bytesPtr = writeLengthPrefixedBytes(state.exports, new Uint8Array([0x01]));
    const p = stagePath(memory, '/proc/self/mem', 256);

    expect(bridge._fs_write_bytes(p.ptr, p.len, bytesPtr)).toBe(ERR_INVALID_PATH);
    // Restore for the afterEach teardown.
    process.env.CLEAN_FS_WRITE_ROOT = tmpRoot;
  });
});

// ─── Atomicity & filesystem state ───────────────────────────────────────────

describe('_fs_write_bytes — atomic rename', () => {
  it('leaves no .tmp file behind after a successful write', () => {
    const memory = new WebAssembly.Memory({ initial: 4 });
    const state = makeMockState(memory);
    const bridge = createFsWriteBytesBridge(() => state);

    const bytesPtr = writeLengthPrefixedBytes(state.exports, new Uint8Array([0x01, 0x02]));
    const p = stagePath(memory, 'atomic.bin', 256);

    expect(bridge._fs_write_bytes(p.ptr, p.len, bytesPtr)).toBe(OK);
    expect(fs.existsSync(path.join(tmpRoot, 'atomic.bin'))).toBe(true);
    expect(fs.existsSync(path.join(tmpRoot, 'atomic.bin.tmp'))).toBe(false);
  });

  it('leaves no .tmp file behind after a failed rename', () => {
    const memory = new WebAssembly.Memory({ initial: 4 });
    const state = makeMockState(memory);
    const bridge = createFsWriteBytesBridge(() => state);

    // Pre-create a directory at the destination path — renameSync into an
    // existing non-empty directory fails on POSIX with ENOTDIR/EEXIST/EISDIR
    // depending on platform. Either way, the .tmp must not be left behind.
    const dest = path.join(tmpRoot, 'clash.bin');
    fs.mkdirSync(dest);
    fs.writeFileSync(path.join(dest, 'sentinel'), 'occupied');

    const bytesPtr = writeLengthPrefixedBytes(state.exports, new Uint8Array([0x01]));
    const p = stagePath(memory, 'clash.bin', 256);

    const rc = bridge._fs_write_bytes(p.ptr, p.len, bytesPtr);
    expect(rc).not.toBe(OK);
    expect(fs.existsSync(path.join(tmpRoot, 'clash.bin.tmp'))).toBe(false);
    // Original directory must be intact — atomic write did not clobber it
    // before the rename attempt.
    expect(fs.existsSync(path.join(dest, 'sentinel'))).toBe(true);
  });

  it('overwrites an existing file with new contents', () => {
    const memory = new WebAssembly.Memory({ initial: 4 });
    const state = makeMockState(memory);
    const bridge = createFsWriteBytesBridge(() => state);

    const target = path.join(tmpRoot, 'overwrite.bin');
    fs.writeFileSync(target, Buffer.from([0xaa, 0xbb, 0xcc, 0xdd, 0xee]));

    const newPayload = new Uint8Array([0x01, 0x02]);
    const bytesPtr = writeLengthPrefixedBytes(state.exports, newPayload);
    const p = stagePath(memory, 'overwrite.bin', 256);

    expect(bridge._fs_write_bytes(p.ptr, p.len, bytesPtr)).toBe(OK);
    const after = fs.readFileSync(target);
    expect(Array.from(after)).toEqual([0x01, 0x02]);
  });
});

// ─── Parent directory handling ──────────────────────────────────────────────

describe('_fs_write_bytes — parent directory', () => {
  it('creates missing intermediate directories (mkdir -p)', () => {
    const memory = new WebAssembly.Memory({ initial: 4 });
    const state = makeMockState(memory);
    const bridge = createFsWriteBytesBridge(() => state);

    const bytesPtr = writeLengthPrefixedBytes(state.exports, new Uint8Array([0x42]));
    const p = stagePath(memory, 'deep/nested/dir/file.bin', 256);

    expect(bridge._fs_write_bytes(p.ptr, p.len, bytesPtr)).toBe(OK);
    const contents = fs.readFileSync(path.join(tmpRoot, 'deep/nested/dir/file.bin'));
    expect(contents[0]).toBe(0x42);
  });

  it('returns ERR_PARENT_NOT_DIR when the parent path is a regular file', () => {
    const memory = new WebAssembly.Memory({ initial: 4 });
    const state = makeMockState(memory);
    const bridge = createFsWriteBytesBridge(() => state);

    // Create `parent` as a *file*, then attempt to write `parent/child.bin`.
    // mkdirSync(recursive: true) surfaces ENOTDIR which maps to code 4.
    fs.writeFileSync(path.join(tmpRoot, 'parent'), 'i am a file');

    const bytesPtr = writeLengthPrefixedBytes(state.exports, new Uint8Array([0x01]));
    const p = stagePath(memory, 'parent/child.bin', 256);

    expect(bridge._fs_write_bytes(p.ptr, p.len, bytesPtr)).toBe(ERR_PARENT_NOT_DIR);
  });
});

// ─── Permission-denied smoke check ──────────────────────────────────────────

describe('_fs_write_bytes — permission mapping', () => {
  // Skip when running as root — chmod-based read-only tests are meaningless
  // because root bypasses the mode bits. CI containers frequently run as
  // root; local dev usually does not.
  const runAsRoot = typeof process.getuid === 'function' && process.getuid() === 0;

  it.skipIf(runAsRoot)('maps EACCES to ERR_PERMISSION_DENIED when parent dir is 0o555', () => {
    const memory = new WebAssembly.Memory({ initial: 4 });
    const state = makeMockState(memory);
    const bridge = createFsWriteBytesBridge(() => state);

    const roDir = path.join(tmpRoot, 'ro');
    fs.mkdirSync(roDir);
    fs.chmodSync(roDir, 0o555);

    const bytesPtr = writeLengthPrefixedBytes(state.exports, new Uint8Array([0x01]));
    const p = stagePath(memory, 'ro/blocked.bin', 256);

    const rc = bridge._fs_write_bytes(p.ptr, p.len, bytesPtr);
    // Restore write permission so afterEach can clean up.
    fs.chmodSync(roDir, 0o755);

    expect(rc).toBe(ERR_PERMISSION_DENIED);
  });
});
