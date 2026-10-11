import type { AuthConfig } from "../config";
import {
  AuthConfigurationError,
  configurationErrorResponse,
  requireSecret,
} from "./secrets";
import type { AuthEnv, WorkerHandler } from "./types";

const encoder = new TextEncoder();

async function constantTimeEqual(left: string, right: string): Promise<boolean> {
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  const leftBytes = new Uint8Array(leftHash);
  const rightBytes = new Uint8Array(rightHash);
  let difference = 0;

  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= leftBytes[index] ^ rightBytes[index];
  }

  return difference === 0;
}

function presentedBearerToken(request: Request): string | undefined {
  const authorization = request.headers.get("Authorization");
  const match = authorization?.match(/^Bearer[ \t]+([^\s]+)$/i);
  return match?.[1];
}

function bearerChallenge(): Response {
  return Response.json(
    { error: "UNAUTHORIZED" },
    {
      status: 401,
      headers: {
        "WWW-Authenticate": 'Bearer realm="Open Data MCP"',
      },
    },
  );
}

export function createBearerHandler(
  config: AuthConfig["bearer"],
  mcpHandler: WorkerHandler,
): WorkerHandler {
  return {
    async fetch(request, env, context) {
      if (new URL(request.url).pathname !== "/mcp") {
        return mcpHandler.fetch(request, env, context);
      }

      let expectedToken: string;
      try {
        expectedToken = requireSecret(env, config.token_env);
      } catch (error) {
        if (error instanceof AuthConfigurationError) {
          return configurationErrorResponse();
        }
        throw error;
      }

      const token = presentedBearerToken(request);
      if (token === undefined || !(await constantTimeEqual(token, expectedToken))) {
        return bearerChallenge();
      }

      return mcpHandler.fetch(request, env, context);
    },
  };
}
