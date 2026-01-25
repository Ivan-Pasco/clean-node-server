import { WasmState } from '../types';
import { readString, writeString, parseJson, log } from './helpers';
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
  };
}
