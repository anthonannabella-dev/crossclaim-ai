import Redis from 'ioredis';
import { env } from './env';
import { logger } from './logger';

let redis: Redis | null = null;
let redisFailed = false;

export function getRedis(): Redis | null {
  if (redisFailed) return null;
  if (!redis) {
    try {
      const r = new Redis(env().REDIS_URL, {
        maxRetriesPerRequest: 1,
        retryStrategy: () => null,
        lazyConnect: true,
      });
      r.on('error', () => {
        redisFailed = true;
        try { r.disconnect(); } catch { /* ignore */ }
        redis = null;
      });
      redis = r;
    } catch {
      redisFailed = true;
      logger.warn('Redis unavailable, running without cache');
      return null;
    }
  }
  return redis;
}

export function tenantKey(tenantId: string, key: string): string {
  return `tenant:${tenantId}:${key}`;
}

export async function cacheGet(key: string): Promise<string | null> {
  const r = getRedis();
  if (!r) return null;
  try { return await r.get(key); } catch { return null; }
}

export async function cacheSet(key: string, value: string, ttl?: number): Promise<void> {
  const r = getRedis();
  if (!r) return;
  try {
    if (ttl) await r.set(key, value, 'EX', ttl);
    else await r.set(key, value);
  } catch { /* ignore */ }
}

export async function cacheDel(key: string): Promise<void> {
  const r = getRedis();
  if (!r) return;
  try { await r.del(key); } catch { /* ignore */ }
}
