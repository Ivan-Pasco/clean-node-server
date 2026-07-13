#!/usr/bin/env node
// Standalone repro driver — runs one HTTP request through the real
// clean-node-server bridge without spinning up the HTTP server or a
// worker pool. Purpose: give upstream (compiler team) a deterministic
// local runner that reproduces host-visible bugs (truncation, traps,
// aliasing) with the exact byte-level output the production server
// would emit, plus optional forensic memory dumps.
//
// Why this exists:
//   - The `canary_driver.mjs` next to this file only invokes `_start`
//     and doesn't set up a request context, so it can't reproduce any
//     bug that manifests inside a route handler.
//   - Reproducing via the real HTTP server needs an Express boot, a
//     worker pool, and a session store — none of which the compiler
//     team needs. They need one thing: run the WASM handler, get the
//     bytes back, dump memory if it truncated.
//
// Contract:
//   node scripts/repro_http_request.mjs <wasm> --handler <exportName>
//                                       [--method GET|POST|...]
//                                       [--path /foo]
//                                       [--query key=val,key=val]
//                                       [--header 'Name: Value']  (repeatable)
//                                       [--body '...']
//                                       [--dump-memory <byteOffset>[:<len>]]
//                                       [--dump-hex-output]
//                                       [--json-output]
//                                       [--wat-out <path>]
//
// Exit codes:
//   0 — handler returned, response body captured
//   2 — arg / setup error
//   3 — LinkError at instantiate (missing bridge import)
//   4 — trap or handler threw
//
// The runner writes forensic output to stderr and the raw response
// body to stdout so the caller can pipe it directly:
//   node scripts/repro_http_request.mjs app.wasm --handler ... > body.html
//
// Compiler-side use case (bug #eed00ffee567, STATE A truncation V2):
//   1. Compile the tasks-list SSR page's minimal repro.
//   2. Point this script at the .wasm with --handler <route handler>
//      and --dump-memory near the truncation offset.
//   3. If truncation reproduces, --wat-out dumps the disassembled WAT
//      so the codegen path that emitted the aliasing hazard is visible.

import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const require = createRequire(import.meta.url);
const REPO_ROOT = resolve(__dirname, '..');

const bridgeIndex = require(resolve(REPO_ROOT, 'dist', 'bridge', 'index.js'));
const stateModule = require(resolve(REPO_ROOT, 'dist', 'wasm', 'state.js'));
const sessionStoreModule = require(resolve(REPO_ROOT, 'dist', 'session', 'store.js'));
const fileBridgeModule = require(resolve(REPO_ROOT, 'dist', 'bridge', 'file.js'));

const { createBridgeImports } = bridgeIndex;
const { createWasmState, setRequestContext, getResponse } = stateModule;
const { InMemorySessionStore } = sessionStoreModule;

fileBridgeModule.setSandboxRoot('/tmp');

function parseArgs(argv) {
  const args = { headers: {} };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (!args.wasm && !a.startsWith('--')) { args.wasm = a; i++; continue; }
    switch (a) {
      case '--handler': args.handler = argv[++i]; break;
      case '--method': args.method = argv[++i]; break;
      case '--path': args.path = argv[++i]; break;
      case '--body': args.body = argv[++i]; break;
      case '--query': args.query = argv[++i]; break;
      case '--header': {
        const raw = argv[++i];
        const idx = raw.indexOf(':');
        if (idx <= 0) { console.error(`bad --header: ${raw}`); process.exit(2); }
        args.headers[raw.slice(0, idx).trim()] = raw.slice(idx + 1).trim();
        break;
      }
      case '--dump-memory': args.dumpMemory = argv[++i]; break;
      case '--dump-hex-output': args.dumpHexOutput = true; break;
      case '--json-output': args.jsonOutput = true; break;
      case '--wat-out': args.watOut = argv[++i]; break;
      case '--help': case '-h': args.help = true; break;
      default: console.error(`unknown arg: ${a}`); process.exit(2);
    }
    i++;
  }
  return args;
}

function usage() {
  console.error(`Usage: node scripts/repro_http_request.mjs <wasm> --handler <exportName>
  [--method GET|POST|...] [--path /foo]
  [--query key=val,key=val] [--header 'Name: Value'] [--body '...']
  [--dump-memory <byteOffset>[:<len>]] [--dump-hex-output] [--json-output]
  [--wat-out <path>]

Stdout: raw response body bytes.
Stderr: forensic context (status, headers, byte counts, hex dumps).`);
}

function parseKV(s) {
  const out = {};
  if (!s) return out;
  for (const part of s.split(',')) {
    const idx = part.indexOf('=');
    if (idx > 0) out[part.slice(0, idx)] = part.slice(idx + 1);
  }
  return out;
}

function hexDump(bytes, base) {
  const lines = [];
  for (let off = 0; off < bytes.length; off += 16) {
    const chunk = bytes.slice(off, Math.min(off + 16, bytes.length));
    const hex = Array.from(chunk).map(b => b.toString(16).padStart(2, '0')).join(' ');
    const ascii = Array.from(chunk).map(b => (b >= 0x20 && b < 0x7f) ? String.fromCharCode(b) : '.').join('');
    lines.push(`${(base + off).toString(16).padStart(8, '0')}  ${hex.padEnd(48)}  |${ascii}|`);
  }
  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.wasm || !args.handler) { usage(); process.exit(args.help ? 0 : 2); }

  const wasmBytes = new Uint8Array(await readFile(args.wasm));

  // Optional wat-out — run wasm2wat if requested. Non-fatal if the tool is missing.
  if (args.watOut) {
    const w2w = spawnSync('wasm2wat', [args.wasm, '-o', args.watOut], { stdio: ['ignore', 'ignore', 'inherit'] });
    if (w2w.status === 0) {
      console.error(`[repro] wasm2wat -> ${args.watOut}`);
    } else {
      console.error(`[repro] wasm2wat unavailable or failed (status=${w2w.status}); skipping WAT dump`);
    }
  }

  const module = await WebAssembly.compile(wasmBytes.buffer);

  const config = {
    port: 0, host: '127.0.0.1', verbose: false,
    sessionSecret: 'repro-session-secret',
    jwtSecret: 'repro-jwt-secret',
    rateLimitMax: 0, rateLimitWindowMs: 60000, pgPoolSize: 1,
  };
  const sessionStore = new InMemorySessionStore();

  let state = null;
  const imports = createBridgeImports(() => {
    if (!state) throw new Error('[repro] state not initialized (bridge import called too early)');
    return state;
  });

  let instance;
  try {
    instance = await WebAssembly.instantiate(module, imports);
  } catch (err) {
    console.error(`[repro] instantiate failed: ${err && err.message ? err.message : err}`);
    if (err && err.stack) console.error(err.stack);
    process.exit(3);
  }

  state = createWasmState(instance, config, sessionStore, []);

  // Run module init (mirrors what request-worker.ts does).
  const exports = state.exports;
  try {
    if (typeof exports.start === 'function') exports.start();
    else if (typeof exports._start === 'function') exports._start();
  } catch (err) {
    console.error(`[repro] module init trapped: ${err && err.message ? err.message : err}`);
    if (err && err.stack) console.error(err.stack);
    process.exit(4);
  }

  const context = {
    method: (args.method || 'GET').toUpperCase(),
    path: args.path || '/',
    params: {},
    query: parseKV(args.query),
    headers: args.headers,
    body: args.body || '',
    cookies: {},
  };
  setRequestContext(state, context);

  const handler = exports[args.handler];
  if (typeof handler !== 'function') {
    const routeExports = Object.keys(exports).filter(k => k.startsWith('__route_handler_'));
    console.error(`[repro] handler '${args.handler}' not found. Available route exports:\n  ${routeExports.join('\n  ')}`);
    process.exit(2);
  }

  // Optional per-request scope (compiler ≥ 0.30.330).
  const scopePush = exports.scope_push;
  const scopePop = exports.scope_pop;
  const hasScopes = typeof scopePush === 'function' && typeof scopePop === 'function';
  const snapshot = hasScopes ? scopePush() : 0;

  let resultPtr = 0;
  let handlerErr = null;
  try {
    resultPtr = handler();
  } catch (err) {
    handlerErr = err;
  }

  // Read response bytes BEFORE any scope_pop (rewind detaches the address).
  const memory = exports.memory;
  const buffer = memory.buffer;

  const emitDumps = () => {
    if (!args.dumpMemory) return;
    const [offStr, lenStr] = args.dumpMemory.split(':');
    const off = parseInt(offStr, 10);
    const len = parseInt(lenStr || '128', 10);
    if (!Number.isFinite(off) || off < 0 || off >= buffer.byteLength) {
      console.error(`[repro] --dump-memory offset out of range: ${offStr} (buffer=${buffer.byteLength})`);
      return;
    }
    const end = Math.min(off + len, buffer.byteLength);
    const bytes = new Uint8Array(buffer, off, end - off);
    console.error(`[repro] memory dump @ ${off} (${end - off} bytes):`);
    console.error(hexDump(bytes, off));
  };

  if (handlerErr) {
    console.error(`[repro] handler '${args.handler}' trapped: ${handlerErr.message}`);
    if (handlerErr.stack) console.error(handlerErr.stack);
    emitDumps();
    process.exit(4);
  }

  let bodyBytes = new Uint8Array(0);
  let bodyText = state.response.body || '';
  let bodyLenPrefix = null;
  if (resultPtr > 0) {
    const view = new DataView(buffer);
    if (resultPtr + 4 > buffer.byteLength) {
      console.error(`[repro] handler returned ptr=${resultPtr} past buffer end (${buffer.byteLength})`);
      emitDumps();
      process.exit(4);
    }
    bodyLenPrefix = view.getUint32(resultPtr, true);
    if (resultPtr + 4 + bodyLenPrefix > buffer.byteLength) {
      console.error(`[repro] handler returned truncated LP-string: ptr=${resultPtr} len=${bodyLenPrefix} buffer=${buffer.byteLength}`);
      emitDumps();
      process.exit(4);
    }
    bodyBytes = new Uint8Array(buffer.slice(resultPtr + 4, resultPtr + 4 + bodyLenPrefix));
    bodyText = new TextDecoder('utf-8').decode(bodyBytes);
  } else if (bodyText) {
    bodyBytes = new TextEncoder().encode(bodyText);
  }

  const response = getResponse(state);

  console.error(`[repro] handler=${args.handler} method=${context.method} path=${context.path}`);
  console.error(`[repro] status=${response.status}  content-type=${response.headers['Content-Type'] || ''}`);
  console.error(`[repro] result_ptr=${resultPtr}  lp_prefix_len=${bodyLenPrefix}  body_bytes=${bodyBytes.length}  body_chars=${bodyText.length}`);

  if (args.dumpHexOutput) {
    console.error(`[repro] response body hex:`);
    console.error(hexDump(bodyBytes, 0));
  }

  emitDumps();

  if (hasScopes) {
    try { scopePop(snapshot); } catch { /* rewind failure — not fatal for repro */ }
  }

  if (args.jsonOutput) {
    process.stdout.write(JSON.stringify({
      status: response.status,
      headers: response.headers,
      body: bodyText,
      bodyBytes: Array.from(bodyBytes),
      resultPtr,
      lpPrefixLen: bodyLenPrefix,
    }));
  } else {
    process.stdout.write(bodyBytes);
  }
}

main().catch((err) => {
  console.error(`[repro] fatal: ${err && err.stack ? err.stack : err}`);
  process.exit(4);
});
