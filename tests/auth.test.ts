import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createAuthHandler,
  type AuthEnv,
  type WorkerHandler,
} from "../src/auth";
import { createGitHubIdentityHandler } from "../src/auth/github";
import {
  parseServerConfig,
  serverConfig,
  type AuthConfig,
} from "../src/config";
import type { RateLimitService } from "../src/rate-limit";

const publicBaseUrl = "https://mcp.example.test";
const bearerToken = "test-bearer-token-with-at-least-32-characters";

function createMemoryKv(): { binding: KVNamespace; clear(): void } {
  const values = new Map<
    string,
    { value: string; expiration?: number; metadata?: unknown }
  >();

  function getRecord(key: string) {
    const record = values.get(key);
    if (
      record?.expiration !== undefined &&
      record.expiration <= Math.floor(Date.now() / 1_000)
    ) {
      values.delete(key);
      return undefined;
    }
    return record;
  }

  const binding = {
    async get(key: string, options?: string | { type?: string }) {
      const record = getRecord(key);
      if (record === undefined) {
        return null;
      }
      const type = typeof options === "string" ? options : options?.type;
      if (type === "json") {
        return JSON.parse(record.value) as unknown;
      }
      if (type === "arrayBuffer") {
        return new TextEncoder().encode(record.value).buffer;
      }
      return record.value;
    },
    async put(
      key: string,
      value: string | ArrayBuffer | ArrayBufferView,
      options?: {
        expiration?: number;
        expirationTtl?: number;
        metadata?: unknown;
      },
    ) {
      const text =
        typeof value === "string"
          ? value
          : new TextDecoder().decode(
              value instanceof ArrayBuffer
                ? value
                : value.buffer.slice(
                    value.byteOffset,
                    value.byteOffset + value.byteLength,
                  ),
            );
      values.set(key, {
        value: text,
        expiration:
          options?.expiration ??
          (options?.expirationTtl === undefined
            ? undefined
            : Math.floor(Date.now() / 1_000) + options.expirationTtl),
        metadata: options?.metadata,
      });
    },
    async delete(key: string) {
      values.delete(key);
    },
    async list(options?: { prefix?: string }) {
      const prefix = options?.prefix ?? "";
      const keys = [...values.keys()]
        .filter((name) => getRecord(name) !== undefined)
        .filter((name) => name.startsWith(prefix))
        .sort()
        .map((name) => {
          const record = values.get(name)!;
          return {
            name,
            expiration: record.expiration,
            metadata: record.metadata,
          };
        });
      return { keys, list_complete: true, cacheStatus: null };
    },
  } as unknown as KVNamespace;

  return { binding, clear: () => values.clear() };
}

const oauthKv = createMemoryKv();

function configFor(mode: AuthConfig["mode"]): AuthConfig {
  return {
    ...serverConfig.auth,
    mode,
    bearer: { ...serverConfig.auth.bearer },
    oauth: {
      ...serverConfig.auth.oauth,
      public_base_url: publicBaseUrl,
      github: { ...serverConfig.auth.oauth.github },
    },
  };
}

function createMcpHandler() {
  const fetch = vi.fn(async () => new Response("mcp-ok"));
  return { handler: { fetch } satisfies WorkerHandler, fetch };
}

async function dispatch(
  handler: WorkerHandler,
  request: Request,
  requestEnv: AuthEnv,
): Promise<Response> {
  const context = createExecutionContext();
  const response = await handler.fetch(request, requestEnv, context);
  await waitOnExecutionContext(context);
  return response;
}

function cookieHeader(response: Response, contains: string): string {
  const cookie = response.headers
    .getSetCookie()
    .find(
      (value) =>
        value.includes(contains) && !value.toLowerCase().includes("max-age=0"),
    );
  if (cookie === undefined) {
    throw new Error(`Response did not set cookie containing ${contains}`);
  }
  return cookie.split(";", 1)[0];
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  let binary = "";
  for (const byte of new Uint8Array(digest)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function callbackOAuth(): OAuthHelpers {
  return {
    finishUpstream: vi.fn(async () => ({
      request: {
        responseType: "code",
        clientId: "client",
        redirectUri: "https://client.example/callback",
        scope: ["mcp:read"],
        state: "client-state",
      },
      data: { verifier: "github-pkce-verifier" },
      headers: new Headers(),
    })),
  } as unknown as OAuthHelpers;
}

async function dispatchGitHubCallback(
  requestFetch: typeof globalThis.fetch,
  timeoutMs = 10_000,
): Promise<Response> {
  const config = configFor("oauth").oauth;
  const handler = createGitHubIdentityHandler(
    {
      ...config,
      github: { ...config.github, timeout_ms: timeoutMs },
    },
    requestFetch,
  );
  return dispatch(
    handler,
    new Request(
      `${publicBaseUrl}/oauth/callback?code=github-code&state=state`,
    ),
    {
      OAUTH_PROVIDER: callbackOAuth(),
      OPEN_DATA_MCP_GITHUB_OAUTH_CLIENT_ID: "github-client-id",
      OPEN_DATA_MCP_GITHUB_OAUTH_CLIENT_SECRET:
        "github-client-secret-with-at-least-32-characters",
    },
  );
}

function serverConfigYaml(mode: string, timeoutMs = 10_000): string {
  return `
auth:
  mode: ${mode}
  bearer:
    token_env: OPEN_DATA_MCP_BEARER_TOKEN
  oauth:
    public_base_url: https://example.test
    authorize_path: /authorize
    callback_path: /oauth/callback
    token_path: /oauth/token
    registration_path: /oauth/register
    scopes_supported: [mcp:read]
    required_scopes: [mcp:read]
    github:
      client_id_env: OPEN_DATA_MCP_GITHUB_OAUTH_CLIENT_ID
      client_secret_env: OPEN_DATA_MCP_GITHUB_OAUTH_CLIENT_SECRET
      authorize_url: https://github.com/login/oauth/authorize
      token_url: https://github.com/login/oauth/access_token
      user_url: https://api.github.com/user
      timeout_ms: ${timeoutMs}
resources:
  max_input_bytes: 5242880
  max_output_bytes: 1048576
rate_limits:
  redis:
    url_env: UPSTASH_REDIS_REST_URL
    token_env: UPSTASH_REDIS_REST_TOKEN
    timeout_ms: 1000
    key_prefix: open-data-mcp
  user:
    requests_per_minute: 60
    requests_per_24_hours: 1000
  global:
    requests_per_minute: 300
    requests_per_24_hours: 20000
  oauth:
    requests_per_minute_per_ip: 20
  providers:
    open_meteo_ie:
      requests_per_minute: 500
      requests_per_hour: 4000
      requests_per_24_hours: 8000
`;
}

describe("server auth configuration", () => {
  it("uses OAuth in the bundled production configuration", () => {
    expect(serverConfig.auth.mode).toBe("oauth");
    expect(serverConfig.auth.oauth.github.timeout_ms).toBe(10_000);
    expect(serverConfig.resources).toEqual({
      max_input_bytes: 5_242_880,
      max_output_bytes: 1_048_576,
    });
    expect(serverConfig.rate_limits).toMatchObject({
      user: {
        requests_per_minute: 60,
        requests_per_24_hours: 1_000,
      },
      global: {
        requests_per_minute: 300,
        requests_per_24_hours: 20_000,
      },
      oauth: { requests_per_minute_per_ip: 20 },
    });
    expect(Object.isFrozen(serverConfig)).toBe(true);
    expect(Object.isFrozen(serverConfig.auth.oauth)).toBe(true);
  });

  it("rejects invalid auth modes", () => {
    expect(() => parseServerConfig(serverConfigYaml("basic"))).toThrow(
      /Invalid server configuration/,
    );
  });

  it("rejects a non-positive GitHub timeout", () => {
    expect(() => parseServerConfig(serverConfigYaml("none", 0))).toThrow(
      /Invalid server configuration/,
    );
  });

  it("rejects invalid or contradictory request limits", () => {
    expect(() =>
      parseServerConfig(
        serverConfigYaml("none").replace(
          "requests_per_minute: 60",
          "requests_per_minute: 0",
        ),
      ),
    ).toThrow(/Invalid server configuration/);
    expect(() =>
      parseServerConfig(
        serverConfigYaml("none").replace(
          "requests_per_minute: 300",
          "requests_per_minute: 50",
        ),
      ),
    ).toThrow(/global minute limit must not be lower than user limit/);
  });
});

describe("auth modes", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    oauthKv.clear();
  });

  it("keeps none mode identical to the MCP handler", async () => {
    const mcp = createMcpHandler();
    const handler = createAuthHandler(configFor("none"), mcp.handler);
    const request = new Request(`${publicBaseUrl}/mcp`, { method: "POST" });

    const response = await dispatch(handler, request, {});

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("mcp-ok");
    expect(mcp.fetch).toHaveBeenCalledOnce();
  });

  it("challenges missing or invalid manual bearer tokens", async () => {
    const mcp = createMcpHandler();
    const handler = createAuthHandler(configFor("bearer"), mcp.handler);
    const requestEnv = { OPEN_DATA_MCP_BEARER_TOKEN: bearerToken };

    for (const authorization of [undefined, "Basic abc", "Bearer wrong"]) {
      const headers =
        authorization === undefined ? undefined : { Authorization: authorization };
      const response = await dispatch(
        handler,
        new Request(`${publicBaseUrl}/mcp`, { method: "POST", headers }),
        requestEnv,
      );

      expect(response.status).toBe(401);
      expect(response.headers.get("WWW-Authenticate")).toBe(
        'Bearer realm="Open Data MCP"',
      );
    }
    expect(mcp.fetch).not.toHaveBeenCalled();
  });

  it("accepts the configured bearer token without protecting other routes", async () => {
    const mcp = createMcpHandler();
    const handler = createAuthHandler(configFor("bearer"), mcp.handler);
    const requestEnv = { OPEN_DATA_MCP_BEARER_TOKEN: bearerToken };

    const authorized = await dispatch(
      handler,
      new Request(`${publicBaseUrl}/mcp`, {
        method: "POST",
        headers: { Authorization: `Bearer ${bearerToken}` },
      }),
      requestEnv,
    );
    const unrelated = await dispatch(
      handler,
      new Request(`${publicBaseUrl}/health`),
      requestEnv,
    );

    expect(authorized.status).toBe(200);
    expect(unrelated.status).toBe(200);
    expect(mcp.fetch).toHaveBeenCalledTimes(2);
  });

  it("fails closed when an active mode is missing its secret or KV", async () => {
    const mcp = createMcpHandler();
    const bearer = createAuthHandler(configFor("bearer"), mcp.handler);
    const oauth = createAuthHandler(configFor("oauth"), mcp.handler);

    const bearerResponse = await dispatch(
      bearer,
      new Request(`${publicBaseUrl}/mcp`, { method: "POST" }),
      {},
    );
    const oauthResponse = await dispatch(
      oauth,
      new Request(`${publicBaseUrl}/mcp`, { method: "POST" }),
      {},
    );

    expect(bearerResponse.status).toBe(500);
    expect(oauthResponse.status).toBe(500);
    await expect(bearerResponse.json()).resolves.toEqual({
      error: "AUTH_CONFIGURATION_ERROR",
    });
    await expect(oauthResponse.json()).resolves.toEqual({
      error: "AUTH_CONFIGURATION_ERROR",
    });
  });

  it("exposes OAuth discovery, registration, and a protected MCP challenge", async () => {
    const mcp = createMcpHandler();
    const handler = createAuthHandler(configFor("oauth"), mcp.handler);
    const requestEnv = { OAUTH_KV: oauthKv.binding };

    const challenge = await dispatch(
      handler,
      new Request(`${publicBaseUrl}/mcp`, { method: "POST" }),
      requestEnv,
    );
    const resourceMetadata = await dispatch(
      handler,
      new Request(
        `${publicBaseUrl}/.well-known/oauth-protected-resource/mcp`,
      ),
      requestEnv,
    );
    const serverMetadata = await dispatch(
      handler,
      new Request(`${publicBaseUrl}/.well-known/oauth-authorization-server`),
      requestEnv,
    );
    const unrelated = await dispatch(
      handler,
      new Request(`${publicBaseUrl}/mcp-other`),
      requestEnv,
    );

    expect(challenge.status).toBe(401);
    expect(challenge.headers.get("WWW-Authenticate")).toContain(
      `resource_metadata="${publicBaseUrl}/.well-known/oauth-protected-resource/mcp"`,
    );
    await expect(resourceMetadata.json()).resolves.toMatchObject({
      resource: `${publicBaseUrl}/mcp`,
      authorization_servers: [publicBaseUrl],
      scopes_supported: ["mcp:read"],
    });
    await expect(serverMetadata.json()).resolves.toMatchObject({
      issuer: publicBaseUrl,
      authorization_endpoint: `${publicBaseUrl}/authorize`,
      token_endpoint: `${publicBaseUrl}/oauth/token`,
      registration_endpoint: `${publicBaseUrl}/oauth/register`,
      code_challenge_methods_supported: ["S256"],
    });
    expect(unrelated.status).toBe(404);
    expect(mcp.fetch).not.toHaveBeenCalled();
  });

  it("protects the MCP path when the request origin differs from the canonical origin", async () => {
    const mcp = createMcpHandler();
    const handler = createAuthHandler(configFor("oauth"), mcp.handler);

    const response = await dispatch(
      handler,
      new Request("http://127.0.0.1:8787/mcp", { method: "POST" }),
      { OAUTH_KV: oauthKv.binding },
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toContain("Bearer");
    expect(mcp.fetch).not.toHaveBeenCalled();
  });

  it("rate limits OAuth endpoints by Cloudflare client IP", async () => {
    const mcp = createMcpHandler();
    const rateLimiter = {
      limitTool: vi.fn(async () => undefined),
      limitOAuth: vi.fn(async () => false),
    } satisfies RateLimitService;
    const handler = createAuthHandler(configFor("oauth"), mcp.handler, {
      rateLimiter,
    });
    const requestEnv = { OAUTH_KV: oauthKv.binding };

    const response = await dispatch(
      handler,
      new Request(`${publicBaseUrl}/.well-known/oauth-authorization-server`, {
        headers: { "CF-Connecting-IP": "192.0.2.1" },
      }),
      requestEnv,
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    await expect(response.json()).resolves.toEqual({ error: "RATE_LIMITED" });
    expect(rateLimiter.limitOAuth).toHaveBeenCalledWith(
      requestEnv,
      "192.0.2.1",
    );
    expect(mcp.fetch).not.toHaveBeenCalled();
  });

  it("rejects an OAuth callback without library-managed state", async () => {
    const mcp = createMcpHandler();
    const handler = createAuthHandler(configFor("oauth"), mcp.handler);
    const response = await dispatch(
      handler,
      new Request(`${publicBaseUrl}/oauth/callback?code=untrusted`),
      { OAUTH_KV: oauthKv.binding },
    );

    expect(response.status).toBe(400);
    expect(mcp.fetch).not.toHaveBeenCalled();
  });

  it("fails closed before the GitHub redirect when identity config is missing", async () => {
    const oauth = {
      approveConsent: vi.fn(async () => ({
        request: {
          responseType: "code",
          clientId: "client",
          redirectUri: "https://client.example/callback",
          scope: ["mcp:read"],
          state: "client-state",
        },
        headers: new Headers(),
      })),
    } as unknown as OAuthHelpers;
    const handler = createGitHubIdentityHandler(configFor("oauth").oauth);
    const response = await dispatch(
      handler,
      new Request(`${publicBaseUrl}/authorize`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          handle: "handle",
          decision: "approve",
          scope: "mcp:read",
        }),
      }),
      { OAUTH_PROVIDER: oauth },
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "AUTH_CONFIGURATION_ERROR",
    });
  });

  it("fails closed when the GitHub callback secret is missing", async () => {
    const oauth = {
      finishUpstream: vi.fn(async () => ({
        request: {
          responseType: "code",
          clientId: "client",
          redirectUri: "https://client.example/callback",
          scope: ["mcp:read"],
          state: "client-state",
        },
        data: { verifier: "github-pkce-verifier" },
        headers: new Headers(),
      })),
    } as unknown as OAuthHelpers;
    const handler = createGitHubIdentityHandler(configFor("oauth").oauth);
    const response = await dispatch(
      handler,
      new Request(`${publicBaseUrl}/oauth/callback?code=github-code&state=state`),
      {
        OAUTH_PROVIDER: oauth,
        OPEN_DATA_MCP_GITHUB_OAUTH_CLIENT_ID: "github-client-id",
      },
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "AUTH_CONFIGURATION_ERROR",
    });
  });

  it("maps a GitHub network rejection to a safe identity error", async () => {
    const requestFetch = vi.fn(async () => {
      throw new TypeError("network details must not escape");
    }) as unknown as typeof globalThis.fetch;

    const response = await dispatchGitHubCallback(requestFetch);

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: "IDENTITY_PROVIDER_ERROR",
    });
  });

  it("times out while waiting for GitHub response headers", async () => {
    const requestFetch = vi.fn(
      () => new Promise<Response>(() => undefined),
    ) as unknown as typeof globalThis.fetch;

    const response = await dispatchGitHubCallback(requestFetch, 10);

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: "IDENTITY_PROVIDER_ERROR",
    });
  });

  it("times out and cancels a stalled GitHub response body", async () => {
    const cancel = vi.fn();
    const requestFetch = vi.fn(async () =>
      new Response(
        new ReadableStream({
          pull: () => new Promise<void>(() => undefined),
          cancel,
        }),
        { headers: { "Content-Type": "application/json" } },
      ),
    ) as unknown as typeof globalThis.fetch;

    const response = await dispatchGitHubCallback(requestFetch, 10);

    expect(response.status).toBe(502);
    expect(cancel).toHaveBeenCalledOnce();
    await expect(response.json()).resolves.toEqual({
      error: "IDENTITY_PROVIDER_ERROR",
    });
  });

  it("maps a non-JSON GitHub token response to a safe identity error", async () => {
    const requestFetch = vi.fn(async () =>
      new Response("not-json", { status: 200 }),
    ) as unknown as typeof globalThis.fetch;

    const response = await dispatchGitHubCallback(requestFetch);

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: "IDENTITY_PROVIDER_ERROR",
    });
  });

  it("maps a non-JSON GitHub user response to a safe identity error", async () => {
    const requestFetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ access_token: "github-upstream-token" }),
      )
      .mockResolvedValueOnce(new Response("not-json", { status: 200 })) as unknown as typeof globalThis.fetch;

    const response = await dispatchGitHubCallback(requestFetch);

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: "IDENTITY_PROVIDER_ERROR",
    });
  });

  it("uses GitHub for identity and accepts the Worker-issued MCP token", async () => {
    const mcp = createMcpHandler();
    const githubFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://github.com/login/oauth/access_token") {
        return Response.json({ access_token: "github-upstream-token" });
      }
      if (url === "https://api.github.com/user") {
        return Response.json({ id: 12345, login: "test-user" });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as unknown as typeof globalThis.fetch;
    const handler = createAuthHandler(
      configFor("oauth"),
      mcp.handler,
      { fetch: githubFetch },
    );
    const requestEnv = {
      OAUTH_KV: oauthKv.binding,
      OPEN_DATA_MCP_GITHUB_OAUTH_CLIENT_ID: "github-client-id",
      OPEN_DATA_MCP_GITHUB_OAUTH_CLIENT_SECRET:
        "github-client-secret-with-at-least-32-characters",
    };
    const redirectUri = "https://client.example/callback";
    const registered = await dispatch(
      handler,
      new Request(`${publicBaseUrl}/oauth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: "Test MCP Client",
          redirect_uris: [redirectUri],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        }),
      }),
      requestEnv,
    );
    expect(registered.status).toBe(201);
    const registration = (await registered.json()) as { client_id: string };

    const verifier = "test-pkce-verifier-with-at-least-43-characters-1234567890";
    const authorizeUrl = new URL(`${publicBaseUrl}/authorize`);
    authorizeUrl.search = new URLSearchParams({
      response_type: "code",
      client_id: registration.client_id,
      redirect_uri: redirectUri,
      scope: "mcp:read",
      state: "client-state",
      code_challenge: await pkceChallenge(verifier),
      code_challenge_method: "S256",
      resource: `${publicBaseUrl}/mcp`,
    }).toString();
    const consent = await dispatch(
      handler,
      new Request(authorizeUrl),
      requestEnv,
    );
    expect(consent.status).toBe(200);
    const consentBody = await consent.text();
    const handle = consentBody.match(/name="handle" value="([^"]+)"/)?.[1];
    expect(handle).toBeDefined();

    const githubRedirect = await dispatch(
      handler,
      new Request(`${publicBaseUrl}/authorize`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: cookieHeader(consent, "consent"),
        },
        body: new URLSearchParams({
          handle: handle!,
          decision: "approve",
          scope: "mcp:read",
        }),
      }),
      requestEnv,
    );
    expect(githubRedirect.status).toBe(302);
    const githubAuthorizeUrl = new URL(
      githubRedirect.headers.get("Location")!,
    );
    expect(githubAuthorizeUrl.origin).toBe("https://github.com");
    expect(githubAuthorizeUrl.searchParams.get("code_challenge_method")).toBe(
      "S256",
    );

    const callbackUrl = new URL(`${publicBaseUrl}/oauth/callback`);
    callbackUrl.searchParams.set("code", "github-code");
    callbackUrl.searchParams.set(
      "state",
      githubAuthorizeUrl.searchParams.get("state")!,
    );
    const callback = await dispatch(
      handler,
      new Request(callbackUrl, {
        headers: { Cookie: cookieHeader(githubRedirect, "upstream") },
      }),
      requestEnv,
    );
    expect(callback.status).toBe(302);
    const clientRedirect = new URL(callback.headers.get("Location")!);
    expect(clientRedirect.origin + clientRedirect.pathname).toBe(redirectUri);
    expect(clientRedirect.searchParams.get("state")).toBe("client-state");
    const authorizationCode = clientRedirect.searchParams.get("code");
    expect(authorizationCode).not.toBeNull();

    const tokenResponse = await dispatch(
      handler,
      new Request(`${publicBaseUrl}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: registration.client_id,
          code: authorizationCode!,
          code_verifier: verifier,
          redirect_uri: redirectUri,
          resource: `${publicBaseUrl}/mcp`,
        }),
      }),
      requestEnv,
    );
    expect(tokenResponse.status).toBe(200);
    const token = (await tokenResponse.json()) as { access_token: string };

    const protectedResponse = await dispatch(
      handler,
      new Request(`${publicBaseUrl}/mcp`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token.access_token}` },
      }),
      requestEnv,
    );
    expect(protectedResponse.status).toBe(200);
    expect(await protectedResponse.text()).toBe("mcp-ok");
    expect(mcp.fetch).toHaveBeenCalledOnce();
    expect(githubFetch).toHaveBeenCalledTimes(2);
  });
});
