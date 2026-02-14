import * as crypto from 'crypto';
import * as bcrypt from 'bcryptjs';
import * as jwt from 'jsonwebtoken';
import { WasmState } from '../types';
import { readString, writeString, log } from './helpers';

/**
 * Default bcrypt salt rounds
 */
const BCRYPT_ROUNDS = 10;

/**
 * Create cryptographic bridge functions
 */
export function createCryptoBridge(getState: () => WasmState) {
  return {
    /**
     * Hash a password using bcrypt
     *
     * @returns Pointer to bcrypt hash string
     */
    _auth_hash_password(passwordPtr: number, passwordLen: number): number {
      const state = getState();
      const password = readString(state, passwordPtr, passwordLen);

      try {
        const hash = bcrypt.hashSync(password, BCRYPT_ROUNDS);
        return writeString(state, hash);
      } catch (err) {
        log(state, 'CRYPTO', 'Failed to hash password', err);
        return writeString(state, '');
      }
    },

    /**
     * Verify a password against a bcrypt hash
     *
     * @returns 1 if password matches, 0 otherwise
     */
    _auth_verify_password(
      passwordPtr: number,
      passwordLen: number,
      hashPtr: number,
      hashLen: number
    ): number {
      const state = getState();
      const password = readString(state, passwordPtr, passwordLen);
      const hash = readString(state, hashPtr, hashLen);

      try {
        const matches = bcrypt.compareSync(password, hash);
        return matches ? 1 : 0;
      } catch (err) {
        log(state, 'CRYPTO', 'Failed to verify password', err);
        return 0;
      }
    },

    /**
     * Sign a JWT token
     * Plugin signature: _jwt_sign(string, string, string) -> string
     * WASM: (payload_ptr, payload_len, secret_ptr, secret_len, expires_ptr, expires_len) -> i32
     *
     * @returns Pointer to JWT token string
     */
    _jwt_sign(
      payloadPtr: number,
      payloadLen: number,
      secretPtr: number,
      secretLen: number,
      expiresPtr: number,
      expiresLen: number
    ): number {
      const state = getState();
      const payloadJson = readString(state, payloadPtr, payloadLen);
      const secret = secretLen > 0 ? readString(state, secretPtr, secretLen) : state.config.jwtSecret;
      const expiresStr = expiresLen > 0 ? readString(state, expiresPtr, expiresLen) : '';

      try {
        const payload = JSON.parse(payloadJson);
        const options: jwt.SignOptions = {};

        if (expiresStr) {
          // Try parsing as a number (seconds), otherwise use as duration string (e.g., "1h", "7d")
          const asNumber = Number(expiresStr);
          if (!isNaN(asNumber) && asNumber > 0) {
            options.expiresIn = asNumber;
          } else {
            (options as Record<string, unknown>).expiresIn = expiresStr;
          }
        }

        const token = jwt.sign(payload, secret, options);
        return writeString(state, token);
      } catch (err) {
        log(state, 'CRYPTO', 'Failed to sign JWT', err);
        return writeString(state, '');
      }
    },

    /**
     * Verify and decode a JWT token
     *
     * @returns Pointer to JSON payload or empty string if invalid
     */
    _jwt_verify(
      tokenPtr: number,
      tokenLen: number,
      secretPtr: number,
      secretLen: number
    ): number {
      const state = getState();
      const token = readString(state, tokenPtr, tokenLen);
      const secret = secretLen > 0 ? readString(state, secretPtr, secretLen) : state.config.jwtSecret;

      try {
        const payload = jwt.verify(token, secret);
        return writeString(state, JSON.stringify(payload));
      } catch (err) {
        log(state, 'CRYPTO', 'JWT verification failed', err);
        return writeString(state, '');
      }
    },

    /**
     * Decode a JWT without verification
     *
     * @returns Pointer to JSON payload or empty string if invalid
     */
    _jwt_decode(tokenPtr: number, tokenLen: number): number {
      const state = getState();
      const token = readString(state, tokenPtr, tokenLen);

      try {
        const payload = jwt.decode(token);
        if (payload) {
          return writeString(state, JSON.stringify(payload));
        }
        return writeString(state, '');
      } catch {
        return writeString(state, '');
      }
    },

    /**
     * Generate random hex string
     *
     * @param bytes - Number of random bytes (hex string will be 2x this length)
     * @returns Pointer to hex string
     */
    _crypto_random_hex(bytes: number): number {
      const state = getState();
      const hex = crypto.randomBytes(bytes).toString('hex');
      return writeString(state, hex);
    },

    /**
     * Generate random bytes as base64
     */
    _crypto_random_base64(bytes: number): number {
      const state = getState();
      const b64 = crypto.randomBytes(bytes).toString('base64');
      return writeString(state, b64);
    },

    /**
     * Generate a UUID v4
     */
    _crypto_uuid(): number {
      const state = getState();
      const uuid = crypto.randomUUID();
      return writeString(state, uuid);
    },

    /**
     * Hash data with SHA-256
     *
     * @returns Pointer to hex hash string
     */
    _crypto_hash_sha256(dataPtr: number, dataLen: number): number {
      const state = getState();
      const data = readString(state, dataPtr, dataLen);
      const hash = crypto.createHash('sha256').update(data).digest('hex');
      return writeString(state, hash);
    },

    /**
     * Hash data with SHA-512
     */
    _crypto_hash_sha512(dataPtr: number, dataLen: number): number {
      const state = getState();
      const data = readString(state, dataPtr, dataLen);
      const hash = crypto.createHash('sha512').update(data).digest('hex');
      return writeString(state, hash);
    },

    /**
     * Hash data with MD5 (for checksums, not security)
     */
    _crypto_hash_md5(dataPtr: number, dataLen: number): number {
      const state = getState();
      const data = readString(state, dataPtr, dataLen);
      const hash = crypto.createHash('md5').update(data).digest('hex');
      return writeString(state, hash);
    },

    /**
     * Create HMAC-SHA256
     */
    _crypto_hmac_sha256(
      dataPtr: number,
      dataLen: number,
      keyPtr: number,
      keyLen: number
    ): number {
      const state = getState();
      const data = readString(state, dataPtr, dataLen);
      const key = readString(state, keyPtr, keyLen);
      const hmac = crypto.createHmac('sha256', key).update(data).digest('hex');
      return writeString(state, hmac);
    },

    /**
     * Encrypt data with AES-256-GCM
     *
     * @returns Pointer to JSON with iv, tag, and encrypted data (all base64)
     */
    _crypto_encrypt_aes(
      dataPtr: number,
      dataLen: number,
      keyPtr: number,
      keyLen: number
    ): number {
      const state = getState();
      const data = readString(state, dataPtr, dataLen);
      const key = readString(state, keyPtr, keyLen);

      try {
        // Derive a 32-byte key from the provided key
        const keyBuffer = crypto.createHash('sha256').update(key).digest();
        const iv = crypto.randomBytes(16);

        const cipher = crypto.createCipheriv('aes-256-gcm', keyBuffer, iv);
        const encrypted = Buffer.concat([
          cipher.update(data, 'utf8'),
          cipher.final(),
        ]);
        const tag = cipher.getAuthTag();

        return writeString(state, JSON.stringify({
          iv: iv.toString('base64'),
          tag: tag.toString('base64'),
          data: encrypted.toString('base64'),
        }));
      } catch (err) {
        log(state, 'CRYPTO', 'Encryption failed', err);
        return writeString(state, '');
      }
    },

    /**
     * Decrypt data with AES-256-GCM
     *
     * @param encryptedPtr - Pointer to JSON with iv, tag, and data
     * @returns Pointer to decrypted string or empty on failure
     */
    _crypto_decrypt_aes(
      encryptedPtr: number,
      encryptedLen: number,
      keyPtr: number,
      keyLen: number
    ): number {
      const state = getState();
      const encryptedJson = readString(state, encryptedPtr, encryptedLen);
      const key = readString(state, keyPtr, keyLen);

      try {
        const { iv, tag, data } = JSON.parse(encryptedJson);

        const keyBuffer = crypto.createHash('sha256').update(key).digest();
        const ivBuffer = Buffer.from(iv, 'base64');
        const tagBuffer = Buffer.from(tag, 'base64');
        const dataBuffer = Buffer.from(data, 'base64');

        const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuffer, ivBuffer);
        decipher.setAuthTag(tagBuffer);

        const decrypted = Buffer.concat([
          decipher.update(dataBuffer),
          decipher.final(),
        ]);

        return writeString(state, decrypted.toString('utf8'));
      } catch (err) {
        log(state, 'CRYPTO', 'Decryption failed', err);
        return writeString(state, '');
      }
    },

    /**
     * Encode string to base64
     */
    _crypto_base64_encode(dataPtr: number, dataLen: number): number {
      const state = getState();
      const data = readString(state, dataPtr, dataLen);
      const encoded = Buffer.from(data, 'utf8').toString('base64');
      return writeString(state, encoded);
    },

    /**
     * Decode base64 to string
     */
    _crypto_base64_decode(dataPtr: number, dataLen: number): number {
      const state = getState();
      const data = readString(state, dataPtr, dataLen);
      try {
        const decoded = Buffer.from(data, 'base64').toString('utf8');
        return writeString(state, decoded);
      } catch {
        return writeString(state, '');
      }
    },
  };
}
