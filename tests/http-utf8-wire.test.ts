/**
 * Wire-level UTF-8 contract — pins what bytes Express actually sends.
 *
 * NSR002 production symptom: response body contains U+FFFD where multibyte
 * UTF-8 chars (em-dash E2 80 94) should be. The bridge round-trip passes
 * (tests/utf8-roundtrip.test.ts), so any remaining corruption would have to
 * be in the HTTP response pipeline: res.type / res.send / compression
 * middleware / Express's setCharset on responses that already have a
 * Content-Type set by the route handler.
 *
 * This test stands up the same Express setup the server uses (compression,
 * cookieParser, security headers stub) and verifies the exact bytes on the
 * wire match the canonical UTF-8 encoding of the input string for every
 * supported Content-Type path used by the bridge.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express, { type Request, type Response } from 'express';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { gunzipSync, brotliDecompressSync, inflateSync } from 'zlib';

const STRINGS = [
  'Tutorials — Learn Clean Language',
  'Item 0 — track →',
  'Smart "quotes" ‘single’',
  '世界、こんにちは',
  'Café résumé piñata',
  '🦀 Rust + 🟢 Node',
];

function buildApp() {
  const app = express();
  app.use(compression());
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));
  app.use(cookieParser());
  app.use(express.text({ type: 'text/*', limit: '10mb' }));

  app.all('/echo', (req: Request, res: Response) => {
    const contentType = (req.query.ct as string) || 'text/plain';
    const body = req.query.body as string;
    res.type(contentType);
    res.status(200).send(body);
  });
  return app;
}

function decodeWireBytes(buf: Buffer, contentEncoding: string | null): Buffer {
  if (!contentEncoding) return buf;
  if (contentEncoding === 'gzip') return gunzipSync(buf);
  if (contentEncoding === 'br') return brotliDecompressSync(buf);
  if (contentEncoding === 'deflate') return inflateSync(buf);
  throw new Error(`Unsupported Content-Encoding: ${contentEncoding}`);
}

async function fetchBytes(
  base: string,
  path: string,
  acceptEncoding?: string,
): Promise<{ status: number; contentType: string | null; bodyBytes: Buffer }> {
  const url = `${base}${path}`;
  const headers: Record<string, string> = {};
  if (acceptEncoding !== undefined) headers['Accept-Encoding'] = acceptEncoding;
  const res = await fetch(url, { headers });
  const ce = res.headers.get('content-encoding');
  const ct = res.headers.get('content-type');
  const raw = Buffer.from(await res.arrayBuffer());
  return { status: res.status, contentType: ct, bodyBytes: decodeWireBytes(raw, ce) };
}

describe('Express response pipeline preserves multibyte UTF-8 on the wire', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const app = buildApp();
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const port = (server.address() as AddressInfo).port;
    base = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  describe.each(['text/plain', 'text/html', 'application/json'])(
    'Content-Type %s',
    (contentType) => {
      it.each(STRINGS)('preserves "%s" without compression', async (str) => {
        const path = `/echo?ct=${encodeURIComponent(contentType)}&body=${encodeURIComponent(str)}`;
        const { status, contentType: ct, bodyBytes } = await fetchBytes(base, path, 'identity');
        expect(status).toBe(200);
        expect(ct ?? '').toContain(contentType);
        const decoded = new TextDecoder('utf-8').decode(bodyBytes);
        expect(decoded).toBe(str);
        expect(decoded).not.toMatch(/�/);
        expect(bodyBytes.equals(Buffer.from(str, 'utf-8'))).toBe(true);
      });

      it.each(STRINGS)('preserves "%s" with gzip compression', async (str) => {
        const path = `/echo?ct=${encodeURIComponent(contentType)}&body=${encodeURIComponent(str)}`;
        const { status, bodyBytes } = await fetchBytes(base, path, 'gzip');
        expect(status).toBe(200);
        const decoded = new TextDecoder('utf-8').decode(bodyBytes);
        expect(decoded).toBe(str);
        expect(decoded).not.toMatch(/�/);
      });

      it.each(STRINGS)('preserves "%s" with br compression', async (str) => {
        const path = `/echo?ct=${encodeURIComponent(contentType)}&body=${encodeURIComponent(str)}`;
        const { status, bodyBytes } = await fetchBytes(base, path, 'br');
        expect(status).toBe(200);
        const decoded = new TextDecoder('utf-8').decode(bodyBytes);
        expect(decoded).toBe(str);
        expect(decoded).not.toMatch(/�/);
      });
    },
  );

  it('Content-Type without charset still emits UTF-8 bytes (Express setCharset path)', async () => {
    const str = 'Tutorials — Learn Clean Language';
    const path = `/echo?ct=text%2Fplain&body=${encodeURIComponent(str)}`;
    const { contentType, bodyBytes } = await fetchBytes(base, path, 'identity');

    expect(contentType).toMatch(/text\/plain/);
    expect(bodyBytes.equals(Buffer.from(str, 'utf-8'))).toBe(true);
  });

  it('30-row simulated render: each multibyte body returns intact', async () => {
    const items = Array.from({ length: 30 }, (_, i) => `Item ${i} — track →`);
    for (const str of items) {
      const path = `/echo?ct=text%2Fplain&body=${encodeURIComponent(str)}`;
      const { bodyBytes } = await fetchBytes(base, path, 'gzip');
      const decoded = new TextDecoder('utf-8').decode(bodyBytes);
      expect(decoded).toBe(str);
      expect(decoded).not.toMatch(/�/);
    }
  });
});
