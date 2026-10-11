import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

import type { RateLimitService } from "../rate-limit";

export interface AuthEnv {
  readonly [name: string]: unknown;
  readonly OAUTH_KV?: KVNamespace;
  readonly OAUTH_PROVIDER?: OAuthHelpers;
  readonly MCP_USER_RATE_LIMITER?: RateLimit;
  readonly MCP_GLOBAL_RATE_LIMITER?: RateLimit;
  readonly OAUTH_RATE_LIMITER?: RateLimit;
}

export interface WorkerHandler<Env extends AuthEnv = AuthEnv> {
  fetch(
    request: Request,
    env: Env,
    context: ExecutionContext,
  ): Response | Promise<Response>;
}

export interface AuthDependencies {
  readonly fetch?: typeof globalThis.fetch;
  readonly rateLimiter?: RateLimitService;
}
