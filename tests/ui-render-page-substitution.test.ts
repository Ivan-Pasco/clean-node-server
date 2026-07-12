/**
 * _ui_render_page — template substitution contract tests.
 *
 * Spec (HOST_BRIDGE.md line 419, frame.ui plugin.toml, ssr-page-with-islands
 * pattern): substitution uses single-brace `{ key }` with internal whitespace
 * tolerated. Dotted paths resolve against JSON data; missing keys collapse
 * to empty string. Literal braces are emitted with `{{` → `{` and `}}` → `}`.
 *
 * Bug NODE-SERVER-UI-RENDER-PAGE-NO-SUBSTITUTION (fp 25fc3e8a23…): the previous
 * implementation used double-brace `{{ key }}`, which meant every companion
 * page served raw templates because frame.ui's compiler-emitted templates use
 * single-brace. Fixed in v0.1.89 by aligning with HOST_BRIDGE.md.
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

describe('_ui_render_page — { key } substitution (NODE-SERVER-UI-RENDER-PAGE-NO-SUBSTITUTION)', () => {
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

  it('substitutes `{ key }` with internal whitespace (spec form)', () => {
    writePage('hello.html', '<h1>{ greeting }</h1>');
    expect(render('hello.html', { greeting: 'Hello world' })).toBe('<h1>Hello world</h1>');
  });

  it('substitutes `{key}` with no whitespace', () => {
    writePage('hello.html', '<h1>{greeting}</h1>');
    expect(render('hello.html', { greeting: 'Hi' })).toBe('<h1>Hi</h1>');
  });

  it('substitutes `{   key   }` with extra whitespace', () => {
    writePage('hello.html', '[{   key   }]');
    expect(render('hello.html', { key: 'value' })).toBe('[value]');
  });

  it('substitutes missing keys with empty string', () => {
    writePage('hello.html', 'a{ missing }b');
    expect(render('hello.html', { other: 'x' })).toBe('ab');
  });

  it('substitutes dotted paths (`{ user.name }`)', () => {
    writePage('hello.html', '<p>Hello, { user.name }!</p>');
    expect(render('hello.html', { user: { name: 'Ada' } })).toBe('<p>Hello, Ada!</p>');
  });

  it('renders multiple placeholders in one template', () => {
    writePage('hello.html', '<h1>Hello, { name }!</h1><p>You are { role }.</p>');
    expect(render('hello.html', { name: 'Ada', role: 'admin' })).toBe(
      '<h1>Hello, Ada!</h1><p>You are admin.</p>'
    );
  });

  it('renders null and number values (null → empty, numbers/booleans → toString)', () => {
    writePage('hello.html', '[{ a }][{ b }][{ c }]');
    expect(render('hello.html', { a: null, b: 42, c: true })).toBe('[][42][true]');
  });

  it('leaves an unterminated `{` as literal text', () => {
    writePage('hello.html', 'before { never_closed');
    expect(render('hello.html', { x: 'y' })).toBe('before { never_closed');
  });

  it('escapes literal braces: `{{` → `{`, `}}` → `}`', () => {
    writePage('hello.html', 'css: .cls {{ color: red; }}');
    expect(render('hello.html', {})).toBe('css: .cls { color: red; }');
  });

  it('escapes do not consume adjacent placeholders', () => {
    writePage('hello.html', '{{ name: { name } }}');
    expect(render('hello.html', { name: 'Ada' })).toBe('{ name: Ada }');
  });

  it('leaves braces spanning newlines as literal (not a placeholder)', () => {
    writePage('hello.html', '<style>.x {\n  color: red;\n}</style>');
    expect(render('hello.html', {})).toBe('<style>.x {\n  color: red;\n}</style>');
  });

  it('renders the reproducer from the bug report (index.html with lang/title/heading)', () => {
    // Reduced version of the reproducer in bug fp 25fc3e8a23…
    writePage(
      'index.html',
      '<!DOCTYPE html>\n<html lang="{ lang }">\n<head><title>{ title }</title></head>\n<body><h1>{ heading }</h1></body>\n</html>\n'
    );
    const out = render('index.html', { lang: 'en', title: 'Home', heading: 'Hello world' });
    expect(out).toBe(
      '<!DOCTYPE html>\n<html lang="en">\n<head><title>Home</title></head>\n<body><h1>Hello world</h1></body>\n</html>\n'
    );
  });

  it('cl-iterate expands scoped `{item.field}` placeholders per-iteration', () => {
    // Directives run BEFORE top-level substitution. The iterate directive
    // replaces its host element with the expanded body (no wrapper preserved).
    writePage(
      'list.html',
      '<ul><span cl-iterate="item in items">[{item.title}]</span></ul>'
    );
    const out = render('list.html', { items: [{ title: 'one' }, { title: 'two' }] });
    expect(out).toBe('<ul>[one][two]</ul>');
  });

  it('cl-iterate + top-level placeholders coexist', () => {
    // Note: cl-iterate replaces the host element with its expanded inner
    // content (the wrapper tag is not preserved) — matches the existing
    // contract for the sibling `[{item.title}]` test above.
    writePage(
      'list.html',
      '<h1>{ title }</h1><ul><span cl-iterate="item in items">[{item}]</span></ul>'
    );
    const out = render('list.html', { title: 'Fruits', items: ['apple', 'pear'] });
    expect(out).toBe('<h1>Fruits</h1><ul>[apple][pear]</ul>');
  });

  it('still blocks path traversal', () => {
    writePage('hello.html', '<h1>{ x }</h1>');
    expect(render('../etc/passwd', { x: 'pwn' })).toBe('');
  });
});
