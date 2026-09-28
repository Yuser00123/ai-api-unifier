import type { RedisClientType } from 'redis';

export class RateLimiter {
  constructor(private readonly redis?: RedisClientType) {}

  async check(key: string, limit = 60, windowSeconds = 60): Promise<{ allowed: boolean; remaining: number }> {
    if (!this.redis) return { allowed: true, remaining: limit };
    const bucket = `gateway:rate:${key}:${Math.floor(Date.now() / (windowSeconds * 1000))}`;
    const count = await this.redis.incr(bucket);
    if (count === 1) await this.redis.expire(bucket, windowSeconds + 2);
    return { allowed: count <= limit, remaining: Math.max(0, limit - count) };
  }
}
