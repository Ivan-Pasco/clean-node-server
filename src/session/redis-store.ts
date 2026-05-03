import * as crypto from 'crypto';
import Redis from 'ioredis';
import { AnySessionStore, SessionData } from '../types';

const DEFAULT_TTL = 3600;
const KEY_PREFIX = 'cln:sess:';

export class RedisSessionStore implements AnySessionStore {
  private client: Redis;

  constructor(url: string) {
    this.client = new Redis(url, { lazyConnect: true, enableReadyCheck: true });
  }

  async connect(): Promise<void> {
    await this.client.connect();
  }

  async create(
    data: Omit<SessionData, 'createdAt' | 'expiresAt'>,
    ttlSeconds = DEFAULT_TTL
  ): Promise<string> {
    const sessionId = crypto.randomBytes(32).toString('hex');
    const now = Date.now();
    const session: SessionData = {
      ...data,
      createdAt: now,
      expiresAt: now + ttlSeconds * 1000,
    };
    await this.client.setex(KEY_PREFIX + sessionId, ttlSeconds, JSON.stringify(session));
    return sessionId;
  }

  async get(sessionId: string): Promise<SessionData | undefined> {
    const raw = await this.client.get(KEY_PREFIX + sessionId);
    if (!raw) return undefined;
    const session = JSON.parse(raw) as SessionData;
    if (Date.now() > session.expiresAt) {
      await this.client.del(KEY_PREFIX + sessionId);
      return undefined;
    }
    return session;
  }

  async destroy(sessionId: string): Promise<boolean> {
    const deleted = await this.client.del(KEY_PREFIX + sessionId);
    return deleted > 0;
  }

  async cleanup(): Promise<void> {
    // Redis TTL handles expiry automatically — nothing to do.
  }

  async storeValue(sessionId: string, key: string, value: string): Promise<boolean> {
    const session = await this.get(sessionId);
    if (!session) return false;
    const ttlMs = session.expiresAt - Date.now();
    if (ttlMs <= 0) return false;
    session.claims[key] = value;
    await this.client.setex(KEY_PREFIX + sessionId, Math.ceil(ttlMs / 1000), JSON.stringify(session));
    return true;
  }

  async getValue(sessionId: string, key: string): Promise<string | undefined> {
    const session = await this.get(sessionId);
    if (!session || !(key in session.claims)) return undefined;
    const val = session.claims[key];
    return typeof val === 'string' ? val : JSON.stringify(val);
  }

  async deleteValue(sessionId: string, key: string): Promise<boolean> {
    const session = await this.get(sessionId);
    if (!session || !(key in session.claims)) return false;
    const ttlMs = session.expiresAt - Date.now();
    if (ttlMs <= 0) return false;
    delete session.claims[key];
    await this.client.setex(KEY_PREFIX + sessionId, Math.ceil(ttlMs / 1000), JSON.stringify(session));
    return true;
  }

  async hasKey(sessionId: string, key: string): Promise<boolean> {
    const session = await this.get(sessionId);
    if (!session) return false;
    return key in session.claims;
  }

  async close(): Promise<void> {
    await this.client.quit();
  }
}
