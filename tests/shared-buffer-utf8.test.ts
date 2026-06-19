/**
 * SharedArrayBuffer / Uint8Array.slice() multibyte UTF-8 contract.
 *
 * The mysql worker IPC path passes JSON-encoded query results through a
 * SharedArrayBuffer using:
 *   - worker:  encoder.encode(JSON.stringify(response)) → dataBuf.set(bytes);
 *              Atomics.store(ctrl, 1, bytes.length)
 *   - main:    respLen = Atomics.load(ctrl, 1);
 *              decoder.decode(dataBuf.slice(0, respLen))
 *
 * If those steps mismatch on byte-vs-char count, or if Uint8Array.slice on a
 * SharedArrayBuffer corrupts multibyte sequences, json.get's input string
 * arrives mangled before the bridge ever sees it. This test pins the round-
 * trip so any future change there breaks loudly.
 */

import { describe, it, expect } from 'vitest';

const STRINGS = [
  'Tutorials — Learn Clean Language',
  'Item 0 — track →',
  '世界、こんにちは',
  'Café résumé piñata',
  '🦀 Rust + 🟢 Node',
];

describe('SharedArrayBuffer + encoder/decoder preserve multibyte UTF-8', () => {
  it.each(STRINGS)('round-trips "%s" through worker IPC pattern', (str) => {
    const sab = new SharedArrayBuffer(64 * 1024);
    const ctrl = new Int32Array(new SharedArrayBuffer(16));
    const dataBuf = new Uint8Array(sab);

    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    const json = JSON.stringify({ ok: true, data: { rows: [{ title: str }], count: 1 } });
    const bytes = encoder.encode(json);
    dataBuf.set(bytes);
    Atomics.store(ctrl, 1, bytes.length);

    const respLen = Atomics.load(ctrl, 1);
    const decoded = decoder.decode(dataBuf.slice(0, respLen));
    const parsed = JSON.parse(decoded) as { data: { rows: { title: string }[] } };

    expect(parsed.data.rows[0].title).toBe(str);
    expect(parsed.data.rows[0].title).not.toMatch(/�/);
  });

  it('handles 30 rows of multibyte titles in a single payload', () => {
    const sab = new SharedArrayBuffer(64 * 1024);
    const ctrl = new Int32Array(new SharedArrayBuffer(16));
    const dataBuf = new Uint8Array(sab);

    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    const rows = Array.from({ length: 30 }, (_, i) => ({ title: `Item ${i} — track →` }));
    const json = JSON.stringify({ ok: true, data: { rows, count: 30 } });
    const bytes = encoder.encode(json);
    dataBuf.set(bytes);
    Atomics.store(ctrl, 1, bytes.length);

    const respLen = Atomics.load(ctrl, 1);
    const decoded = decoder.decode(dataBuf.slice(0, respLen));
    const parsed = JSON.parse(decoded) as { data: { rows: { title: string }[] } };

    for (let i = 0; i < 30; i++) {
      expect(parsed.data.rows[i].title).toBe(`Item ${i} — track →`);
      expect(parsed.data.rows[i].title).not.toMatch(/�/);
    }
  });

  it('handles consecutive payloads in same SharedArrayBuffer without leakage', () => {
    const sab = new SharedArrayBuffer(64 * 1024);
    const ctrl = new Int32Array(new SharedArrayBuffer(16));
    const dataBuf = new Uint8Array(sab);

    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    const longStr = 'a very long initial payload — '.repeat(50);
    const longJson = JSON.stringify({ ok: true, data: { rows: [{ title: longStr }], count: 1 } });
    const longBytes = encoder.encode(longJson);
    dataBuf.set(longBytes);
    Atomics.store(ctrl, 1, longBytes.length);

    Atomics.load(ctrl, 1);
    decoder.decode(dataBuf.slice(0, Atomics.load(ctrl, 1)));

    const shortStr = 'Tutorials — Learn';
    const shortJson = JSON.stringify({ ok: true, data: { rows: [{ title: shortStr }], count: 1 } });
    const shortBytes = encoder.encode(shortJson);
    dataBuf.set(shortBytes);
    Atomics.store(ctrl, 1, shortBytes.length);

    const respLen = Atomics.load(ctrl, 1);
    const decoded = decoder.decode(dataBuf.slice(0, respLen));
    const parsed = JSON.parse(decoded) as { data: { rows: { title: string }[] } };

    expect(parsed.data.rows[0].title).toBe(shortStr);
    expect(parsed.data.rows[0].title).not.toMatch(/�/);
  });
});
