/**
 * _ui_render_page — template substitution contract tests.
 *
 * The spec at HOST_BRIDGE.md line 404 and function-registry.toml line 2647 mandates
 * `{{ key }}` substitution with internal whitespace tolerated and missing keys
 * collapsing to empty string. This matches the clean-server (Rust) sibling host,
 * which rewrote substitute_template as a single-pass `{{ … }}` scanner in v1.9.57.
 *
 * Bug NODE-SERVER-UI-RENDER-PAGE-INTERP-STRICT-WHITESPACE (fp ccafd1f2c004): the
 * previous regex `/\{([\w.]+)\}/g` only matched single-brace `{key}` with no
 * internal whitespace, so spec-compliant `{{ key }}` templates rendered literal
 * placeholder text. Single-brace `{key}` matching is also wrong because it
 * collides with the cl-iterate directive's `{item.field}` placeholders.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createUiBridge } from '../src/bridge/ui';
import { readLengthPrefixedString } from '../src/wasm/memory';
import type { WasmState } from '../src/types';

function writeRawAt(memory: WebAssembly.Memory, ptr: number, str: string): number {
  const bytes = new TextEncoder().encode(str);
  new Uint8Array(memory.buffer).set(bytes, ptr);
  return bytes.length;
}

function makeMockState(memory: WebAssembly.Memory, heapStart: number, projectRoot: string): WasmState {
  let heapPtr = heapStart;
  const exports = {
    memory,
    malloc: (size: number): number => {
      const ptr = heapPtr;
      heapPtr += size + 4;
      return ptr;
    },
  } as unknown as WasmState['exports'];
  return {
    exports,
    config: { verbose: false },
    projectRoot,
  } as unknown as WasmState;
}

describe('_ui_render_page — {{ key }} substitution (NODE-SERVER-UI-RENDER-PAGE-INTERP-STRICT-WHITESPACE)', () => {
  let tmpDir: string;
  let memory: WebAssembly.Memory;
  let state: WasmState;
  let bridge: ReturnType<typeof createUiBridge>;

  const ADDR_PATH = 64;
  const ADDR_DATA = 65_536;
  const HEAP_START = 131_072;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cns-ui-render-'));
    memory = new WebAssembly.Memory({ initial: 4 });
    state = makeMockState(memory, HEAP_START, tmpDir);
    bridge = createUiBridge(() => state);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writePage(relPath: string, html: string): void {
    const abs = path.join(tmpDir, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, html, 'utf8');
  }

  function render(relPath: string, data: unknown): string {
    const pathLen = writeRawAt(memory, ADDR_PATH, relPath);
    const dataJson = JSON.stringify(data);
    const dataLen = writeRawAt(memory, ADDR_DATA, dataJson);
    const resultPtr = bridge._ui_render_page(ADDR_PATH, pathLen, ADDR_DATA, dataLen);
    return readLengthPrefixedString(memory, resultPtr);
  }

  it('substitutes `{{ key }}` with internal whitespace (spec form)', () => {
    writePage('hello.html', '<h1>{{ greeting }}</h1>');
    expect(render('hello.html', { greeting: 'Hello world' })).toBe('<h1>Hello world</h1>');
  });

  it('substitutes `{{key}}` with no whitespace', () => {
    writePage('hello.html', '<h1>{{greeting}}</h1>');
    expect(render('hello.html', { greeting: 'Hi' })).toBe('<h1>Hi</h1>');
  });

  it('substitutes `{{   key   }}` with extra whitespace', () => {
    writePage('hello.html', '[{{   key   }}]');
    expect(render('hello.html', { key: 'value' })).toBe('[value]');
  });

  it('substitutes missing keys with empty string', () => {
    writePage('hello.html', 'a{{ missing }}b');
    expect(render('hello.html', { other: 'x' })).toBe('ab');
  });

  it('substitutes dotted paths (`{{ user.name }}`)', () => {
    writePage('hello.html', '<p>Hello, {{ user.name }}!</p>');
    expect(render('hello.html', { user: { name: 'Ada' } })).toBe('<p>Hello, Ada!</p>');
  });

  it('does NOT substitute single-brace `{key}` (reserved for cl-iterate)', () => {
    writePage('hello.html', '<li>{name}</li>');
    expect(render('hello.html', { name: 'Ada' })).toBe('<li>{name}</li>');
  });

  it('renders multiple placeholders in one template', () => {
    writePage('hello.html', '<h1>Hello, {{ name }}!</h1><p>You are {{ role }}.</p>');
    expect(render('hello.html', { name: 'Ada', role: 'admin' })).toBe(
      '<h1>Hello, Ada!</h1><p>You are admin.</p>'
    );
  });

  it('renders null and number values', () => {
    writePage('hello.html', '[{{ a }}][{{ b }}][{{ c }}]');
    expect(render('hello.html', { a: null, b: 42, c: true })).toBe('[][42][true]');
  });

  it('leaves an unterminated `{{` as literal text', () => {
    writePage('hello.html', 'before {{ never_closed');
    expect(render('hello.html', { x: 'y' })).toBe('before {{ never_closed');
  });

  it('cl-iterate `{item.field}` placeholders survive substitute_template', () => {
    // substitute_template runs first; the iterate directive then expands the inner
    // template. If substitute_template consumed `{item.title}` as a top-level key
    // miss, the iterate body would be blank. processIterateDirective replaces the
    // host element with its expanded inner content (no wrapper preserved).
    writePage(
      'list.html',
      '<ul><span cl-iterate="item in items">[{item.title}]</span></ul>'
    );
    const out = render('list.html', { items: [{ title: 'one' }, { title: 'two' }] });
    expect(out).toBe('<ul>[one][two]</ul>');
  });

  it('still blocks path traversal', () => {
    writePage('hello.html', '<h1>{{ x }}</h1>');
    expect(render('../etc/passwd', { x: 'pwn' })).toBe('');
  });
});
