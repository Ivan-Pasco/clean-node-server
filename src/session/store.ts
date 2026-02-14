import * as crypto from 'crypto';
import { SessionStore, SessionData } from '../types';

/**
 * Default session TTL in seconds (1 hour)
 */
const DEFAULT_SESSION_TTL = 3600;

/**
 * In-memory session store
 *
 * Stores sessions in a Map with automatic expiration cleanup
 */
export class InMemorySessionStore implements SessionStore {
  private sessions: Map<string, SessionData> = new Map();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor(cleanupIntervalMs: number = 60000) {
    // Start periodic cleanup
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, cleanupIntervalMs);
  }

  /**
   * Create a new session
   *
   * @param data - Session data (userId, role, claims)
   * @param ttlSeconds - Time to live in seconds (default: 1 hour)
   * @returns Session ID
   */
  create(
    data: Omit<SessionData, 'createdAt' | 'expiresAt'>,
    ttlSeconds: number = DEFAULT_SESSION_TTL
  ): string {
    const sessionId = this.generateSessionId();
    const now = Date.now();

    const session: SessionData = {
      ...data,
      createdAt: now,
      expiresAt: now + ttlSeconds * 1000,
    };

    this.sessions.set(sessionId, session);

    return sessionId;
  }

  /**
   * Get session by ID
   *
   * @param sessionId - Session ID to look up
   * @returns Session data or undefined if not found/expired
   */
  get(sessionId: string): SessionData | undefined {
    const session = this.sessions.get(sessionId);

    if (!session) {
      return undefined;
    }

    // Check if expired
    if (Date.now() > session.expiresAt) {
      this.sessions.delete(sessionId);
      return undefined;
    }

    return session;
  }

  /**
   * Destroy a session
   *
   * @param sessionId - Session ID to destroy
   * @returns true if session was found and destroyed
   */
  destroy(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  /**
   * Clean up expired sessions
   */
  cleanup(): void {
    const now = Date.now();
    let removed = 0;

    for (const [sessionId, session] of this.sessions.entries()) {
      if (now > session.expiresAt) {
        this.sessions.delete(sessionId);
        removed++;
      }
    }

    if (removed > 0) {
      // Could log this in verbose mode
    }
  }

  /**
   * Update session data
   *
   * @param sessionId - Session ID to update
   * @param data - Partial session data to merge
   * @returns true if session was found and updated
   */
  update(sessionId: string, data: Partial<Omit<SessionData, 'createdAt' | 'expiresAt'>>): boolean {
    const session = this.get(sessionId);

    if (!session) {
      return false;
    }

    const updated: SessionData = {
      ...session,
      ...data,
    };

    this.sessions.set(sessionId, updated);
    return true;
  }

  /**
   * Extend session expiration
   *
   * @param sessionId - Session ID to extend
   * @param ttlSeconds - Additional seconds to add
   * @returns true if session was found and extended
   */
  extend(sessionId: string, ttlSeconds: number = DEFAULT_SESSION_TTL): boolean {
    const session = this.get(sessionId);

    if (!session) {
      return false;
    }

    session.expiresAt = Date.now() + ttlSeconds * 1000;
    this.sessions.set(sessionId, session);
    return true;
  }

  /**
   * Get number of active sessions
   */
  size(): number {
    return this.sessions.size;
  }

  /**
   * Clear all sessions
   */
  clear(): void {
    this.sessions.clear();
  }

  /**
   * Stop cleanup interval
   */
  close(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  /**
   * Store a key-value pair in a session's claims
   */
  storeValue(sessionId: string, key: string, value: string): boolean {
    const session = this.get(sessionId);
    if (!session) return false;
    session.claims[key] = value;
    this.sessions.set(sessionId, session);
    return true;
  }

  /**
   * Get a value by key from a session's claims
   */
  getValue(sessionId: string, key: string): string | undefined {
    const session = this.get(sessionId);
    if (!session || !(key in session.claims)) return undefined;
    const val = session.claims[key];
    return typeof val === 'string' ? val : JSON.stringify(val);
  }

  /**
   * Delete a key from a session's claims
   */
  deleteValue(sessionId: string, key: string): boolean {
    const session = this.get(sessionId);
    if (!session || !(key in session.claims)) return false;
    delete session.claims[key];
    this.sessions.set(sessionId, session);
    return true;
  }

  /**
   * Check if a key exists in a session's claims
   */
  hasKey(sessionId: string, key: string): boolean {
    const session = this.get(sessionId);
    if (!session) return false;
    return key in session.claims;
  }

  /**
   * Generate a secure random session ID
   */
  private generateSessionId(): string {
    return crypto.randomBytes(32).toString('hex');
  }
}
