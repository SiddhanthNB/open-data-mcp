import OAuthProvider, {
  insufficientScope,
  type OAuthResourceContext,
} from "@cloudflare/workers-oauth-provider";

import type { OAuthConfig } from "../config";
import { getNoRateLimitService } from "../rate-limit";
import { createGitHubIdentityHandler } from "./github";
import {
  AuthConfigurationError,
  configurationErrorResponse,
  requireKv,
} from "./secrets";
import type {
  AuthDependencies,
  AuthEnv,
  WorkerHandler,
} from "./types";

interface GitHubIdentity {
  readonly github_user_id: string;
  readonly github_login: string;
}

function isOAuthEndpoint(pathname: string, config: OAuthConfig): boolean {
  return (
    pathname === config.authorize_path ||
    pathname === config.callback_path ||
    pathname === config.token_path ||
    pathname === config.registration_path ||
    pathname.startsWith("/.well-known/oauth-")
  );
}

function oauthRateLimitResponse(): Response {
  return Response.json(
    { error: "RATE_LIMITED" },
    { status: 429, headers: { "Retry-After": "60" } },
  );
}

function absoluteUrl(baseUrl: string, path: string): string {
  return new URL(path, `${baseUrl}/`).toString();
}

export function createOAuthHandler(
  config: OAuthConfig,
  mcpHandler: WorkerHandler,
  dependencies: AuthDependencies = {},
): WorkerHandler {
  const rateLimiter = dependencies.rateLimiter ?? getNoRateLimitService();
  const resource = absoluteUrl(config.public_base_url, "/mcp");
  const apiHandler = {
    fetch(
      request: Request,
      env: AuthEnv,
      context: ExecutionContext<unknown>,
    ) {
      const oauthContext = context as OAuthResourceContext<GitHubIdentity>;
      if (
        !config.required_scopes.every((scope) =>
          oauthContext.auth.scope.includes(scope),
        )
      ) {
        return insufficientScope(oauthContext.auth, [
          ...config.required_scopes,
        ]);
      }
      return mcpHandler.fetch(request, env, context);
    },
  };
  const provider = new OAuthProvider<AuthEnv>({
    apiRoute: resource,
    apiHandler,
    defaultHandler: createGitHubIdentityHandler(
      config,
      dependencies.fetch,
    ),
    authorizeEndpoint: absoluteUrl(
      config.public_base_url,
      config.authorize_path,
    ),
    tokenEndpoint: absoluteUrl(config.public_base_url, config.token_path),
    clientRegistrationEndpoint: absoluteUrl(
      config.public_base_url,
      config.registration_path,
    ),
    scopesSupported: [...config.scopes_supported],
    resourceMetadata: {
      resource,
      authorization_servers: [config.public_base_url],
      resource_name: "Ireland Open Data MCP",
    },
    requiredScopes: [...config.required_scopes],
    clientIdMetadataDocumentEnabled: true,
  });

  return {
    async fetch(request, env, context) {
      try {
        requireKv(env);
      } catch (error) {
        if (error instanceof AuthConfigurationError) {
          return configurationErrorResponse();
        }
        throw error;
      }
      const pathname = new URL(request.url).pathname;
      if (isOAuthEndpoint(pathname, config)) {
        const ipAddress = request.headers.get("CF-Connecting-IP") ?? "unknown";
        if (!(await rateLimiter.limitOAuth(env, ipAddress))) {
          return oauthRateLimitResponse();
        }
      }
      return provider.fetch(request, env, context);
    },
  };
}
