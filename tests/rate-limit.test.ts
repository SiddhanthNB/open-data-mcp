import { describe, expect, it, vi } from "vitest";

import { serverConfig } from "../src/config";
import {
  createRateLimitService,
  type RateLimitEnvironment,
} from "../src/rate-limit";

function nativeBinding(success = true) {
  return { limit: vi.fn(async () => ({ success })) };
}

function redisLimiter(
  result: { success: boolean; reason?: "timeout"; reset?: number } = {
    success: true,
  },
) {
  return { limit: vi.fn(async () => result) };
}

function redisLimiters(
  overrides: Partial<ReturnType<typeof redisLimitersBase>> = {},
) {
  return { ...redisLimitersBase(), ...overrides };
}

function redisLimitersBase() {
  return {
    userMinute: redisLimiter(),
    userDay: redisLimiter(),
    globalMinute: redisLimiter(),
    globalDay: redisLimiter(),
    oauthMinute: redisLimiter(),
    openMeteoMinute: redisLimiter(),
    openMeteoHour: redisLimiter(),
    openMeteoDay: redisLimiter(),
  };
}

function environment(
  overrides: Partial<RateLimitEnvironment> = {},
): RateLimitEnvironment {
  return {
    UPSTASH_REDIS_REST_URL: "https://redis.example.test",
    UPSTASH_REDIS_REST_TOKEN: "test-token",
    MCP_USER_RATE_LIMITER: nativeBinding(),
    MCP_GLOBAL_RATE_LIMITER: nativeBinding(),
    OAUTH_RATE_LIMITER: nativeBinding(),
    ...overrides,
  };
}

describe("rate limit service", () => {
  it("allows a tool call after native and Redis checks", async () => {
    const limits = redisLimiters();
    const bindings = environment();
    const service = createRateLimitService(serverConfig.rate_limits, {
      environment: () => bindings,
      actorIdentifier: () => "github:123",
      createRedisLimiters: () => limits,
    });

    await expect(service.limitTool()).resolves.toBeUndefined();

    expect(bindings.MCP_USER_RATE_LIMITER?.limit).toHaveBeenCalledWith({
      key: "github:123",
    });
    expect(bindings.MCP_GLOBAL_RATE_LIMITER?.limit).toHaveBeenCalledWith({
      key: "all",
    });
    expect(limits.userMinute.limit).toHaveBeenCalledWith("github:123");
    expect(limits.userDay.limit).toHaveBeenCalledWith("github:123");
    expect(limits.globalMinute.limit).toHaveBeenCalledWith("all");
    expect(limits.globalDay.limit).toHaveBeenCalledWith("all");
    expect(limits.openMeteoMinute.limit).not.toHaveBeenCalled();
  });

  it("rejects immediately when a native limit is exhausted", async () => {
    const createRedisLimiters = vi.fn(() => redisLimiters());
    const service = createRateLimitService(serverConfig.rate_limits, {
      environment: () =>
        environment({ MCP_USER_RATE_LIMITER: nativeBinding(false) }),
      actorIdentifier: () => "github:123",
      createRedisLimiters,
    });

    await expect(service.limitTool()).rejects.toMatchObject({
      code: "RATE_LIMITED",
      details: { retry_after_seconds: 60 },
    });
    expect(createRedisLimiters).not.toHaveBeenCalled();
  });

  it("rejects when a Redis sliding window is exhausted", async () => {
    const reset = Date.now() + 90_000;
    const service = createRateLimitService(serverConfig.rate_limits, {
      environment,
      actorIdentifier: () => "github:123",
      createRedisLimiters: () =>
        redisLimiters({
          userMinute: redisLimiter({ success: false, reset }),
          userDay: redisLimiter({ success: false, reset: reset + 30_000 }),
        }),
    });

    await expect(service.limitTool()).rejects.toMatchObject({
      code: "RATE_LIMITED",
      message: "The MCP request rate limit was exceeded.",
      details: { retry_after_seconds: 120 },
    });
  });

  it("uses successful Cloudflare checks when Redis fails", async () => {
    const rejected = {
      limit: vi.fn(async () => {
        throw new Error("Redis unavailable");
      }),
    };
    const service = createRateLimitService(serverConfig.rate_limits, {
      environment,
      actorIdentifier: () => "github:123",
      createRedisLimiters: () =>
        redisLimiters({
          userMinute: rejected,
          userDay: rejected,
          globalMinute: rejected,
          globalDay: rejected,
        }),
    });

    await expect(service.limitTool()).resolves.toBeUndefined();
  });

  it("fails closed when neither Redis nor Cloudflare is available", async () => {
    const service = createRateLimitService(serverConfig.rate_limits, {
      environment: () => ({}),
      actorIdentifier: () => "github:123",
    });

    await expect(service.limitTool()).rejects.toMatchObject({
      code: "RATE_LIMITED",
      message: "The rate-limit service is temporarily unavailable.",
    });
  });

  it("fails closed for Open-Meteo when Redis times out", async () => {
    const limits = redisLimiters({
      openMeteoMinute: redisLimiter({ success: true, reason: "timeout" }),
    });
    const service = createRateLimitService(serverConfig.rate_limits, {
      environment,
      actorIdentifier: () => "github:123",
      createRedisLimiters: () => limits,
    });

    await expect(
      service.limitTool({ source: "open_meteo_ie" }),
    ).rejects.toMatchObject({
      code: "RATE_LIMITED",
      message: "The rate-limit service is temporarily unavailable.",
    });
    expect(limits.openMeteoHour.limit).toHaveBeenCalledWith("all");
    expect(limits.openMeteoDay.limit).toHaveBeenCalledWith("all");
  });

  it("uses the native OAuth limit when Redis fails", async () => {
    const failedRedis = redisLimiters({
      oauthMinute: {
        limit: vi.fn(async () => {
          throw new Error("Redis unavailable");
        }),
      },
    });
    const allowedEnvironment = environment();
    const service = createRateLimitService(serverConfig.rate_limits, {
      environment,
      createRedisLimiters: () => failedRedis,
    });

    await expect(
      service.limitOAuth(allowedEnvironment, "192.0.2.1"),
    ).resolves.toBe(true);
    expect(allowedEnvironment.OAUTH_RATE_LIMITER?.limit).toHaveBeenCalledWith({
      key: "192.0.2.1",
    });

    const deniedEnvironment = environment({
      OAUTH_RATE_LIMITER: nativeBinding(false),
    });
    await expect(
      service.limitOAuth(deniedEnvironment, "192.0.2.1"),
    ).resolves.toBe(false);
  });
});
