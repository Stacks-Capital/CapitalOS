import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ApiError } from "./errors.ts";
import { memoryLimiter, type RedisConnection, redisClient, redisLimiter } from "./rateLimit.ts";

const NOW = new Date("2026-09-15T12:00:10.000Z");

describe("memory limiter", () => {
  it("counts per bucket and resets on the next window", async () => {
    const limiter = memoryLimiter();
    assert.deepEqual(await limiter.hit("a", 2, 60, NOW), { allowed: true, limit: 2, remaining: 1, resetSeconds: 50 });
    assert.equal((await limiter.hit("a", 2, 60, NOW)).allowed, true);
    assert.deepEqual(await limiter.hit("a", 2, 60, NOW), { allowed: false, limit: 2, remaining: 0, resetSeconds: 50 });
    assert.equal((await limiter.hit("b", 2, 60, NOW)).remaining, 1);
    assert.equal((await limiter.hit("a", 2, 60, new Date("2026-09-15T12:01:00.000Z"))).remaining, 1);
  });
});

describe("Redis limiter", () => {
  const unavailable = (error: unknown) => error instanceof ApiError && error.code === "TEMPORARY_UNAVAILABLE";

  it("fails closed when Redis is not connected", async () => {
    const client = redisClient("redis://127.0.0.1:1");
    await assert.rejects(redisLimiter(client).hit("a", 10, 60, NOW), unavailable);
  });

  it("fails closed when Redis stops answering", async () => {
    const hanging = { multi: () => ({ incr: () => ({ expire: () => ({ exec: () => new Promise(() => {}) }) }) }) };
    const limiter = redisLimiter(hanging as unknown as RedisConnection, "test", 50);
    await assert.rejects(limiter.hit("a", 10, 60, NOW), unavailable);
  });
});
