import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis/cloudflare";
import { getMcpAuthContext } from "agents/mcp/server";

import type { ServerConfig } from "./config";
import { AppError } from "./errors";

interface NativeRateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface RateLimitEnvironment {
  readonly [name: string]: unknown;
  readonly MCP_USER_RATE_LIMITER?: NativeRateLimitBinding;
  readonly MCP_GLOBAL_RATE_LIMITER?: NativeRateLimitBinding;
  readonly OAUTH_RATE_LIMITER?: NativeRateLimitBinding;
}

interface SlidingWindowResult {
  readonly success: boolean;
  readonly reason?: "timeout" | "cacheBlock" | "denyList";
}

interface SlidingWindowLimiter {
  limit(identifier: string): Promise<SlidingWindowResult>;
}

interface RedisLimiters {
  readonly userMinute: SlidingWindowLimiter;
  readonly userDay: SlidingWindowLimiter;
  readonly globalMinute: SlidingWindowLimiter;
  readonly globalDay: SlidingWindowLimiter;
  readonly oauthMinute: SlidingWindowLimiter;
  readonly openMeteoMinute: SlidingWindowLimiter;
  readonly openMeteoHour: SlidingWindowLimiter;
  readonly openMeteoDay: SlidingWindowLimiter;
}

type RateLimitConfig = ServerConfig["rate_limits"];

export interface ToolRateLimitInput {
  readonly source?: string;
}

export interface RateLimitService {
  limitTool(input?: ToolRateLimitInput): Promise<void>;
  limitOAuth(
    environment: RateLimitEnvironment,
    ipAddress: string,
  ): Promise<boolean>;
}

export interface RateLimitDependencies {
  readonly environment: () => RateLimitEnvironment;
  readonly actorIdentifier?: () => string;
  readonly createRedisLimiters?: (
    url: string,
    token: string,
    config: RateLimitConfig,
  ) => RedisLimiters;
}

type NativeCheck = "allowed" | "denied" | "unavailable";

interface RedisCheck {
  readonly denied: boolean;
  readonly unavailable: boolean;
}

const noRateLimitService: RateLimitService = {
  async limitTool() {},
  async limitOAuth() {
    return true;
  },
};

export function getNoRateLimitService(): RateLimitService {
  return noRateLimitService;
}

function currentActorIdentifier(): string {
  const userId = getMcpAuthContext()?.props.github_user_id;
  if (
    (typeof userId === "string" && userId.length > 0) ||
    typeof userId === "number"
  ) {
    return `github:${String(userId)}`;
  }

  return "anonymous";
}

function isNativeBinding(value: unknown): value is NativeRateLimitBinding {
  return (
    typeof value === "object" &&
    value !== null &&
    "limit" in value &&
    typeof value.limit === "function"
  );
}

async function checkNative(
  binding: unknown,
  key: string,
): Promise<NativeCheck> {
  if (!isNativeBinding(binding)) {
    return "unavailable";
  }

  try {
    return (await binding.limit({ key })).success ? "allowed" : "denied";
  } catch {
    return "unavailable";
  }
}

function redisCredentials(
  environment: RateLimitEnvironment,
  config: RateLimitConfig,
): { url: string; token: string } | undefined {
  const url = environment[config.redis.url_env];
  const token = environment[config.redis.token_env];
  if (typeof url !== "string" || typeof token !== "string" || token === "") {
    return undefined;
  }

  try {
    const parsed = new URL(url);
    if (
      parsed.protocol !== "https:" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.hash !== ""
    ) {
      return undefined;
    }
  } catch {
    return undefined;
  }

  return { url, token };
}

function createRedisLimiters(
  url: string,
  token: string,
  config: RateLimitConfig,
): RedisLimiters {
  const redis = new Redis({ url, token });
  const create = (
    limit: number,
    duration: "1 m" | "1 h" | "24 h",
    suffix: string,
  ) =>
    new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(limit, duration),
      prefix: `${config.redis.key_prefix}:${suffix}`,
      timeout: config.redis.timeout_ms,
      analytics: false,
      ephemeralCache: false,
    });

  return {
    userMinute: create(
      config.user.requests_per_minute,
      "1 m",
      "user:minute",
    ),
    userDay: create(
      config.user.requests_per_24_hours,
      "24 h",
      "user:day",
    ),
    globalMinute: create(
      config.global.requests_per_minute,
      "1 m",
      "global:minute",
    ),
    globalDay: create(
      config.global.requests_per_24_hours,
      "24 h",
      "global:day",
    ),
    oauthMinute: create(
      config.oauth.requests_per_minute_per_ip,
      "1 m",
      "oauth:minute",
    ),
    openMeteoMinute: create(
      config.providers.open_meteo_ie.requests_per_minute,
      "1 m",
      "provider:open_meteo_ie:minute",
    ),
    openMeteoHour: create(
      config.providers.open_meteo_ie.requests_per_hour,
      "1 h",
      "provider:open_meteo_ie:hour",
    ),
    openMeteoDay: create(
      config.providers.open_meteo_ie.requests_per_24_hours,
      "24 h",
      "provider:open_meteo_ie:day",
    ),
  };
}

async function checkRedis(
  checks: ReadonlyArray<Promise<SlidingWindowResult>>,
): Promise<RedisCheck> {
  const results = await Promise.allSettled(checks);
  let denied = false;
  let unavailable = false;

  for (const result of results) {
    if (result.status === "rejected" || result.value.reason === "timeout") {
      unavailable = true;
    } else if (!result.value.success) {
      denied = true;
    }
  }

  return { denied, unavailable };
}

function rateLimited(message?: string): AppError {
  return new AppError(
    "RATE_LIMITED",
    message ?? "The MCP request rate limit was exceeded.",
  );
}

export function createRateLimitService(
  config: RateLimitConfig,
  dependencies: RateLimitDependencies,
): RateLimitService {
  const actorIdentifier =
    dependencies.actorIdentifier ?? currentActorIdentifier;
  const limiterFactory =
    dependencies.createRedisLimiters ?? createRedisLimiters;

  const getRedisLimiters = (
    environment: RateLimitEnvironment,
  ): RedisLimiters | undefined => {
    const credentials = redisCredentials(environment, config);
    if (credentials === undefined) {
      return undefined;
    }
    try {
      return limiterFactory(credentials.url, credentials.token, config);
    } catch {
      return undefined;
    }
  };

  return {
    async limitTool(input = {}) {
      const environment = dependencies.environment();
      const actor = actorIdentifier();
      const native = await Promise.all([
        checkNative(environment.MCP_USER_RATE_LIMITER, actor),
        checkNative(environment.MCP_GLOBAL_RATE_LIMITER, "all"),
      ]);
      if (native.includes("denied")) {
        throw rateLimited();
      }
      const nativeAvailable = native.every((result) => result === "allowed");

      const redis = getRedisLimiters(environment);
      if (redis === undefined) {
        if (input.source === "open_meteo_ie" || !nativeAvailable) {
          throw rateLimited("The rate-limit service is temporarily unavailable.");
        }
        return;
      }

      const checks = [
        redis.userMinute.limit(actor),
        redis.userDay.limit(actor),
        redis.globalMinute.limit("all"),
        redis.globalDay.limit("all"),
      ];
      if (input.source === "open_meteo_ie") {
        checks.push(
          redis.openMeteoMinute.limit("all"),
          redis.openMeteoHour.limit("all"),
          redis.openMeteoDay.limit("all"),
        );
      }

      const result = await checkRedis(checks);
      if (result.denied) {
        throw rateLimited();
      }
      if (
        result.unavailable &&
        (input.source === "open_meteo_ie" || !nativeAvailable)
      ) {
        throw rateLimited("The rate-limit service is temporarily unavailable.");
      }
    },

    async limitOAuth(environment, ipAddress) {
      const native = await checkNative(environment.OAUTH_RATE_LIMITER, ipAddress);
      if (native === "denied") {
        return false;
      }

      const redis = getRedisLimiters(environment);
      if (redis === undefined) {
        return native === "allowed";
      }
      const result = await checkRedis([redis.oauthMinute.limit(ipAddress)]);
      if (result.denied) {
        return false;
      }
      return !result.unavailable || native === "allowed";
    },
  };
}
