import { McpServer } from "@modelcontextprotocol/server";

import type { SourceRouter } from "./router";
import {
  getNoRateLimitService,
  type RateLimitService,
} from "./rate-limit";
import { registerTools } from "./tools/register";

export function createServer(
  router: SourceRouter,
  rateLimiter: RateLimitService = getNoRateLimitService(),
): McpServer {
  const server = new McpServer(
    {
      name: "ireland-open-data-mcp",
      version: "0.0.0",
    },
    {
      capabilities: { tools: {} },
    },
  );

  registerTools(server, router, rateLimiter);

  return server;
}
