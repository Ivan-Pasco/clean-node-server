import { describe, it, expect, beforeEach } from 'vitest';
import {
  readLengthPrefixedString,
  readRawString,
  readI32,
  readF64,
  writeI32,
  writeF64,
  getStringByteLength,
} from '../src/wasm/memory';

describe('Memory Utilities', () => {
  let memory: WebAssembly.Memory;

  beforeEach(() => {
    // Create a fresh memory instance for each test
    memory = new WebAssembly.Memory({ initial: 1 }); // 64KB
  });

  describe('readLengthPrefixedString', () => {
    it('should read a simple ASCII string', () => {
      const view = new DataView(memory.buffer);
      const text = 'Hello, World!';
      const bytes = new TextEncoder().encode(text);

      // Write length prefix (4 bytes, little-endian)
      view.setUint32(100, bytes.length, true);
      // Write string bytes
      new Uint8Array(memory.buffer).set(bytes, 104);

      const result = readLengthPrefixedString(memory, 100);
      expect(result).toBe(text);
    });

    it('should read an empty string', () => {
      const view = new DataView(memory.buffer);
      view.setUint32(100, 0, true);

      const result = readLengthPrefixedString(memory, 100);
      expect(result).toBe('');
    });

    it('should return empty string for null pointer', () => {
      const result = readLengthPrefixedString(memory, 0);
      expect(result).toBe('');
    });

    it('should handle UTF-8 characters', () => {
      const view = new DataView(memory.buffer);
      const text = 'Hello, 世界! 🌍';
      const bytes = new TextEncoder().encode(text);

      view.setUint32(100, bytes.length, true);
      new Uint8Array(memory.buffer).set(bytes, 104);

      const result = readLengthPrefixedString(memory, 100);
      expect(result).toBe(text);
    });
  });

  describe('readRawString', () => {
    it('should read a raw string without length prefix', () => {
      const text = 'Test String';
      const bytes = new TextEncoder().encode(text);

      new Uint8Array(memory.buffer).set(bytes, 200);

      const result = readRawString(memory, 200, bytes.length);
      expect(result).toBe(text);
    });

    it('should return empty string for zero length', () => {
      const result = readRawString(memory, 200, 0);
      expect(result).toBe('');
    });

    it('should return empty string for null pointer', () => {
      const result = readRawString(memory, 0, 10);
      expect(result).toBe('');
    });
  });

  describe('readI32', () => {
    it('should read a positive integer', () => {
      const view = new DataView(memory.buffer);
      view.setInt32(300, 42, true);

      const result = readI32(memory, 300);
      expect(result).toBe(42);
    });

    it('should read a negative integer', () => {
      const view = new DataView(memory.buffer);
      view.setInt32(300, -123, true);

      const result = readI32(memory, 300);
      expect(result).toBe(-123);
    });

    it('should read zero', () => {
      const view = new DataView(memory.buffer);
      view.setInt32(300, 0, true);

      const result = readI32(memory, 300);
      expect(result).toBe(0);
    });
  });

  describe('readF64', () => {
    it('should read a floating point number', () => {
      const view = new DataView(memory.buffer);
      view.setFloat64(400, 3.14159, true);

      const result = readF64(memory, 400);
      expect(result).toBeCloseTo(3.14159, 5);
    });

    it('should read negative floats', () => {
      const view = new DataView(memory.buffer);
      view.setFloat64(400, -123.456, true);

      const result = readF64(memory, 400);
      expect(result).toBeCloseTo(-123.456, 3);
    });
  });

  describe('writeI32', () => {
    it('should write an integer to memory', () => {
      writeI32(memory, 500, 999);

      const view = new DataView(memory.buffer);
      expect(view.getInt32(500, true)).toBe(999);
    });
  });

  describe('writeF64', () => {
    it('should write a float to memory', () => {
      writeF64(memory, 600, 2.71828);

      const view = new DataView(memory.buffer);
      expect(view.getFloat64(600, true)).toBeCloseTo(2.71828, 5);
    });
  });

  describe('getStringByteLength', () => {
    it('should return byte length for ASCII', () => {
      expect(getStringByteLength('hello')).toBe(5);
    });

    it('should return correct byte length for UTF-8', () => {
      // 世界 is 6 bytes in UTF-8 (3 bytes per character)
      expect(getStringByteLength('世界')).toBe(6);
    });

    it('should return correct byte length for emoji', () => {
      // 🌍 is 4 bytes in UTF-8
      expect(getStringByteLength('🌍')).toBe(4);
    });

    it('should return 0 for empty string', () => {
      expect(getStringByteLength('')).toBe(0);
    });
  });
});
