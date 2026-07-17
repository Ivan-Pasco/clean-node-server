import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'child_process';
import { WasmState } from '../types';
import { writeString } from './helpers';

/**
 * Dev-mode Capture — Runtime Snapshot for `/_debug/capture` on node-server.
 *
 * Mirror of `clean-server/src/dev_capture.rs`. Implements the `_dev_snapshot`
 * host bridge and two ring buffers (last 20 requests, last 100 log lines).
 * See foundation/platform-architecture/SERVER_EXTENSIONS.md §Dev-mode Capture
 * for the payload contract shared with the Rust host.
 *
 * Security boundary: the entire surface is gated on `CLEAN_DEV=1`. When the
 * variable is unset or any other value, `snapshotJson()` returns an empty
 * string and the ring-buffer writers become no-ops. Production servers must
 * not expose any of this data via any code path.
 *
 * Redaction of sensitive headers (Cookie, Authorization) happens at write
 * time so a code path that skips the read-side redactor cannot leak
 * credentials — the ring buffer never stores the real values.
 *
 * Scope note: on node-server the WASM handler runs inside a Node worker
 * thread (see src/workers/request-worker.ts). The ring buffers are worker-
 * local module state; each worker sees the requests it handled and its own
 * stdout/stderr. The Rust host uses a single process so this distinction
 * doesn't arise there. Dev-mode is single-user by design, so worker-local
 * capture is acceptable — the framework's /_debug/capture endpoint reads
 * whichever worker fielded its own request.
 */

/** Maximum bytes of request body kept in the ring buffer per entry. */
const REQUEST_BODY_MAX_BYTES = 8 * 1024;

/** Number of stderr/stdout log lines kept in the ring buffer. */
const LOG_LINES_MAX = 100;

/** Number of request entries kept in the ring buffer. */
const REQUEST_LOG_MAX = 20;

/** Cap for embedded WASM (raw bytes, before base64). */
const CURRENT_WASM_MAX_BYTES = 8 * 1024 * 1024;

/** Cap for the source_tree walk. */
const SOURCE_TREE_MAX_FILES = 200;
const SOURCE_TREE_MAX_DEPTH = 4;

/** Directory names to skip during the source_tree walk. */
const SKIP_DIRS = new Set(['.git', 'target', 'node_modules', 'tests']);

/**
 * CLEAN_DEV must equal exactly `"1"` for capture to be active. Any other
 * value (including `"true"`, `"yes"`, empty string, unset) is treated as
 * production. Read every call so operators can flip the env var without
 * restarting the worker.
 */
export function isEnabled(): boolean {
  return process.env.CLEAN_DEV === '1';
}

interface RequestEntry {
  method: string;
  path: string;
  status: number;
  duration_ms: number;
  captured_at: string;
  headers: Record<string, string>;
  body: string;
  /** Present only when body was cut at REQUEST_BODY_MAX_BYTES. */
  body_truncated?: true;
}

const requestLog: RequestEntry[] = [];
const logLines: string[] = [];
let currentWasmBytes: Uint8Array | null = null;
let currentWasmPath: string | null = null;

/**
 * Register the WASM bytes for the currently-loaded module. Called once at
 * worker startup so `_dev_snapshot` can base64 the raw bytes without having
 * to re-read them from disk (the file may have moved).
 */
export function setCurrentWasm(bytes: Uint8Array, filePath?: string): void {
  currentWasmBytes = bytes;
  currentWasmPath = filePath ?? null;
}

/**
 * Record a completed HTTP request into the ring buffer. Redaction and body
 * truncation happen here at write time so a reader that skips redaction
 * cannot leak credentials. No-op when CLEAN_DEV is not `"1"`.
 */
export function recordRequest(entry: {
  method: string;
  pathAndQuery: string;
  status: number;
  durationMs: number;
  headers: Array<[string, string]>;
  bodyBytes: Uint8Array;
  contentType?: string;
}): void {
  if (!isEnabled()) return;

  const headers: Record<string, string> = {};
  for (const [name, value] of entry.headers) {
    const out = redactHeaderValue(name, value);
    // RFC 7230: merge duplicates by comma-joining.
    if (headers[name] !== undefined) {
      headers[name] = `${headers[name]}, ${out}`;
    } else {
      headers[name] = out;
    }
  }

  const [bodyStr, truncated] = shapeBody(entry.bodyBytes, entry.contentType);

  const record: RequestEntry = {
    method: entry.method.toUpperCase(),
    path: entry.pathAndQuery,
    status: entry.status,
    duration_ms: entry.durationMs,
    captured_at: isoWithMs(new Date()),
    headers,
    body: bodyStr,
  };
  if (truncated) record.body_truncated = true;

  if (requestLog.length === REQUEST_LOG_MAX) requestLog.shift();
  requestLog.push(record);
}

/**
 * Append a formatted stderr/stdout line into the ring buffer. Stored without
 * a trailing newline; ANSI escapes stripped. No-op when CLEAN_DEV is not `"1"`.
 */
export function recordLogLine(line: string): void {
  if (!isEnabled()) return;
  const cleaned = stripAnsi(line);
  if (logLines.length === LOG_LINES_MAX) logLines.shift();
  logLines.push(cleaned);
}

/**
 * Install console.log / console.error / console.warn / stderr interception
 * so every line produced by the worker or the WASM print bridge flows into
 * the log ring buffer. Dev-mode-gated: safe to always call at worker startup;
 * when CLEAN_DEV is not `"1"`, this is a no-op so production pays zero cost.
 *
 * Idempotent — subsequent calls are ignored.
 */
let interceptorsInstalled = false;
export function installLogInterceptor(): void {
  if (!isEnabled()) return;
  if (interceptorsInstalled) return;
  interceptorsInstalled = true;

  const wrap = (
    original: (...args: unknown[]) => void,
    level: string,
  ): ((...args: unknown[]) => void) => {
    return (...args: unknown[]) => {
      try {
        const line = args
          .map((a) => (typeof a === 'string' ? a : safeInspect(a)))
          .join(' ');
        recordLogLine(`${level} ${line}`);
      } catch {
        // Never let logging failures break the caller.
      }
      original(...args);
    };
  };

  const origLog = console.log.bind(console);
  const origErr = console.error.bind(console);
  const origWarn = console.warn.bind(console);
  console.log = wrap(origLog, 'INFO');
  console.error = wrap(origErr, 'ERROR');
  console.warn = wrap(origWarn, 'WARN');
}

/**
 * Reset both ring buffers to an empty state. Exposed so tests start each case
 * from a deterministic baseline. Production callers have no reason to reset
 * the ring buffers mid-flight — the leading double underscore signals this
 * is not part of the stable public API.
 */
export function __resetForTest(): void {
  requestLog.length = 0;
  logLines.length = 0;
  currentWasmBytes = null;
  currentWasmPath = null;
  interceptorsInstalled = false;
}

/**
 * Produce the JSON payload consumed by the framework's `/_debug/capture`
 * handler. Returns the empty string when CLEAN_DEV is unset — the framework
 * treats that as "not in dev mode" and responds 404.
 */
export function snapshotJson(): string {
  if (!isEnabled()) return '';

  const root = projectRoot();
  const sourceTree = walkSourceTree(root);
  const currentWasm = readCurrentWasmB64();
  const lastLogLines = logLines.join('\n');
  const requestLogCopy = requestLog.map((r) => ({ ...r }));
  // Populated only when a DB driver exposes SHOW CREATE TABLE — matches the
  // Rust host's current behavior (documented `""` when no DB attached).
  const dbSchema = '';
  const projectHashValue = computeProjectHash(root);
  const componentVersions = snapshotComponentVersions();
  const capturedAt = isoWithMs(new Date());

  // Field ordering must match clean-server/src/dev_capture.rs so the
  // framework's DSL wrapper sees identical JSON structure from both hosts.
  const payload = {
    source_tree: sourceTree,
    current_wasm: currentWasm,
    last_log_lines: lastLogLines,
    request_log: requestLogCopy,
    db_schema: dbSchema,
    project_hash: projectHashValue,
    component_versions: componentVersions,
    captured_at: capturedAt,
  };

  return JSON.stringify(payload);
}

// ─── Bridge factory ──────────────────────────────────────────────────────────

/**
 * Create the dev-snapshot bridge.
 *
 * Exposes `_dev_snapshot() -> ptr`, returning a length-prefixed JSON string
 * (or an empty LP string when CLEAN_DEV is not `"1"`). Payload shape and
 * field ordering match clean-server's Rust implementation exactly.
 */
export function createDevSnapshotBridge(getState: () => WasmState) {
  return {
    _dev_snapshot(): number {
      const state = getState();
      // snapshotJson() applies the CLEAN_DEV gate itself; when disabled it
      // returns `""` and writeString writes an LP empty string. This is the
      // signal the framework's DSL wrapper uses to 404 the endpoint.
      return writeString(state, snapshotJson());
    },
  };
}

// ─── Redaction and body shaping ──────────────────────────────────────────────

/**
 * Replace Cookie / Authorization values with `<redacted>` before the ring
 * buffer sees the real value. Case-insensitive header name match.
 */
export function redactHeaderValue(name: string, value: string): string {
  const lower = name.toLowerCase();
  if (lower === 'cookie' || lower === 'authorization') return '<redacted>';
  return value;
}

const BINARY_CONTENT_TYPES = new Set([
  'application/octet-stream',
  'application/pdf',
  'application/zip',
  'application/gzip',
  'application/x-gzip',
  'application/x-tar',
]);

const BINARY_PREFIXES = ['image/', 'audio/', 'video/'];

const TEXT_PREFIXES = ['text/'];
const TEXT_EXACT = new Set([
  'application/json',
  'application/xml',
  'application/x-www-form-urlencoded',
]);

/**
 * Decide how to serialize a body into the ring buffer.
 *
 * - Binary content (per Content-Type sniff or non-UTF-8 detection): replaced
 *   with a `[binary body, N bytes]` marker. Never base64-encoded — the
 *   retest sandbox cannot replay binary bodies today, so lossy handling is
 *   correct per SERVER_EXTENSIONS.md §Body handling.
 * - Text bodies over REQUEST_BODY_MAX_BYTES: truncated with the final 3
 *   bytes replaced by `...`. Returned tuple's `truncated` flag drives the
 *   caller's `body_truncated: true` field.
 */
export function shapeBody(
  bytes: Uint8Array,
  contentType: string | undefined,
): [string, boolean] {
  if (bytes.length === 0) return ['', false];
  if (isBinaryContent(contentType, bytes)) {
    return [`[binary body, ${bytes.length} bytes]`, false];
  }
  // UTF-8 text path.
  const decoded = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  if (decoded.length <= REQUEST_BODY_MAX_BYTES) return [decoded, false];
  // Truncate to REQUEST_BODY_MAX_BYTES, then trim last 3 chars for '...'.
  let cut = decoded.slice(0, REQUEST_BODY_MAX_BYTES);
  while (cut.length > REQUEST_BODY_MAX_BYTES - 3) {
    cut = cut.slice(0, cut.length - 1);
  }
  return [`${cut}...`, true];
}

function isBinaryContent(
  contentType: string | undefined,
  bytes: Uint8Array,
): boolean {
  if (contentType) {
    const base = contentType.toLowerCase().split(';')[0]!.trim();
    if (BINARY_CONTENT_TYPES.has(base)) return true;
    if (BINARY_PREFIXES.some((p) => base.startsWith(p))) return true;
    if (base.endsWith('+json') || base.endsWith('+xml')) return false;
    if (TEXT_PREFIXES.some((p) => base.startsWith(p))) return false;
    if (TEXT_EXACT.has(base)) return false;
  }
  // No content type OR unknown content type: sniff for NUL bytes and
  // invalid UTF-8. Binary payloads (gzip, images, etc.) almost always
  // contain NULs in the first KB.
  const sniffLen = Math.min(bytes.length, 1024);
  for (let i = 0; i < sniffLen; i++) {
    if (bytes[i] === 0) return true;
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, sniffLen));
  } catch {
    return true;
  }
  return false;
}

/**
 * Minimal ANSI stripper: removes CSI sequences (ESC [ ... final byte in
 * 0x40..=0x7E) and two-char non-CSI escapes. Enough for pino / chalk color
 * output; not a full terminal emulator.
 */
export function stripAnsi(s: string): string {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === 0x1b) {
      // ESC
      if (i + 1 < s.length && s.charCodeAt(i + 1) === 0x5b /* [ */) {
        i += 2;
        while (i < s.length) {
          const b = s.charCodeAt(i);
          i += 1;
          if (b >= 0x40 && b <= 0x7e) break;
        }
        continue;
      }
      i += 2;
      continue;
    }
    out += s[i];
    i += 1;
  }
  return out;
}

// ─── Snapshot helpers ────────────────────────────────────────────────────────

interface SourceFile {
  path: string;
  content: string;
}

function projectRoot(): string {
  const override = process.env.CLEAN_DEV_PROJECT_ROOT;
  if (override && override.length > 0) return override;
  return process.cwd();
}

function walkSourceTree(root: string): SourceFile[] {
  const out: SourceFile[] = [];
  walkDir(root, root, 0, out);
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

function walkDir(root: string, dir: string, depth: number, out: SourceFile[]): void {
  if (out.length >= SOURCE_TREE_MAX_FILES) return;
  if (depth > SOURCE_TREE_MAX_DEPTH) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    if (out.length >= SOURCE_TREE_MAX_FILES) return;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walkDir(root, full, depth + 1, out);
    } else if (entry.isFile()) {
      // Only `.cln` source files per SERVER_EXTENSIONS.md §_dev_snapshot.
      const ext = path.extname(entry.name).toLowerCase();
      if (ext !== '.cln') continue;
      let content: string;
      try {
        content = fs.readFileSync(full, 'utf8');
      } catch {
        continue;
      }
      const rel = path.relative(root, full).split(path.sep).join('/');
      out.push({ path: rel, content });
    }
  }
}

function readCurrentWasmB64(): string {
  if (!currentWasmBytes) return '';
  if (currentWasmBytes.length > CURRENT_WASM_MAX_BYTES) {
    recordLogLine(
      `[dev-capture] current_wasm omitted: ${currentWasmBytes.length} bytes exceeds ${CURRENT_WASM_MAX_BYTES} byte cap`,
    );
    return '';
  }
  return Buffer.from(currentWasmBytes).toString('base64');
}

/**
 * Compute the project hash using the same formula as `cleen`'s heartbeat and
 * the Rust host's `dev_capture::compute_project_hash`:
 *   SHA256(trim(git_remote_origin_url) + "|" + git_repo_root)
 * Returns the empty string when the current directory is not inside a git
 * working tree.
 */
export function computeProjectHash(root: string): string {
  const repoRoot = gitRepoRoot(root);
  if (!repoRoot) return '';
  const remote = gitRemoteUrl(root);
  const h = createHash('sha256');
  h.update(remote);
  h.update('|');
  h.update(repoRoot);
  return h.digest('hex');
}

function gitRepoRoot(cwd: string): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    }).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

function gitRemoteUrl(cwd: string): string {
  try {
    return execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    }).trim();
  } catch {
    return '';
  }
}

function snapshotComponentVersions(): Record<string, string> {
  const map: Record<string, string> = {};
  // Self-version from package.json — read from the packaged manifest at
  // module load time so we don't shell out per call.
  map['clean-node-server'] = readSelfVersion();

  const home = process.env.HOME;
  if (!home) return map;
  const pluginsRoot = path.join(home, '.cleen', 'plugins');
  let dirs: fs.Dirent[];
  try {
    dirs = fs.readdirSync(pluginsRoot, { withFileTypes: true });
  } catch {
    return map;
  }
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const pluginToml = path.join(pluginsRoot, dir.name, 'plugin.toml');
    let text: string;
    try {
      text = fs.readFileSync(pluginToml, 'utf8');
    } catch {
      continue;
    }
    // Lightweight TOML parse — plugin.toml uses a stable shape with a top-
    // level `[plugin]` table containing `name = "..."` and `version = "..."`.
    // Avoid adding a TOML dependency for this one use.
    const name = matchTomlString(text, 'name');
    const version = matchTomlString(text, 'version') ?? 'unknown';
    if (name) map[name] = version;
  }
  return map;
}

function matchTomlString(text: string, key: string): string | undefined {
  const re = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"\\s*$`, 'm');
  const m = re.exec(text);
  return m ? m[1] : undefined;
}

function readSelfVersion(): string {
  // package.json sits at the repo root; walk up from __dirname (which is
  // dist/bridge in the packaged build or src/bridge in dev) until found.
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'package.json');
    if (fs.existsSync(candidate)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(candidate, 'utf8')) as {
          name?: string;
          version?: string;
        };
        if (pkg.name === 'clean-node-server' && typeof pkg.version === 'string') {
          return pkg.version;
        }
      } catch {
        // fall through
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return 'unknown';
}

// ─── Small utilities ─────────────────────────────────────────────────────────

function isoWithMs(d: Date): string {
  // toISOString() already yields millisecond precision + trailing "Z", which
  // matches the Rust host's `to_rfc3339_opts(SecondsFormat::Millis, true)`.
  return d.toISOString();
}

function safeInspect(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// Silence "unused" warnings for the path variable in tsc while keeping the
// setter's interface aligned with the Rust host's `set_current_wasm(bytes,
// path)` signature — the path is retained for future traceback support.
void currentWasmPath;
