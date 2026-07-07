import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readRawString, readLengthPrefixedString } from '../src/wasm/memory';

/**
 * NODE-SERVER-STRING-READ-OOB-INTERMITTENT
 *
 * When a WASM caller passes a nonsense (ptr, len) pair — typically because
 * stale bump-allocator bytes got misread as a length prefix — node-server
 * must throw AND log forensic context: the bytes actually at ptr, the
 * length reinterpreted as ASCII (so ops can recognize leaked strings), and
 * a stack trace pointing to the bridge function that passed the garbage.
 *
 * Silent throws made past occurrences unreproducible.
 */
describe('OOB forensics', () => {
  let memory: WebAssembly.Memory;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    memory = new WebAssembly.Memory({ initial: 1 }); // 64KB
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  describe('readRawString', () => {
    it('logs bytes at ptr, ASCII-reinterpreted len, and stack on OOB', () => {
      // Plant recognizable bytes at ptr so ops can see what leaked.
      const bytes = new Uint8Array(memory.buffer);
      bytes.set([0x48, 0x49, 0x21, 0x00], 100); // "HI!\0"

      // len = 1_684_632_162 (LE bytes: 0x62 0x72 0x69 0x64 = "brid") — the
      // exact value reported in the production bug, revealing that stale
      // string bytes were misread as a length prefix.
      expect(() => readRawString(memory, 100, 1_684_632_162)).toThrow(
        /String read out of bounds/,
      );

      expect(errorSpy).toHaveBeenCalledTimes(1);
      const [msg, ctx] = errorSpy.mock.calls[0] as [string, Record<string, unknown>];
      expect(msg).toContain('String read out of bounds');
      expect(ctx).toMatchObject({
        ptr: 100,
        len: 1_684_632_162,
        bufferSize: memory.buffer.byteLength,
      });
      expect(ctx.bytesAtPtr).toContain('48 49 21 00');
      expect(ctx.lenAsAscii).toBe('brid');
      expect(typeof ctx.stack).toBe('string');
      expect((ctx.stack as string).length).toBeGreaterThan(0);
    });

    it('does not log or throw on legitimate reads', () => {
      const enc = new TextEncoder().encode('ok');
      new Uint8Array(memory.buffer).set(enc, 100);

      expect(readRawString(memory, 100, enc.length)).toBe('ok');
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it('handles ptr past buffer end without crashing the diagnostic itself', () => {
      const farOutPtr = memory.buffer.byteLength + 10;
      expect(() => readRawString(memory, farOutPtr, 4)).toThrow(
        /String read out of bounds/,
      );
      const [, ctx] = errorSpy.mock.calls[0] as [string, Record<string, unknown>];
      expect(ctx.bytesAtPtr).toBe('(ptr past buffer end)');
    });
  });

  describe('readLengthPrefixedString', () => {
    it('logs forensic context when the length prefix is impossibly large', () => {
      const view = new DataView(memory.buffer);
      // Length prefix = 1_684_632_162 (ASCII "bmnd") at ptr 100.
      view.setUint32(100, 1_684_632_162, true);

      expect(() => readLengthPrefixedString(memory, 100)).toThrow(
        /Invalid string length/,
      );

      expect(errorSpy).toHaveBeenCalledTimes(1);
      const [msg, ctx] = errorSpy.mock.calls[0] as [string, Record<string, unknown>];
      expect(msg).toContain('Invalid string length prefix');
      expect(ctx).toMatchObject({
        ptr: 100,
        len: 1_684_632_162,
      });
      expect(ctx.lenAsAscii).toBe('brid');
    });
  });
});
