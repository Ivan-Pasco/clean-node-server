import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { InMemorySessionStore } from '../src/session/store';

describe('InMemorySessionStore', () => {
  let store: InMemorySessionStore;

  beforeEach(() => {
    // Use a long cleanup interval for tests
    store = new InMemorySessionStore(60000);
  });

  afterEach(() => {
    store.close();
  });

  describe('create', () => {
    it('should create a session and return an ID', () => {
      const sessionId = store.create({
        userId: 'user-123',
        role: 'user',
        claims: {},
      });

      expect(sessionId).toBeTruthy();
      expect(typeof sessionId).toBe('string');
      expect(sessionId.length).toBeGreaterThan(0);
    });

    it('should create unique session IDs', () => {
      const ids = new Set<string>();

      for (let i = 0; i < 100; i++) {
        const id = store.create({
          userId: `user-${i}`,
          role: 'user',
          claims: {},
        });
        ids.add(id);
      }

      expect(ids.size).toBe(100);
    });

    it('should store session data correctly', () => {
      const sessionId = store.create({
        userId: 'user-123',
        role: 'admin',
        claims: { email: 'test@example.com' },
      });

      const session = store.get(sessionId);
      expect(session).toBeDefined();
      expect(session?.userId).toBe('user-123');
      expect(session?.role).toBe('admin');
      expect(session?.claims).toEqual({ email: 'test@example.com' });
    });

    it('should set expiration time based on TTL', () => {
      const now = Date.now();
      const sessionId = store.create(
        {
          userId: 'user-123',
          role: 'user',
          claims: {},
        },
        3600 // 1 hour
      );

      const session = store.get(sessionId);
      expect(session?.expiresAt).toBeGreaterThan(now);
      expect(session?.expiresAt).toBeLessThanOrEqual(now + 3600 * 1000 + 100);
    });
  });

  describe('get', () => {
    it('should return session data for valid ID', () => {
      const sessionId = store.create({
        userId: 'user-123',
        role: 'user',
        claims: {},
      });

      const session = store.get(sessionId);
      expect(session).toBeDefined();
      expect(session?.userId).toBe('user-123');
    });

    it('should return undefined for non-existent ID', () => {
      const session = store.get('non-existent-id');
      expect(session).toBeUndefined();
    });

    it('should return undefined for expired session', () => {
      vi.useFakeTimers();

      const sessionId = store.create(
        {
          userId: 'user-123',
          role: 'user',
          claims: {},
        },
        1 // 1 second TTL
      );

      // Advance time by 2 seconds
      vi.advanceTimersByTime(2000);

      const session = store.get(sessionId);
      expect(session).toBeUndefined();

      vi.useRealTimers();
    });
  });

  describe('destroy', () => {
    it('should remove a session', () => {
      const sessionId = store.create({
        userId: 'user-123',
        role: 'user',
        claims: {},
      });

      const result = store.destroy(sessionId);
      expect(result).toBe(true);

      const session = store.get(sessionId);
      expect(session).toBeUndefined();
    });

    it('should return false for non-existent session', () => {
      const result = store.destroy('non-existent-id');
      expect(result).toBe(false);
    });
  });

  describe('update', () => {
    it('should update session data', () => {
      const sessionId = store.create({
        userId: 'user-123',
        role: 'user',
        claims: {},
      });

      const result = store.update(sessionId, { role: 'admin' });
      expect(result).toBe(true);

      const session = store.get(sessionId);
      expect(session?.role).toBe('admin');
      expect(session?.userId).toBe('user-123'); // unchanged
    });

    it('should return false for non-existent session', () => {
      const result = store.update('non-existent-id', { role: 'admin' });
      expect(result).toBe(false);
    });
  });

  describe('extend', () => {
    it('should extend session expiration', () => {
      const sessionId = store.create(
        {
          userId: 'user-123',
          role: 'user',
          claims: {},
        },
        100 // 100 seconds
      );

      const originalSession = store.get(sessionId);
      const originalExpiry = originalSession?.expiresAt;

      // Wait a bit and extend
      const result = store.extend(sessionId, 3600);
      expect(result).toBe(true);

      const extendedSession = store.get(sessionId);
      expect(extendedSession?.expiresAt).toBeGreaterThan(originalExpiry!);
    });

    it('should return false for non-existent session', () => {
      const result = store.extend('non-existent-id', 3600);
      expect(result).toBe(false);
    });
  });

  describe('cleanup', () => {
    it('should remove expired sessions', () => {
      vi.useFakeTimers();

      // Create some sessions with short TTL
      const expiredId = store.create(
        { userId: 'user-1', role: 'user', claims: {} },
        1
      );
      const validId = store.create(
        { userId: 'user-2', role: 'user', claims: {} },
        3600
      );

      // Advance time
      vi.advanceTimersByTime(2000);

      // Run cleanup
      store.cleanup();

      expect(store.get(expiredId)).toBeUndefined();
      expect(store.get(validId)).toBeDefined();

      vi.useRealTimers();
    });
  });

  describe('size', () => {
    it('should return the number of active sessions', () => {
      expect(store.size()).toBe(0);

      store.create({ userId: 'user-1', role: 'user', claims: {} });
      expect(store.size()).toBe(1);

      store.create({ userId: 'user-2', role: 'user', claims: {} });
      expect(store.size()).toBe(2);
    });
  });

  describe('clear', () => {
    it('should remove all sessions', () => {
      store.create({ userId: 'user-1', role: 'user', claims: {} });
      store.create({ userId: 'user-2', role: 'user', claims: {} });

      store.clear();

      expect(store.size()).toBe(0);
    });
  });
});
