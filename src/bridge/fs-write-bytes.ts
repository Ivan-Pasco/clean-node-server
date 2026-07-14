import * as fs from 'fs';
import * as path from 'path';
import { WasmState } from '../types';
import { readRawString } from '../wasm/memory';
import { readLengthPrefixedBytes } from '../wasm/memory';

/**
 * Return codes — mirror the taxonomy documented in HOST_BRIDGE.md §File I/O
 * and in the `_fs_write_bytes` entry in `function-registry.toml`. Do NOT
 * renumber; the Rust host (clean-server) uses the same codes and errors
 * dashboard handlers switch on them.
 */
const OK = 0;
const ERR_PERMISSION_DENIED = 1;
// const ERR_DISK_FULL = 2; // Surfaced from ENOSPC below.
const ERR_INVALID_PATH = 3;
const ERR_PARENT_NOT_DIR = 4;
const ERR_IO = 5;

/**
 * Host-configured allowlist root for _fs_write_bytes. Same env var name the
 * Rust host uses so applications can rely on a single knob across runtimes.
 * When unset, every call returns ERR_INVALID_PATH — safe default per the
 * contract; hosts opt in by setting this explicitly (the errors dashboard
 * does so at boot).
 */
const ALLOWLIST_ENV = 'CLEAN_FS_WRITE_ROOT';

/**
 * Path prefixes that are NEVER writable, regardless of allowlist configuration.
 * Kept minimal: enough to prevent obviously-catastrophic writes if an operator
 * misconfigures CLEAN_FS_WRITE_ROOT to something like `/`. This is a belt-and-
 * braces guard on top of the allowlist, not the primary defense.
 */
const BLOCKED_PREFIXES = ['/proc', '/sys', '/dev'];

function isBlockedSystemPath(resolved: string): boolean {
  for (const prefix of BLOCKED_PREFIXES) {
    if (resolved === prefix || resolved.startsWith(prefix + path.sep)) return true;
  }
  // ~/.ssh — resolve $HOME to match; not on BLOCKED_PREFIXES because $HOME can
  // legitimately fall inside a user-scoped tarball root, but SSH keys never do.
  const home = process.env.HOME;
  if (home && home.length > 0) {
    const sshDir = path.join(home, '.ssh');
    if (resolved === sshDir || resolved.startsWith(sshDir + path.sep)) return true;
  }
  return false;
}

/**
 * Validate the caller-supplied path and return the resolved absolute path if
 * it passes every check. Returns null on any rejection (caller returns
 * ERR_INVALID_PATH). This function performs NO filesystem I/O — it decides
 * purely from the string, the allowlist env, and the block list.
 */
function validatePath(filePath: string): string | null {
  if (filePath.length === 0) return null;
  // Reject null bytes anywhere in the input. `path.resolve` would silently
  // truncate at the first NUL on some platforms; catching it here means the
  // reject reason (ERR_INVALID_PATH) matches what a downstream `write` would
  // have surfaced as opaque ERR_IO.
  if (filePath.indexOf('\0') !== -1) return null;
  // Reject any occurrence of `..` as a path segment. Checking the raw string
  // catches `foo/../bar` before `path.resolve` collapses it — otherwise a
  // resolved-inside-root path could still have started with a traversal
  // attempt, which we reject on principle to stay symmetric with the Rust host.
  const segments = filePath.split(/[\\/]/);
  if (segments.some((s) => s === '..')) return null;

  const root = process.env[ALLOWLIST_ENV];
  if (!root || root.length === 0) return null;
  const resolvedRoot = path.resolve(root);

  const resolved = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(resolvedRoot, filePath);

  // Post-resolve boundary check — path.resolve normalizes ../ so if a caller
  // slipped one past the segment check via encoding tricks, this still holds.
  const rootWithSep = resolvedRoot.endsWith(path.sep) ? resolvedRoot : resolvedRoot + path.sep;
  if (resolved !== resolvedRoot && !resolved.startsWith(rootWithSep)) return null;

  if (isBlockedSystemPath(resolved)) return null;

  return resolved;
}

/**
 * Map a Node fs errno to our return code taxonomy. Unknown errors fall
 * through to ERR_IO — callers see 5 rather than a stack trace, matching
 * the Rust host's Result → i32 mapping.
 */
function mapErrno(err: NodeJS.ErrnoException): number {
  switch (err.code) {
    case 'EACCES':
    case 'EPERM':
      return ERR_PERMISSION_DENIED;
    case 'ENOSPC':
      return 2; // ERR_DISK_FULL
    case 'ENOTDIR':
      return ERR_PARENT_NOT_DIR;
    case 'EISDIR':
      // Writing to a path that is itself a directory — the caller passed a
      // path that can't be a file. Same category as parent-is-file for the
      // taxonomy's purposes (path is structurally wrong).
      return ERR_PARENT_NOT_DIR;
    case 'ENAMETOOLONG':
    case 'EINVAL':
      return ERR_INVALID_PATH;
    default:
      return ERR_IO;
  }
}

/**
 * Create the fs-write-bytes bridge.
 *
 * Exposes `_fs_write_bytes(path_ptr, path_len, bytes_ptr) -> i32`.
 *
 * Contract (per foundation/platform-architecture/function-registry.toml and
 * HOST_BRIDGE.md — do NOT renegotiate here):
 *   - Path is a raw ptr+len string.
 *   - Bytes is a pointer to a length-prefixed buffer `[4-byte LE length][bytes]`
 *     — the identical layout produced by `_req_body_bytes`, so request bodies
 *     flow request → hash → disk verbatim with no UTF-8 detour.
 *   - Returns 0 on success. Non-zero codes: 1 permission, 2 disk-full,
 *     3 invalid-path, 4 parent-not-dir, 5 generic I/O.
 *   - Writes are atomic via `{path}.tmp` + rename. On POSIX rename is atomic
 *     when source and destination live on the same filesystem — which is the
 *     case here because both live under the allowlist root. On Windows,
 *     `fs.renameSync` is *not* strictly atomic when the destination exists;
 *     the contract still holds "no corrupt file at path" because the write
 *     to `.tmp` completes fully before the rename attempt, but a concurrent
 *     reader on Windows may observe a brief EPERM. Documented deviation.
 *   - Parent directory is created with `mkdir -p` before writing. If the
 *     parent path exists and is a *file*, ENOTDIR surfaces as code 4.
 *   - Overwrite: writing the same path twice replaces prior contents.
 *   - On any failure after `.tmp` was created, the `.tmp` file is unlinked
 *     before returning the error code — no stale artifacts.
 */
export function createFsWriteBytesBridge(getState: () => WasmState) {
  return {
    _fs_write_bytes(pathPtr: number, pathLen: number, bytesPtr: number): number {
      const state = getState();
      const memory = state.exports.memory;

      const filePath = readRawString(memory, pathPtr, pathLen);
      const resolved = validatePath(filePath);
      if (resolved === null) return ERR_INVALID_PATH;

      // Read the length-prefixed byte buffer once. readLengthPrefixedBytes
      // copies the bytes out of WASM memory, so subsequent malloc/grow won't
      // detach the underlying ArrayBuffer beneath us.
      const bytes = readLengthPrefixedBytes(memory, bytesPtr);
      const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);

      const tmpPath = resolved + '.tmp';

      // Ensure the parent directory exists. mkdir -p is a no-op when the
      // directory already exists. When the parent *path* is a regular file:
      //   - Linux: mkdirSync throws ENOTDIR
      //   - macOS: mkdirSync throws EEXIST
      // Both cases map to ERR_PARENT_NOT_DIR. Rather than platform-branch,
      // any error from mkdir is followed by a stat: if the parent exists and
      // is not a directory, we surface the parent-not-dir code regardless of
      // which errno the platform chose.
      const parentDir = path.dirname(resolved);
      try {
        fs.mkdirSync(parentDir, { recursive: true });
      } catch (err) {
        try {
          const st = fs.statSync(parentDir);
          if (!st.isDirectory()) return ERR_PARENT_NOT_DIR;
        } catch { /* fall through — original error wins */ }
        return mapErrno(err as NodeJS.ErrnoException);
      }

      try {
        fs.writeFileSync(tmpPath, buffer);
      } catch (err) {
        // Best-effort cleanup — the tmp file may or may not exist depending
        // on how far writeFileSync got. Ignore unlink failures; the primary
        // error code takes priority.
        try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
        return mapErrno(err as NodeJS.ErrnoException);
      }

      try {
        fs.renameSync(tmpPath, resolved);
      } catch (err) {
        try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
        return mapErrno(err as NodeJS.ErrnoException);
      }

      return OK;
    },
  };
}
