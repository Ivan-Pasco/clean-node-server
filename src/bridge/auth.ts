import { WasmState } from '../types';
import { readString, writeString, log } from './helpers';
import { getRequestContext } from '../wasm/state';

/**
 * Create authentication bridge functions
 */
export function createAuthBridge(getState: () => WasmState) {
  return {
    /**
     * Get current session data (convenience wrapper)
     *
     * @returns Pointer to JSON with userId, role, claims or empty string
     */
    _auth_get_session(): number {
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
      }));
    },

    /**
     * Check if request is authenticated
     *
     * @returns 1 if authenticated, 0 otherwise
     */
    _auth_require_auth(): number {
      const state = getState();
      const ctx = getRequestContext(state);

      if (!ctx.sessionId) {
        return 0;
      }

      const session = state.sessionStore.get(ctx.sessionId);
      return session ? 1 : 0;
    },

    /**
     * Check if user has required role
     *
     * @param rolePtr - Pointer to required role string
     * @param roleLen - Length of role
     * @returns 1 if has role, 0 otherwise
     */
    _auth_require_role(rolePtr: number, roleLen: number): number {
      const state = getState();
      const ctx = getRequestContext(state);
      const requiredRole = readString(state, rolePtr, roleLen);

      if (!ctx.sessionId) {
        return 0;
      }

      const session = state.sessionStore.get(ctx.sessionId);

      if (!session) {
        return 0;
      }

      // Check exact role match
      if (session.role === requiredRole) {
        return 1;
      }

      // Check if user has admin role (admin has all permissions)
      if (session.role === 'admin') {
        return 1;
      }

      return 0;
    },

    /**
     * Check if user has any of the specified roles
     *
     * @param rolesPtr - Pointer to JSON array of roles
     * @param rolesLen - Length of roles string
     * @returns 1 if has any role, 0 otherwise
     */
    _auth_require_any_role(rolesPtr: number, rolesLen: number): number {
      const state = getState();
      const ctx = getRequestContext(state);
      const rolesJson = readString(state, rolesPtr, rolesLen);

      if (!ctx.sessionId) {
        return 0;
      }

      const session = state.sessionStore.get(ctx.sessionId);

      if (!session) {
        return 0;
      }

      try {
        const roles = JSON.parse(rolesJson) as string[];

        if (roles.includes(session.role)) {
          return 1;
        }

        // Admin has all permissions
        if (session.role === 'admin') {
          return 1;
        }
      } catch {
        log(state, 'AUTH', 'Invalid roles JSON');
      }

      return 0;
    },

    /**
     * Get current user ID
     *
     * @returns Pointer to user ID string or empty
     */
    _auth_user_id(): number {
      const state = getState();
      const ctx = getRequestContext(state);

      if (!ctx.sessionId) {
        return writeString(state, '');
      }

      const session = state.sessionStore.get(ctx.sessionId);
      return writeString(state, session?.userId || '');
    },

    /**
     * Get current user role
     *
     * @returns Pointer to role string or empty
     */
    _auth_user_role(): number {
      const state = getState();
      const ctx = getRequestContext(state);

      if (!ctx.sessionId) {
        return writeString(state, '');
      }

      const session = state.sessionStore.get(ctx.sessionId);
      return writeString(state, session?.role || '');
    },

    /**
     * Check if user is admin
     *
     * @returns 1 if admin, 0 otherwise
     */
    _auth_is_admin(): number {
      const state = getState();
      const ctx = getRequestContext(state);

      if (!ctx.sessionId) {
        return 0;
      }

      const session = state.sessionStore.get(ctx.sessionId);
      return session?.role === 'admin' ? 1 : 0;
    },

    /**
     * Check if current user owns a resource
     *
     * @param resourceUserIdPtr - Pointer to resource owner user ID
     * @param resourceUserIdLen - Length of user ID
     * @returns 1 if owner or admin, 0 otherwise
     */
    _auth_is_owner(resourceUserIdPtr: number, resourceUserIdLen: number): number {
      const state = getState();
      const ctx = getRequestContext(state);
      const resourceUserId = readString(state, resourceUserIdPtr, resourceUserIdLen);

      if (!ctx.sessionId) {
        return 0;
      }

      const session = state.sessionStore.get(ctx.sessionId);

      if (!session) {
        return 0;
      }

      // Owner check
      if (session.userId === resourceUserId) {
        return 1;
      }

      // Admin can access anything
      if (session.role === 'admin') {
        return 1;
      }

      return 0;
    },

    /**
     * Check if user has a specific permission/capability
     *
     * @param permissionPtr - Pointer to permission string
     * @param permissionLen - Length of permission
     * @returns 1 if has permission, 0 otherwise
     */
    _auth_can(permissionPtr: number, permissionLen: number): number {
      const state = getState();
      const ctx = getRequestContext(state);
      const permission = readString(state, permissionPtr, permissionLen);

      if (!ctx.sessionId) {
        return 0;
      }

      const session = state.sessionStore.get(ctx.sessionId);

      if (!session) {
        return 0;
      }

      // Admin can do anything
      if (session.role === 'admin') {
        return 1;
      }

      // Check if permission is in claims
      const permissions = session.claims.permissions;
      if (Array.isArray(permissions) && permissions.includes(permission)) {
        return 1;
      }

      // Check role-based permissions
      const rolePermissions: Record<string, string[]> = {
        admin: ['*'],
        editor: ['read', 'write', 'edit', 'delete'],
        author: ['read', 'write', 'edit'],
        user: ['read'],
      };

      const allowed = rolePermissions[session.role] || [];
      if (allowed.includes('*') || allowed.includes(permission)) {
        return 1;
      }

      return 0;
    },

    /**
     * Check if user has any of the specified roles
     * (non-throwing version of _auth_require_any_role)
     */
    _auth_has_any_role(rolesPtr: number, rolesLen: number): number {
      const state = getState();
      const ctx = getRequestContext(state);
      const rolesJson = readString(state, rolesPtr, rolesLen);

      if (!ctx.sessionId) {
        return 0;
      }

      const session = state.sessionStore.get(ctx.sessionId);

      if (!session) {
        return 0;
      }

      try {
        const roles = JSON.parse(rolesJson) as string[];

        if (roles.includes(session.role)) {
          return 1;
        }

        // Admin has all permissions
        if (session.role === 'admin') {
          return 1;
        }
      } catch {
        // Invalid JSON, return false
      }

      return 0;
    },

    /**
     * Check if user is authenticated (alias)
     */
    _auth_check(): number {
      const state = getState();
      const ctx = getRequestContext(state);

      if (!ctx.sessionId) {
        return 0;
      }

      const session = state.sessionStore.get(ctx.sessionId);
      return session ? 1 : 0;
    },

    /**
     * Get authenticated user as JSON
     */
    _auth_user(): number {
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
        id: session.userId,
        role: session.role,
        claims: session.claims,
      }));
    },
  };
}
