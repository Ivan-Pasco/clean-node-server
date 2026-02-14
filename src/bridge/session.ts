import { WasmState } from '../types';
import { readString, writeString, log } from './helpers';
import { getRequestContext, addResponseCookie } from '../wasm/state';

/**
 * Default session TTL in seconds (1 hour)
 */
const DEFAULT_SESSION_TTL = 3600;

/**
 * Create session management bridge functions
 */
export function createSessionBridge(getState: () => WasmState) {
  return {
    /**
     * Create a new session
     *
     * @param userIdPtr - Pointer to user ID string
     * @param userIdLen - Length of user ID
     * @param rolePtr - Pointer to role string
     * @param roleLen - Length of role
     * @param claimsPtr - Pointer to JSON claims string
     * @param claimsLen - Length of claims
     * @returns Pointer to session ID string
     */
    _session_create(
      userIdPtr: number,
      userIdLen: number,
      rolePtr: number,
      roleLen: number,
      claimsPtr: number,
      claimsLen: number
    ): number {
      const state = getState();
      const userId = readString(state, userIdPtr, userIdLen);
      const role = readString(state, rolePtr, roleLen);
      const claimsJson = claimsLen > 0 ? readString(state, claimsPtr, claimsLen) : '{}';

      let claims: Record<string, unknown> = {};
      try {
        claims = JSON.parse(claimsJson);
      } catch {
        log(state, 'SESSION', 'Invalid claims JSON, using empty object');
      }

      const sessionId = state.sessionStore.create({
        userId,
        role,
        claims,
      });

      // Set session cookie
      addResponseCookie(state, 'session_id', sessionId, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
        maxAge: DEFAULT_SESSION_TTL,
      });

      log(state, 'SESSION', `Created session for user ${userId}`, { role });

      return writeString(state, sessionId);
    },

    /**
     * Create session with custom TTL
     */
    _session_create_with_ttl(
      userIdPtr: number,
      userIdLen: number,
      rolePtr: number,
      roleLen: number,
      claimsPtr: number,
      claimsLen: number,
      ttlSeconds: number
    ): number {
      const state = getState();
      const userId = readString(state, userIdPtr, userIdLen);
      const role = readString(state, rolePtr, roleLen);
      const claimsJson = claimsLen > 0 ? readString(state, claimsPtr, claimsLen) : '{}';

      let claims: Record<string, unknown> = {};
      try {
        claims = JSON.parse(claimsJson);
      } catch {
        log(state, 'SESSION', 'Invalid claims JSON, using empty object');
      }

      const sessionId = state.sessionStore.create(
        { userId, role, claims },
        ttlSeconds
      );

      addResponseCookie(state, 'session_id', sessionId, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
        maxAge: ttlSeconds,
      });

      return writeString(state, sessionId);
    },

    /**
     * Get current session data
     *
     * @returns Pointer to JSON session data or empty string if no session
     */
    _session_get(): number {
      const state = getState();
      const ctx = getRequestContext(state);

      if (!ctx.sessionId) {
        return writeString(state, '');
      }

      const session = state.sessionStore.get(ctx.sessionId);

      if (!session) {
        return writeString(state, '');
      }

      return writeString(state, JSON.stringify({
        userId: session.userId,
        role: session.role,
        claims: session.claims,
        expiresAt: session.expiresAt,
      }));
    },

    /**
     * Get session user ID
     */
    _session_user_id(): number {
      const state = getState();
      const ctx = getRequestContext(state);

      if (!ctx.sessionId) {
        return writeString(state, '');
      }

      const session = state.sessionStore.get(ctx.sessionId);
      return writeString(state, session?.userId || '');
    },

    /**
     * Get session role
     */
    _session_role(): number {
      const state = getState();
      const ctx = getRequestContext(state);

      if (!ctx.sessionId) {
        return writeString(state, '');
      }

      const session = state.sessionStore.get(ctx.sessionId);
      return writeString(state, session?.role || '');
    },

    /**
     * Get session claim by key
     */
    _session_claim(keyPtr: number, keyLen: number): number {
      const state = getState();
      const ctx = getRequestContext(state);
      const key = readString(state, keyPtr, keyLen);

      if (!ctx.sessionId) {
        return writeString(state, '');
      }

      const session = state.sessionStore.get(ctx.sessionId);
      if (!session || !(key in session.claims)) {
        return writeString(state, '');
      }

      const value = session.claims[key];
      return writeString(state, typeof value === 'string' ? value : JSON.stringify(value));
    },

    /**
     * Destroy current session
     *
     * @returns 1 if session was destroyed, 0 otherwise
     */
    _session_destroy(): number {
      const state = getState();
      const ctx = getRequestContext(state);

      if (!ctx.sessionId) {
        return 0;
      }

      const destroyed = state.sessionStore.destroy(ctx.sessionId);

      if (destroyed) {
        // Clear session cookie
        addResponseCookie(state, 'session_id', '', {
          httpOnly: true,
          maxAge: 0,
          path: '/',
        });

        log(state, 'SESSION', 'Session destroyed');
      }

      return destroyed ? 1 : 0;
    },

    /**
     * Check if current request has a valid session
     */
    _session_exists(): number {
      const state = getState();
      const ctx = getRequestContext(state);

      if (!ctx.sessionId) {
        return 0;
      }

      const session = state.sessionStore.get(ctx.sessionId);
      return session ? 1 : 0;
    },

    /**
     * Extend current session
     *
     * @param ttlSeconds - New TTL in seconds
     * @returns 1 if extended, 0 if no session
     */
    _session_extend(ttlSeconds: number): number {
      const state = getState();
      const ctx = getRequestContext(state);

      if (!ctx.sessionId) {
        return 0;
      }

      const store = state.sessionStore as {
        extend?: (id: string, ttl: number) => boolean;
      };

      if (typeof store.extend === 'function') {
        const extended = store.extend(ctx.sessionId, ttlSeconds);

        if (extended) {
          // Update cookie expiration
          addResponseCookie(state, 'session_id', ctx.sessionId, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'lax',
            path: '/',
            maxAge: ttlSeconds,
          });
        }

        return extended ? 1 : 0;
      }

      return 0;
    },

    /**
     * Set a cookie (general purpose)
     */
    _http_set_cookie(
      namePtr: number,
      nameLen: number,
      valuePtr: number,
      valueLen: number,
      optionsPtr: number,
      optionsLen: number
    ): void {
      const state = getState();
      const name = readString(state, namePtr, nameLen);
      const value = readString(state, valuePtr, valueLen);

      let options: Record<string, unknown> = {};
      if (optionsLen > 0) {
        const optionsJson = readString(state, optionsPtr, optionsLen);
        try {
          options = JSON.parse(optionsJson);
        } catch {
          // Use default options
        }
      }

      addResponseCookie(state, name, value, {
        maxAge: typeof options.maxAge === 'number' ? options.maxAge : undefined,
        httpOnly: typeof options.httpOnly === 'boolean' ? options.httpOnly : true,
        secure: typeof options.secure === 'boolean' ? options.secure : false,
        sameSite: options.sameSite as 'strict' | 'lax' | 'none' | undefined,
        path: typeof options.path === 'string' ? options.path : '/',
      });
    },

    /**
     * Delete a cookie
     */
    _http_delete_cookie(namePtr: number, nameLen: number): void {
      const state = getState();
      const name = readString(state, namePtr, nameLen);

      addResponseCookie(state, name, '', {
        httpOnly: true,
        maxAge: 0,
        path: '/',
      });
    },

    /**
     * Store a key-value pair in the current session
     * Plugin signature: _session_store(string, string) -> integer
     */
    _session_store(
      keyPtr: number,
      keyLen: number,
      valuePtr: number,
      valueLen: number
    ): number {
      const state = getState();
      const ctx = getRequestContext(state);
      const key = readString(state, keyPtr, keyLen);
      const value = readString(state, valuePtr, valueLen);

      if (!ctx.sessionId) {
        log(state, 'SESSION', 'No session for _session_store');
        return 0;
      }

      if (state.sessionStore.storeValue) {
        return state.sessionStore.storeValue(ctx.sessionId, key, value) ? 1 : 0;
      }

      // Fallback: update claims directly
      const session = state.sessionStore.get(ctx.sessionId);
      if (session) {
        session.claims[key] = value;
        return 1;
      }
      return 0;
    },

    /**
     * Get a value by key from the current session
     * Plugin signature: _session_get(string) -> string
     * Note: This is registered as _session_get_value to avoid conflict with the 0-param _session_get
     */
    _session_get_value(keyPtr: number, keyLen: number): number {
      const state = getState();
      const ctx = getRequestContext(state);
      const key = readString(state, keyPtr, keyLen);

      if (!ctx.sessionId) {
        return writeString(state, '');
      }

      if (state.sessionStore.getValue) {
        const value = state.sessionStore.getValue(ctx.sessionId, key);
        return writeString(state, value || '');
      }

      // Fallback: read from claims directly
      const session = state.sessionStore.get(ctx.sessionId);
      if (session && key in session.claims) {
        const val = session.claims[key];
        return writeString(state, typeof val === 'string' ? val : JSON.stringify(val));
      }
      return writeString(state, '');
    },

    /**
     * Delete a key from the current session
     * Plugin signature: _session_delete(string) -> integer
     */
    _session_delete(keyPtr: number, keyLen: number): number {
      const state = getState();
      const ctx = getRequestContext(state);
      const key = readString(state, keyPtr, keyLen);

      if (!ctx.sessionId) {
        return 0;
      }

      if (state.sessionStore.deleteValue) {
        return state.sessionStore.deleteValue(ctx.sessionId, key) ? 1 : 0;
      }

      // Fallback
      const session = state.sessionStore.get(ctx.sessionId);
      if (session && key in session.claims) {
        delete session.claims[key];
        return 1;
      }
      return 0;
    },

    /**
     * Check if a key exists in the current session
     * Plugin signature: _session_exists(string) -> integer
     * Note: Registered as _session_has_key to avoid conflict with 0-param _session_exists
     */
    _session_has_key(keyPtr: number, keyLen: number): number {
      const state = getState();
      const ctx = getRequestContext(state);
      const key = readString(state, keyPtr, keyLen);

      if (!ctx.sessionId) {
        return 0;
      }

      if (state.sessionStore.hasKey) {
        return state.sessionStore.hasKey(ctx.sessionId, key) ? 1 : 0;
      }

      // Fallback
      const session = state.sessionStore.get(ctx.sessionId);
      if (session) {
        return key in session.claims ? 1 : 0;
      }
      return 0;
    },

    /**
     * Store a CSRF token in the current session
     */
    _session_set_csrf(tokenPtr: number, tokenLen: number): number {
      const state = getState();
      const ctx = getRequestContext(state);
      const token = readString(state, tokenPtr, tokenLen);

      if (!ctx.sessionId) {
        return 0;
      }

      const session = state.sessionStore.get(ctx.sessionId);
      if (session) {
        session.claims['_csrf_token'] = token;
        return 1;
      }
      return 0;
    },

    /**
     * Get the CSRF token from the current session
     */
    _session_get_csrf(): number {
      const state = getState();
      const ctx = getRequestContext(state);

      if (!ctx.sessionId) {
        return writeString(state, '');
      }

      const session = state.sessionStore.get(ctx.sessionId);
      if (session && '_csrf_token' in session.claims) {
        return writeString(state, String(session.claims['_csrf_token']));
      }
      return writeString(state, '');
    },
  };
}
