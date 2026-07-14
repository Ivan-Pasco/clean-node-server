import { createHash } from 'node:crypto';
import { WasmState } from '../types';
import { readLengthPrefixedBytes } from '../wasm/memory';
import { writeString } from './helpers';

/**
 * Create the crypto-sha256-bytes bridge.
 *
 * Exposes `_crypto_sha256_bytes(handle_ptr) -> ptr`.
 *
 * Contract (per foundation/platform-architecture/function-registry.toml and
 * HOST_BRIDGE.md — do NOT renegotiate here):
 *   - Handle is a pointer to a length-prefixed byte buffer laid out as
 *     `[4-byte LE length][bytes]` — the identical layout produced by
 *     `_req_body_bytes` and consumed by `_fs_write_bytes`. This forms the
 *     binary-safe triad `_req_body_bytes → _crypto_sha256_bytes →
 *     _fs_write_bytes` for uploads that must not be UTF-8 decoded (tarballs,
 *     images, arbitrary octets).
 *   - Returns a pointer to a length-prefixed lowercase-hex string of length
 *     64 (the SHA-256 digest, hex-encoded). No trailing newline.
 *   - Empty input yields the well-known constant
 *     e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855.
 *   - `handle_ptr == 0` is treated as empty input (per readLengthPrefixedBytes
 *     null-safety), returning the same empty-input constant.
 *
 * Motivation: the errors dashboard's POST /api/v1/reports/tarball-upload
 * endpoint recomputes SHA-256 on the raw body bytes and rejects the request
 * on mismatch against X-Tarball-SHA256. The string-input `_crypto_hash_sha256`
 * cannot handle octet-stream bodies because it would UTF-8 decode them first.
 */
export function createCryptoSha256BytesBridge(getState: () => WasmState) {
  return {
    _crypto_sha256_bytes(handlePtr: number): number {
      const state = getState();
      const bytes = readLengthPrefixedBytes(state.exports.memory, handlePtr);
      const hex = createHash('sha256').update(bytes).digest('hex');
      return writeString(state, hex);
    },
  };
}
