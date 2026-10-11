import {
  AuthorizationError,
  CimdFetchError,
  authorizationErrorRedirect,
  type ConsentDescription,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";

import type { OAuthConfig } from "../config";
import {
  AuthConfigurationError,
  configurationErrorResponse,
  requireEnvironmentValue,
  requireSecret,
} from "./secrets";
import type { AuthEnv, WorkerHandler } from "./types";

class GitHubIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubIdentityError";
  }
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) => `&#${character.charCodeAt(0)};`,
  );
}

function consentPage(details: ConsentDescription, handle: string): string {
  const scopes = details.scope
    .map(
      (scope) =>
        `<label><input type="checkbox" name="scope" value="${escapeHtml(scope)}" checked> ${escapeHtml(scope)}</label>`,
    )
    .join("<br>");
  const clientSource = details.clientDomain
    ? `Published by <strong>${escapeHtml(details.clientDomain)}</strong>.`
    : "This client registered itself; its name is not verified.";
  const loopbackWarning = details.redirectIsLoopback
    ? "<p><strong>This sends access to an app on this device. Continue only if you started this sign-in.</strong></p>"
    : "";

  return `<!doctype html>
<meta charset="utf-8">
<title>Authorize ${escapeHtml(details.clientName)}</title>
<h1>Allow ${escapeHtml(details.clientName)} to access Open Data MCP?</h1>
<p>${clientSource} Access will be sent to <strong>${escapeHtml(details.redirectHost)}</strong>.</p>
${loopbackWarning}
<form method="post">
  <input type="hidden" name="handle" value="${escapeHtml(handle)}">
  ${scopes}
  <p><button name="decision" value="approve">Allow</button> <button name="decision" value="deny">Deny</button></p>
</form>`;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function createPkce(): Promise<{
  verifier: string;
  challenge: string;
}> {
  const verifierBytes = crypto.getRandomValues(new Uint8Array(32));
  const verifier = base64Url(verifierBytes);
  const challenge = base64Url(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
    ),
  );
  return { verifier, challenge };
}

function getOAuth(env: AuthEnv): OAuthHelpers {
  if (env.OAUTH_PROVIDER === undefined) {
    throw new AuthConfigurationError("OAuth helpers were not injected");
  }
  return env.OAUTH_PROVIDER;
}

async function requestJson(
  requestFetch: typeof globalThis.fetch,
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ response: Response; body: unknown }> {
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = Date.now() + timeoutMs;
  const timeoutError = new GitHubIdentityError("GitHub request timed out");
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(timeoutError);
    }, timeoutMs);
  });

  const operation = async () => {
    const response = await requestFetch(input, {
      ...init,
      signal: controller.signal,
    });
    if (response.body === null) {
      throw new GitHubIdentityError("GitHub returned an empty response");
    }

    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) {
          text += decoder.decode();
          break;
        }
        text += decoder.decode(result.value, { stream: true });
      }
    } finally {
      reader.releaseLock();
      reader = undefined;
    }

    let body: unknown;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      throw new GitHubIdentityError("GitHub returned invalid JSON");
    }
    if (Date.now() >= deadline) {
      throw timeoutError;
    }
    return { response, body };
  };

  try {
    return await Promise.race([operation(), timeoutPromise]);
  } catch (cause) {
    controller.abort();
    if (reader !== undefined) {
      try {
        await reader.cancel();
      } catch {
        // The abort may already have closed the response body.
      }
    }
    if (cause instanceof GitHubIdentityError) {
      throw cause;
    }
    throw new GitHubIdentityError("GitHub request failed");
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

async function exchangeGitHubCode(
  requestFetch: typeof globalThis.fetch,
  config: OAuthConfig,
  clientId: string,
  clientSecret: string,
  code: string,
  verifier: string,
): Promise<string> {
  const { response, body } = await requestJson(
    requestFetch,
    config.github.token_url,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        code_verifier: verifier,
        redirect_uri: `${config.public_base_url}${config.callback_path}`,
      }),
    },
    config.github.timeout_ms,
  );

  if (
    !response.ok ||
    typeof body !== "object" ||
    body === null ||
    !("access_token" in body) ||
    typeof body.access_token !== "string"
  ) {
    throw new GitHubIdentityError("GitHub token exchange failed");
  }

  return body.access_token;
}

async function getGitHubUser(
  requestFetch: typeof globalThis.fetch,
  config: OAuthConfig,
  accessToken: string,
): Promise<{ id: string; login: string }> {
  const { response, body } = await requestJson(
    requestFetch,
    config.github.user_url,
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": "open-data-mcp",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
    config.github.timeout_ms,
  );

  if (
    !response.ok ||
    typeof body !== "object" ||
    body === null ||
    !("id" in body) ||
    !(typeof body.id === "number" || typeof body.id === "string") ||
    !("login" in body) ||
    typeof body.login !== "string"
  ) {
    throw new GitHubIdentityError("GitHub user lookup failed");
  }

  return { id: String(body.id), login: body.login };
}

async function handleAuthorizeGet(
  request: Request,
  oauth: OAuthHelpers,
): Promise<Response> {
  const authRequest = await oauth.parseAuthRequest(request);
  const details = await oauth.describeConsent(authRequest);
  const consent = await oauth.beginConsent(authRequest);
  consent.headers.set("Content-Type", "text/html; charset=utf-8");
  return new Response(consentPage(details, consent.handle), {
    headers: consent.headers,
  });
}

async function handleAuthorizePost(
  request: Request,
  env: AuthEnv,
  oauth: OAuthHelpers,
  config: OAuthConfig,
): Promise<Response> {
  const form = await request.formData();
  const handle = String(form.get("handle") ?? "");

  if (form.get("decision") !== "approve") {
    const denied = await oauth.denyConsent(request, handle);
    return new Response(null, { status: 302, headers: denied.headers });
  }

  const approved = await oauth.approveConsent(request, handle, {
    scope: form.getAll("scope").map(String),
  });
  const clientId = requireEnvironmentValue(env, config.github.client_id_env);
  const { verifier, challenge } = await createPkce();
  const upstream = await oauth.beginUpstream(approved.request, {
    data: { verifier },
    headers: approved.headers,
  });
  const githubUrl = new URL(config.github.authorize_url);
  githubUrl.searchParams.set("client_id", clientId);
  githubUrl.searchParams.set(
    "redirect_uri",
    `${config.public_base_url}${config.callback_path}`,
  );
  githubUrl.searchParams.set("state", upstream.state);
  githubUrl.searchParams.set("code_challenge", challenge);
  githubUrl.searchParams.set("code_challenge_method", "S256");
  upstream.headers.set("Location", githubUrl.toString());

  return new Response(null, { status: 302, headers: upstream.headers });
}

async function handleCallback(
  request: Request,
  env: AuthEnv,
  oauth: OAuthHelpers,
  config: OAuthConfig,
  requestFetch: typeof globalThis.fetch,
): Promise<Response> {
  const resumed = await oauth.finishUpstream<{ verifier: string }>(request);
  const url = new URL(request.url);

  if (url.searchParams.has("error")) {
    resumed.headers.set(
      "Location",
      authorizationErrorRedirect(resumed.request, "access_denied"),
    );
    return new Response(null, { status: 302, headers: resumed.headers });
  }

  const code = url.searchParams.get("code");
  if (code === null || typeof resumed.data?.verifier !== "string") {
    resumed.headers.set(
      "Location",
      authorizationErrorRedirect(
        resumed.request,
        "invalid_request",
        "GitHub did not return an authorization code",
      ),
    );
    return new Response(null, { status: 302, headers: resumed.headers });
  }

  const clientId = requireEnvironmentValue(env, config.github.client_id_env);
  const clientSecret = requireSecret(env, config.github.client_secret_env);
  const githubToken = await exchangeGitHubCode(
    requestFetch,
    config,
    clientId,
    clientSecret,
    code,
    resumed.data.verifier,
  );
  const user = await getGitHubUser(requestFetch, config, githubToken);
  const completed = await oauth.completeAuthorization({
    request: resumed.request,
    userId: `github-${user.id}`,
    metadata: { github_login: user.login },
    scope: resumed.request.scope,
    props: { github_user_id: user.id, github_login: user.login },
  });
  resumed.headers.set("Location", completed.redirectTo);
  return new Response(null, { status: 302, headers: resumed.headers });
}

function oauthErrorResponse(error: unknown): Response | undefined {
  if (error instanceof AuthorizationError && error.redirectTo !== undefined) {
    return Response.redirect(error.redirectTo, 302);
  }
  if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
    const message =
      error instanceof AuthorizationError
        ? error.description
        : "The OAuth client could not be verified.";
    return new Response(message, {
      status: 400,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  if (error instanceof AuthConfigurationError) {
    return configurationErrorResponse();
  }
  if (error instanceof GitHubIdentityError) {
    return Response.json({ error: "IDENTITY_PROVIDER_ERROR" }, { status: 502 });
  }
  return undefined;
}

export function createGitHubIdentityHandler(
  config: OAuthConfig,
  requestFetch: typeof globalThis.fetch = globalThis.fetch,
): WorkerHandler {
  return {
    async fetch(request, env) {
      const url = new URL(request.url);
      if (url.origin !== config.public_base_url) {
        return new Response("Not Found", { status: 404 });
      }

      try {
        const oauth = getOAuth(env);
        if (url.pathname === config.authorize_path) {
          if (request.method === "GET") {
            return await handleAuthorizeGet(request, oauth);
          }
          if (request.method === "POST") {
            return await handleAuthorizePost(request, env, oauth, config);
          }
          return new Response("Method Not Allowed", {
            status: 405,
            headers: { Allow: "GET, POST" },
          });
        }

        if (url.pathname === config.callback_path) {
          if (request.method !== "GET") {
            return new Response("Method Not Allowed", {
              status: 405,
              headers: { Allow: "GET" },
            });
          }
          return await handleCallback(
            request,
            env,
            oauth,
            config,
            requestFetch,
          );
        }

        return new Response("Not Found", { status: 404 });
      } catch (error) {
        const response = oauthErrorResponse(error);
        if (response !== undefined) {
          return response;
        }
        throw error;
      }
    },
  };
}
