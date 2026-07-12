/**
 * File bridge tests — sandbox enforcement + CRUD contracts.
 *
 * Coverage priorities (see system-documents/test-strategy.md § "file.ts"):
 *  - Path traversal must be blocked (`..` / absolute paths outside sandbox).
 *  - Read/write/append/exists/delete/size/list/mkdir/rmdir/copy/rename
 *    must return the documented codes (0/1 for success, -1 or "" for
 *    denial or IO error).
 *  - Sandbox root can be swapped via setSandboxRoot without process side-effects.
 *  - Binary read/write goes through base64 correctly.
 *
 * All I/O runs against a per-test tmpdir; no real project files are touched.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  createFileBridge,
  setSandboxRoot,
  getSandboxRoot,
} from '../src/bridge/file';
import { readLengthPrefixedString } from '../src/wasm/memory';
import type { WasmState } from '../src/types';

// ─── Test helpers ───────────────────────────────────────────────────────────

function writeRawAt(memory: WebAssembly.Memory, ptr: number, str: string): number {
  const bytes = new TextEncoder().encode(str);
  new Uint8Array(memory.buffer).set(bytes, ptr);
  return bytes.length;
}

function makeMockState(memory: WebAssembly.Memory, heapStart: number): WasmState {
  let heapPtr = heapStart;
  const exports = {
    memory,
    malloc: (size: number): number => {
      const ptr = heapPtr;
      heapPtr += size + 4;
      return ptr;
    },
  } as unknown as WasmState['exports'];
  return { exports, config: { verbose: false } } as unknown as WasmState;
}

describe('File bridge — sandbox guard', () => {
  let tmpDir: string;
  let priorSandbox: string;
  let memory: WebAssembly.Memory;
  let state: WasmState;
  let bridge: ReturnType<typeof createFileBridge>;

  const ADDR_PATH = 64;
  const ADDR_DATA = 65_536;
  const HEAP_START = 131_072;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cns-file-'));
    priorSandbox = getSandboxRoot();
    setSandboxRoot(tmpDir);
    memory = new WebAssembly.Memory({ initial: 4 });
    state = makeMockState(memory, HEAP_START);
    bridge = createFileBridge(() => state);
  });

  afterEach(() => {
    setSandboxRoot(priorSandbox);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('setSandboxRoot resolves and normalises', () => {
    const before = getSandboxRoot();
    expect(before).toBe(path.resolve(tmpDir));
  });

  it('read returns "" when path traverses outside sandbox', () => {
    const evil = '../../../etc/passwd';
    const pathLen = writeRawAt(memory, ADDR_PATH, evil);
    const ptr = bridge.file_read(ADDR_PATH, pathLen);
    expect(readLengthPrefixedString(memory, ptr)).toBe('');
  });

  it('write returns -1 for traversal path', () => {
    const evil = '../../../../tmp/pwned';
    const p = writeRawAt(memory, ADDR_PATH, evil);
    const d = writeRawAt(memory, ADDR_DATA, 'payload');
    const rc = bridge.file_write(ADDR_PATH, p, ADDR_DATA, d);
    expect(rc).toBe(-1);
  });

  it('delete returns -1 for traversal path', () => {
    const evil = '../poison';
    const p = writeRawAt(memory, ADDR_PATH, evil);
    expect(bridge.file_delete(ADDR_PATH, p)).toBe(-1);
  });

  it('exists returns 0 for traversal path (does not leak fs presence)', () => {
    const p = writeRawAt(memory, ADDR_PATH, '../../etc/passwd');
    expect(bridge.file_exists(ADDR_PATH, p)).toBe(0);
  });
});

describe('File bridge — CRUD round-trips', () => {
  let tmpDir: string;
  let priorSandbox: string;
  let memory: WebAssembly.Memory;
  let state: WasmState;
  let bridge: ReturnType<typeof createFileBridge>;

  const ADDR_PATH = 64;
  const ADDR_DATA = 65_536;
  const ADDR_PATH2 = 4096;
  const HEAP_START = 131_072;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cns-file-'));
    priorSandbox = getSandboxRoot();
    setSandboxRoot(tmpDir);
    memory = new WebAssembly.Memory({ initial: 4 });
    state = makeMockState(memory, HEAP_START);
    bridge = createFileBridge(() => state);
  });

  afterEach(() => {
    setSandboxRoot(priorSandbox);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('write → exists → read returns exact content (UTF-8)', () => {
    const rel = 'sub/hello.txt';
    const body = 'héllo — 世界';
    const p = writeRawAt(memory, ADDR_PATH, rel);
    const d = writeRawAt(memory, ADDR_DATA, body);

    expect(bridge.file_write(ADDR_PATH, p, ADDR_DATA, d)).toBe(0);
    expect(bridge.file_exists(ADDR_PATH, p)).toBe(1);
    const readPtr = bridge.file_read(ADDR_PATH, p);
    expect(readLengthPrefixedString(memory, readPtr)).toBe(body);
  });

  it('append extends existing file', () => {
    const rel = 'log.txt';
    const p = writeRawAt(memory, ADDR_PATH, rel);
    const first = writeRawAt(memory, ADDR_DATA, 'A\n');
    const second = writeRawAt(memory, ADDR_DATA + 512, 'B\n');

    expect(bridge.file_write(ADDR_PATH, p, ADDR_DATA, first)).toBe(0);
    expect(bridge.file_append(ADDR_PATH, p, ADDR_DATA + 512, second)).toBe(0);

    const readPtr = bridge.file_read(ADDR_PATH, p);
    expect(readLengthPrefixedString(memory, readPtr)).toBe('A\nB\n');
  });

  it('file_size returns byte length after write; -1 for missing', () => {
    const rel = 'size.bin';
    const body = 'x'.repeat(1234);
    const p = writeRawAt(memory, ADDR_PATH, rel);
    const d = writeRawAt(memory, ADDR_DATA, body);
    bridge.file_write(ADDR_PATH, p, ADDR_DATA, d);
    expect(bridge.file_size(ADDR_PATH, p)).toBe(1234);

    const pMissing = writeRawAt(memory, ADDR_PATH2, 'missing.bin');
    expect(bridge.file_size(ADDR_PATH2, pMissing)).toBe(-1);
  });

  it('mkdir + is_directory + list_dir + rmdir cycle', () => {
    const dirRel = 'newdir';
    const p = writeRawAt(memory, ADDR_PATH, dirRel);
    expect(bridge.file_mkdir(ADDR_PATH, p)).toBe(0);
    expect(bridge.file_is_directory(ADDR_PATH, p)).toBe(1);

    // Write two files inside
    const f1 = writeRawAt(memory, ADDR_PATH2, 'newdir/a.txt');
    const d1 = writeRawAt(memory, ADDR_DATA, 'a');
    bridge.file_write(ADDR_PATH2, f1, ADDR_DATA, d1);
    const f2 = writeRawAt(memory, ADDR_PATH2 + 128, 'newdir/b.txt');
    const d2 = writeRawAt(memory, ADDR_DATA + 128, 'b');
    bridge.file_write(ADDR_PATH2 + 128, f2, ADDR_DATA + 128, d2);

    const listPtr = bridge.file_list_dir(ADDR_PATH, p);
    const listJson = readLengthPrefixedString(memory, listPtr);
    const entries = JSON.parse(listJson) as string[];
    expect(new Set(entries)).toEqual(new Set(['a.txt', 'b.txt']));

    // rmdir should succeed recursively
    expect(bridge.file_rmdir(ADDR_PATH, p)).toBe(0);
    expect(bridge.file_is_directory(ADDR_PATH, p)).toBe(0);
  });

  it('copy duplicates content; rename moves atomically', () => {
    const srcRel = 'orig.txt';
    const dstRel = 'copy.txt';
    const movedRel = 'moved.txt';

    const pSrc = writeRawAt(memory, ADDR_PATH, srcRel);
    const pDst = writeRawAt(memory, ADDR_PATH2, dstRel);
    const pMoved = writeRawAt(memory, ADDR_PATH2 + 128, movedRel);
    const d = writeRawAt(memory, ADDR_DATA, 'payload');

    bridge.file_write(ADDR_PATH, pSrc, ADDR_DATA, d);
    expect(bridge.file_copy(ADDR_PATH, pSrc, ADDR_PATH2, pDst)).toBe(0);
    expect(bridge.file_exists(ADDR_PATH, pSrc)).toBe(1);
    expect(bridge.file_exists(ADDR_PATH2, pDst)).toBe(1);

    expect(bridge.file_rename(ADDR_PATH2, pDst, ADDR_PATH2 + 128, pMoved)).toBe(0);
    expect(bridge.file_exists(ADDR_PATH2, pDst)).toBe(0);
    expect(bridge.file_exists(ADDR_PATH2 + 128, pMoved)).toBe(1);
  });

  it('read_binary / write_binary preserve raw bytes via base64', () => {
    const rel = 'bin.dat';
    const raw = Buffer.from([0x00, 0x01, 0xff, 0x80, 0x7f]);
    const b64 = raw.toString('base64');
    const p = writeRawAt(memory, ADDR_PATH, rel);
    const d = writeRawAt(memory, ADDR_DATA, b64);

    expect(bridge.file_write_binary(ADDR_PATH, p, ADDR_DATA, d)).toBe(0);

    const readPtr = bridge.file_read_binary(ADDR_PATH, p);
    const backB64 = readLengthPrefixedString(memory, readPtr);
    expect(backB64).toBe(b64);
    expect(Buffer.from(backB64, 'base64').equals(raw)).toBe(true);
  });

  it('delete removes file; delete of missing returns -1', () => {
    const rel = 'goodbye.txt';
    const p = writeRawAt(memory, ADDR_PATH, rel);
    const d = writeRawAt(memory, ADDR_DATA, 'bye');
    bridge.file_write(ADDR_PATH, p, ADDR_DATA, d);
    expect(bridge.file_delete(ADDR_PATH, p)).toBe(0);
    expect(bridge.file_exists(ADDR_PATH, p)).toBe(0);
    expect(bridge.file_delete(ADDR_PATH, p)).toBe(-1);
  });
});
