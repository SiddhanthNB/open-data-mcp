import { exports } from "cloudflare:workers";
import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import type { WorkerHandler } from "../src/auth";
import { serverConfig } from "../src/config";
import { createWorkerHandler } from "../src/index";
import { getNoRateLimitService } from "../src/rate-limit";

type JsonRpcResponse = {
  result?: Record<string, unknown> & {
    content?: Array<{ type: string; text?: string }>;
    structuredContent?: Record<string, unknown>;
    tools?: Array<{
      name: string;
      inputSchema?: {
        properties?: Record<string, Record<string, unknown>>;
        required?: string[];
      };
    }>;
  };
  error?: Record<string, unknown>;
};

const protocolVersion = "2025-11-25";
const anonymousAuthConfig = { ...serverConfig.auth, mode: "none" as const };
const anonymousWorker = createWorkerHandler({
  authConfig: anonymousAuthConfig,
  rateLimiter: getNoRateLimitService(),
});

async function sendMcpRequest(
  method: string,
  params: Record<string, unknown>,
  id: number,
  worker?: WorkerHandler,
  extraHeaders?: HeadersInit,
): Promise<{ response: Response; payload: JsonRpcResponse }> {
  const request = new Request("http://example.com/mcp", {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "MCP-Protocol-Version": protocolVersion,
      ...Object.fromEntries(new Headers(extraHeaders)),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  let response: Response;
  const target = worker ?? anonymousWorker;
  const context = createExecutionContext();
  response = await target.fetch(request, {}, context);
  await waitOnExecutionContext(context);

  expect(response.status, await response.clone().text()).toBe(200);

  const body = await response.text();
  if (response.headers.get("content-type")?.includes("text/event-stream")) {
    const data = body
      .split("\n")
      .find((line) => line.startsWith("data:"))
      ?.slice(5)
      .trim();

    if (!data) {
      throw new Error(`MCP response did not contain an SSE data event: ${body}`);
    }

    return { response, payload: JSON.parse(data) as JsonRpcResponse };
  }

  return { response, payload: JSON.parse(body) as JsonRpcResponse };
}

describe("stateless MCP Worker", () => {
  it("initializes and exposes exactly the five generic tools without a session", async () => {
    const initialized = await sendMcpRequest(
      "initialize",
      {
        protocolVersion,
        capabilities: {},
        clientInfo: { name: "test-client", version: "0.0.0" },
      },
      1,
    );

    expect(initialized.response.headers.get("MCP-Session-Id")).toBeNull();
    expect(initialized.response.headers.get("X-Request-ID")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
    );
    expect(
      initialized.response.headers.get("Access-Control-Expose-Headers"),
    ).toContain("X-Request-ID");
    expect(initialized.payload.error).toBeUndefined();
    expect(initialized.payload.result).toMatchObject({
      protocolVersion,
      serverInfo: { name: "ireland-open-data-mcp" },
    });

    const listed = await sendMcpRequest("tools/list", {}, 2);
    expect(listed.response.headers.get("MCP-Session-Id")).toBeNull();
    expect(listed.payload.error).toBeUndefined();
    expect(listed.payload.result?.tools?.map((tool) => tool.name)).toEqual([
      "list_sources",
      "search_data_by_source",
      "describe_data_by_id",
      "query_data_by_id",
      "get_data_link_by_id",
    ]);
    const searchTool = listed.payload.result?.tools?.find(
      (tool) => tool.name === "search_data_by_source",
    );
    const resourceTool = listed.payload.result?.tools?.find(
      (tool) => tool.name === "query_data_by_id",
    );
    expect(searchTool?.inputSchema?.properties?.limit).toMatchObject({
      type: "integer",
      minimum: 1,
      maximum: 100,
    });
    expect(searchTool?.inputSchema?.properties).not.toHaveProperty("offset");
    expect(resourceTool?.inputSchema?.required).toEqual([
      "source",
      "data_id",
      "access_id",
    ]);
    expect(resourceTool?.inputSchema?.properties?.limit).toMatchObject({
      type: "integer",
      minimum: 1,
      maximum: 100,
    });
    expect(resourceTool?.inputSchema?.properties).not.toHaveProperty("offset");
  });

  it("routes a real tool call through the adapter and direct resource loader", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.hostname === "data.gov.ie") {
        return Response.json({
          success: true,
          result: {
            id: "roads",
            name: "roads",
            title: "Roads",
            owner_org: "publisher",
            organization: { title: "Publisher" },
            resources: [
              {
                id: "roads-json",
                format: "JSON",
                url: "https://files.example.test/roads.json",
                datastore_active: false,
              },
            ],
          },
        });
      }
      if (url.href === "https://files.example.test/roads.json") {
        return Response.json([{ id: 1 }, { id: 2 }]);
      }
      throw new Error(`Unexpected upstream request: ${url.href}`);
    }) as unknown as typeof fetch;
    const worker = createWorkerHandler({
      fetch: fetcher,
      now: () => new Date("2026-10-04T14:00:00.000Z"),
      authConfig: anonymousAuthConfig,
      rateLimiter: getNoRateLimitService(),
    });

    const first = await sendMcpRequest(
      "tools/call",
      {
        name: "query_data_by_id",
        arguments: {
          source: "data_gov_ie",
          data_id: "roads",
          access_id: "roads-json",
          limit: 1,
        },
      },
      3,
      worker,
    );
    const cursor = first.payload.result?.structuredContent?.next_cursor;
    expect(cursor).toEqual(expect.any(String));

    const { response, payload } = await sendMcpRequest(
      "tools/call",
      {
        name: "query_data_by_id",
        arguments: {
          source: "data_gov_ie",
          data_id: "roads",
          access_id: "roads-json",
          limit: 1,
          cursor,
        },
      },
      4,
      worker,
    );

    expect(response.headers.get("MCP-Session-Id")).toBeNull();
    expect(payload.error).toBeUndefined();
    expect(payload.result?.structuredContent).toEqual({
      source: "data_gov_ie",
      data_id: "roads",
      access_id: "roads-json",
      data: [{ id: 2 }],
      provenance: {
        source: "data_gov_ie",
        upstream_url: "https://files.example.test/roads.json",
        retrieved_at: "2026-10-04T14:00:00.000Z",
        original_format: "json",
      },
      pagination_supported: true,
      returned: 1,
      total: 2,
      truncated: false,
    });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("keeps unrelated routes outside the production auth and MCP endpoints", async () => {
    const response = await exports.default.fetch("http://example.com/", {
      method: "GET",
    });

    expect(response.status).toBe(404);
  });

  it("starts a fresh trace instead of accepting inbound trace context", async () => {
    const inboundTraceId = "11111111111111111111111111111111";
    const result = await sendMcpRequest(
      "initialize",
      {
        protocolVersion,
        capabilities: {},
        clientInfo: { name: "test-client", version: "0.0.0" },
      },
      5,
      undefined,
      {
        traceparent: `00-${inboundTraceId}-2222222222222222-01`,
      },
    );

    expect(result.response.headers.get("X-Request-ID")?.replaceAll("-", ""))
      .not.toBe(inboundTraceId);
  });

  it("serves an untraced debug-only health check", async () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const worker = createWorkerHandler({
      authConfig: anonymousAuthConfig,
      rateLimiter: getNoRateLimitService(),
    });
    const context = createExecutionContext();

    const response = await worker.fetch(
      new Request("http://example.com/ping"),
      { OPEN_DATA_MCP_LOG_LEVEL: "debug" },
      context,
    );
    await waitOnExecutionContext(context);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
    expect(response.headers.get("X-Request-ID")).toBeNull();
    expect(debug).toHaveBeenCalledWith(
      "[DEBUG] [trace: -] [span: -] : Health check completed",
    );
  });
});
