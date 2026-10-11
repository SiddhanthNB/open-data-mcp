import { createMcpHandler } from "agents/mcp/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { providerConfigs, serverConfig } from "../src/config";
import { AppError } from "../src/errors";
import { SOURCES } from "../src/models";
import type {
  DataLink,
  DataDescription,
  DataSearchResult,
  ProviderCapabilities,
  ProviderConfig,
  QueryDataResult,
  Source,
} from "../src/models";
import type {
  GetDataLinkInput,
  DescribeDataInput,
  QueryDataInput,
  ProviderAdapter,
  SearchDataInput,
} from "../src/providers/provider";
import { SourceRouter } from "../src/router";
import {
  createRateLimitService,
  type RateLimitService,
} from "../src/rate-limit";
import { createServer } from "../src/server";

const commonMaximumLimit = Math.min(
  ...Object.values(providerConfigs).map(
    (config) => config.pagination.max_limit,
  ),
);

type ToolContent = {
  type: string;
  text?: string;
  uri?: string;
  name?: string;
};

type ToolResult = {
  content?: ToolContent[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
};

type JsonRpcResponse = {
  result?: ToolResult & {
    tools?: Array<{
      name: string;
      description?: string;
      inputSchema: {
        properties?: Record<string, Record<string, unknown>>;
        required?: string[];
      };
    }>;
  };
  error?: Record<string, unknown>;
};

const protocolVersion = "2025-11-25";
const provenance = {
  source: "data_gov_ie" as const,
  upstream_url: "https://example.com/dataset/roads",
  retrieved_at: "2026-10-04T12:00:00.000Z",
};

const searchResult: DataSearchResult = {
  results: [
    {
      data_id: "roads",
      title: "Roads",
      available_formats: ["json", "xlsx"],
      provenance,
    },
  ],
  pagination: { limit: 1, offset: 0, returned: 1, total: 2 },
};

const dataset: DataDescription = {
  ...searchResult.results[0],
  access_points: [
    {
      access_id: "roads-json",
      title: "Road rows",
      format: "json",
      capabilities: { query: true, link: true },
      query_schema: {
        fields: [
          {
            name: "status",
            type: "string",
            operators: ["eq", "in"],
            values: [
              { value: "open", label: "Open" },
              { value: "closed", label: "Closed" },
            ],
            values_truncated: false,
          },
        ],
        truncated: false,
        spatial: ["bbox"],
      },
      upstream_url: "https://example.com/resource/roads.json",
    },
    {
      access_id: "roads-xlsx",
      format: "xlsx",
      capabilities: { query: false, link: true },
      upstream_url: "https://example.com/resource/roads.xlsx",
    },
  ],
};

const resource: QueryDataResult = {
  data_id: "roads",
  access_id: "roads-json",
  data: [{ id: 1 }],
  provenance: { ...provenance, original_format: "json" },
  pagination_supported: true,
  pagination: { limit: 1, offset: 0, returned: 1, total: 2 },
};

const dataLink: DataLink = {
  data_id: "roads",
  access_id: "roads-xlsx",
  url: "https://example.com/files/roads.xlsx",
  format: "xlsx",
  title: "Road workbook",
  size: 1234,
  provenance: {
    ...provenance,
    upstream_url: "https://example.com/files/roads.xlsx",
    original_format: "xlsx",
  },
};

function createAdapter(
  provider: Source,
  capabilities: ProviderCapabilities,
): ProviderAdapter {
  const config: ProviderConfig = {
    provider,
    type: "catalogue",
    base_url: "https://example.com",
    endpoints: {},
    http_timeout_ms: 5_000,
    pagination: { default_limit: 10, max_limit: 100 },
    capabilities,
    formats: ["json"],
  };

  return {
    config,
    searchData: vi.fn(async (_input: SearchDataInput) => searchResult),
    describeData: vi.fn(async (_input: DescribeDataInput) => dataset),
    queryData: vi.fn(async (_input: QueryDataInput) => resource),
    getDataLink: vi.fn(async (_input: GetDataLinkInput) => dataLink),
  };
}

const allCapabilities: ProviderCapabilities = {
  search_data_by_source: true,
  describe_data_by_id: true,
  query_data_by_id: true,
  get_data_link_by_id: true,
};

const dataGovAdapter = createAdapter("data_gov_ie", allCapabilities);
const smartDublinAdapter = createAdapter("smart_dublin", allCapabilities);
const metEireannAdapter = createAdapter("met_eireann", {
  ...allCapabilities,
  query_data_by_id: false,
});
const openMeteoAdapter = createAdapter("open_meteo_ie", {
  ...allCapabilities,
  get_data_link_by_id: false,
});
const remainingAdapters = SOURCES.slice(4).map((source) =>
  createAdapter(source, allCapabilities),
);
const router = new SourceRouter([
  dataGovAdapter,
  smartDublinAdapter,
  metEireannAdapter,
  openMeteoAdapter,
  ...remainingAdapters,
]);
const rateLimiter = {
  limitTool: vi.fn(async () => undefined),
  limitOAuth: vi.fn(async () => true),
} satisfies RateLimitService;
const handler = createMcpHandler(() => createServer(router, rateLimiter), {
  route: "/mcp",
  legacy: "stateless",
});

async function sendMcpRequest(
  method: string,
  params: Record<string, unknown>,
  id: number,
  requestHandler: typeof handler = handler,
): Promise<{ response: Response; payload: JsonRpcResponse }> {
  const response = await requestHandler.fetch(
    new Request("http://example.com/mcp", {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        "MCP-Protocol-Version": protocolVersion,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    }),
  );

  const body = await response.text();
  const data = response.headers.get("content-type")?.includes("text/event-stream")
    ? body
        .split("\n")
        .find((line) => line.startsWith("data:"))
        ?.slice(5)
        .trim()
    : body;

  if (!data) {
    throw new Error(`MCP response did not contain a result: ${body}`);
  }

  return { response, payload: JSON.parse(data) as JsonRpcResponse };
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const { payload } = await sendMcpRequest(
    "tools/call",
    { name, arguments: args },
    1,
  );

  expect(payload.error).toBeUndefined();
  expect(payload.result).toBeDefined();
  return payload.result!;
}

function errorContent(result: ToolResult): unknown {
  return JSON.parse(result.content?.[0]?.text ?? "null") as unknown;
}

describe("source-neutral MCP tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("discovers exactly the five source-neutral tools", async () => {
    const { response, payload } = await sendMcpRequest("tools/list", {}, 1);

    expect(response.status).toBe(200);
    expect(response.headers.get("MCP-Session-Id")).toBeNull();
    expect(payload.result?.tools?.map((tool) => tool.name)).toEqual([
      "list_sources",
      "search_data_by_source",
      "describe_data_by_id",
      "query_data_by_id",
      "get_data_link_by_id",
    ]);
    const search = payload.result?.tools?.find(
      (tool) => tool.name === "search_data_by_source",
    );
    const query = payload.result?.tools?.find(
      (tool) => tool.name === "query_data_by_id",
    );
    expect(search?.description).toContain(
      "60 per rolling minute and 1000 per rolling 24 hours per user",
    );
    expect(search?.description).toContain(
      "open_meteo_ie additionally has shared global limits of 500 per minute, 4000 per hour, and 8000 per 24 hours",
    );
    expect(search?.description).toContain(
      "Independent calls may run in parallel; use at most 3 concurrent calls",
    );
    expect(search?.description).toContain(
      "Fetch cursor pages for the same query sequentially",
    );
    expect(search?.inputSchema.required).toEqual(["source"]);
    expect(search?.inputSchema.properties).not.toHaveProperty("offset");
    expect(search?.inputSchema.properties?.limit).toMatchObject({
      type: "integer",
      minimum: 1,
      maximum: commonMaximumLimit,
    });
    expect(search?.inputSchema.properties?.cursor).toMatchObject({
      type: "string",
      minLength: 1,
    });
    expect(query?.inputSchema.required).toEqual([
      "source",
      "data_id",
      "access_id",
    ]);
    expect(query?.inputSchema.properties).not.toHaveProperty("offset");
    expect(query?.inputSchema.properties?.fields).toMatchObject({
      type: "array",
      minItems: 1,
      maxItems: 10,
    });
    expect(query?.inputSchema.properties?.filters).toMatchObject({
      type: "array",
      minItems: 1,
      maxItems: 20,
    });
    expect(query?.inputSchema.properties?.spatial).toHaveProperty("oneOf");
    expect(query?.inputSchema.properties?.time_range).toMatchObject({
      type: "object",
    });
    expect(rateLimiter.limitTool).not.toHaveBeenCalled();
  });

  it("limits valid tool executions but not discovery or invalid input", async () => {
    await sendMcpRequest("tools/list", {}, 1);
    await callTool("search_data_by_source", {
      source: "data_gov_ie",
      limit: 0,
    });
    expect(rateLimiter.limitTool).not.toHaveBeenCalled();

    await callTool("search_data_by_source", { source: "data_gov_ie" });
    expect(rateLimiter.limitTool).toHaveBeenCalledOnce();
    expect(rateLimiter.limitTool).toHaveBeenCalledWith({
      source: "data_gov_ie",
    });
  });

  it("returns structured retry timing when a tool is rate limited", async () => {
    vi.mocked(rateLimiter.limitTool).mockRejectedValueOnce(
      new AppError(
        "RATE_LIMITED",
        "The MCP request rate limit was exceeded.",
        { retry_after_seconds: 37 },
      ),
    );

    const result = await callTool("list_sources", {});

    expect(result.isError).toBe(true);
    expect(errorContent(result)).toEqual({
      error: "RATE_LIMITED",
      message: "The MCP request rate limit was exceeded.",
      retry_after_seconds: 37,
    });
  });

  it("uses the authenticated GitHub user ID as the tool limit key", async () => {
    const userMinute = { limit: vi.fn(async () => ({ success: true })) };
    const allow = () => ({ limit: vi.fn(async () => ({ success: true })) });
    const authenticatedRateLimiter = createRateLimitService(
      serverConfig.rate_limits,
      {
        environment: () => ({
          UPSTASH_REDIS_REST_URL: "https://redis.example.test",
          UPSTASH_REDIS_REST_TOKEN: "token",
          MCP_USER_RATE_LIMITER: allow(),
          MCP_GLOBAL_RATE_LIMITER: allow(),
        }),
        createRedisLimiters: () => ({
          userMinute,
          userDay: allow(),
          globalMinute: allow(),
          globalDay: allow(),
          oauthMinute: allow(),
          openMeteoMinute: allow(),
          openMeteoHour: allow(),
          openMeteoDay: allow(),
        }),
      },
    );
    const authenticatedHandler = createMcpHandler(
      () => createServer(router, authenticatedRateLimiter),
      {
        route: "/mcp",
        legacy: "stateless",
        authContext: { props: { github_user_id: "456" } },
      },
    );

    await sendMcpRequest(
      "tools/call",
      { name: "list_sources", arguments: {} },
      2,
      authenticatedHandler,
    );

    expect(userMinute.limit).toHaveBeenCalledWith("github:456");
  });

  it("enforces the shared output limit for non-query responses", async () => {
    vi.mocked(dataGovAdapter.searchData).mockResolvedValueOnce({
      results: [
        {
          data_id: "oversized",
          title: "x".repeat(1_100_000),
          provenance,
        },
      ],
      pagination: { limit: 1, offset: 0, returned: 1, total: 1 },
    });

    const result = await callTool("search_data_by_source", {
      source: "data_gov_ie",
    });

    expect(result.isError).toBe(true);
    expect(errorContent(result)).toEqual({
      error: "RESOURCE_TOO_LARGE",
      message: "The requested resource exceeds the configured size limit.",
    });
  });

  it("lists configuration-driven source capabilities", async () => {
    const result = await callTool("list_sources", {});

    expect(result.structuredContent).toMatchObject({
      sources: router.listSources(),
      rate_limits: {
        algorithm: "sliding_window",
        fallback: "cloudflare_native_per_location",
        per_user: {
          requests_per_minute: 60,
          requests_per_24_hours: 1_000,
        },
        global: {
          requests_per_minute: 300,
          requests_per_24_hours: 20_000,
        },
        providers: {
          open_meteo_ie: {
            enabled: false,
            scope: "global",
            requests_per_minute: 500,
            requests_per_hour: 4_000,
            requests_per_24_hours: 8_000,
          },
        },
        planning: {
          quota_units_per_valid_tool_call: 1,
          recommended_max_parallel_independent_calls: 3,
          cursor_pages_for_same_query: "sequential",
          rate_limited_response: "retry_after_seconds",
        },
      },
    });
    expect(result.structuredContent?.sources).toHaveLength(SOURCES.length);
    expect(result.structuredContent?.sources).toContainEqual(
      expect.objectContaining({
        source: "open_meteo_ie",
        authoritative: false,
      }),
    );
  });

  it("normalizes search results and continues with an opaque cursor", async () => {
    const first = await callTool("search_data_by_source", {
      source: "data_gov_ie",
      query: "roads",
      limit: 1,
    });

    expect(dataGovAdapter.searchData).toHaveBeenLastCalledWith({
      query: "roads",
      limit: 1,
      offset: 0,
    });
    expect(first.structuredContent).toMatchObject({
      source: "data_gov_ie",
      results: [
        {
          data_id: "roads",
          title: "Roads",
          available_formats: ["json", "xlsx"],
        },
      ],
      returned: 1,
      total: 2,
      truncated: true,
      next_cursor: expect.any(String),
    });
    expect(JSON.stringify(first.structuredContent)).not.toContain("dataset_id");
    expect(JSON.stringify(first.structuredContent)).not.toContain("offset");

    await callTool("search_data_by_source", {
      source: "data_gov_ie",
      cursor: first.structuredContent?.next_cursor,
    });
    expect(dataGovAdapter.searchData).toHaveBeenLastCalledWith({
      query: "roads",
      limit: undefined,
      offset: 1,
    });
  });

  it("describes neutral access points with query and link capabilities", async () => {
    const result = await callTool("describe_data_by_id", {
      source: "smart_dublin",
      data_id: "roads",
    });

    expect(smartDublinAdapter.describeData).toHaveBeenCalledWith({
      data_id: "roads",
    });
    expect(result.structuredContent).toMatchObject({
      data_id: "roads",
      access_points: [
        {
          access_id: "roads-json",
          format: "json",
          capabilities: { query: true, link: true },
          query_schema: {
            fields: [
              expect.objectContaining({
                name: "status",
                operators: ["eq", "in"],
                values_truncated: false,
              }),
            ],
            truncated: false,
            spatial: ["bbox"],
          },
        },
        {
          access_id: "roads-xlsx",
          format: "xlsx",
          capabilities: { query: false, link: true },
        },
      ],
    });
    expect(JSON.stringify(result.structuredContent)).not.toContain("resource_id");
    expect(JSON.stringify(result.structuredContent)).not.toContain("supported");
  });

  it("queries structured data and binds continuation cursors to all IDs", async () => {
    const first = await callTool("query_data_by_id", {
      source: "data_gov_ie",
      data_id: "roads",
      access_id: "roads-json",
      limit: 1,
    });

    expect(dataGovAdapter.queryData).toHaveBeenLastCalledWith({
      data_id: "roads",
      access_id: "roads-json",
      limit: 1,
      offset: 0,
    });
    expect(first.structuredContent).toMatchObject({
      source: "data_gov_ie",
      data_id: "roads",
      access_id: "roads-json",
      data: [{ id: 1 }],
      pagination_supported: true,
      returned: 1,
      total: 2,
      truncated: true,
      next_cursor: expect.any(String),
    });

    await callTool("query_data_by_id", {
      source: "data_gov_ie",
      data_id: "roads",
      access_id: "roads-json",
      cursor: first.structuredContent?.next_cursor,
    });
    expect(dataGovAdapter.queryData).toHaveBeenLastCalledWith({
      data_id: "roads",
      access_id: "roads-json",
      limit: undefined,
      offset: 1,
    });

    const mismatched = await callTool("query_data_by_id", {
      source: "data_gov_ie",
      data_id: "other",
      access_id: "roads-json",
      cursor: first.structuredContent?.next_cursor,
    });
    expect(mismatched.isError).toBe(true);
    expect(errorContent(mismatched)).toEqual({
      error: "INVALID_REQUEST",
      message: 'The "cursor" field is invalid or does not match this request.',
    });
  });

  it("passes normalized selectors and binds them to continuation cursors", async () => {
    const first = await callTool("query_data_by_id", {
      source: "data_gov_ie",
      data_id: "roads",
      access_id: "roads-json",
      fields: [" id ", "name"],
      filters: [
        { field: " status ", operator: "in", value: ["open", "closed"] },
        { field: "score", operator: "gte", value: 10 },
      ],
      spatial: {
        type: "bbox",
        west: -10.7,
        south: 51.3,
        east: -5.4,
        north: 55.5,
      },
      time_range: {
        start: "2026-10-10T01:00:00+01:00",
        end: "2026-10-11T01:00:00+01:00",
      },
      limit: 1,
    });

    const selectors = {
      fields: ["id", "name"],
      filters: [
        { field: "status", operator: "in", value: ["open", "closed"] },
        { field: "score", operator: "gte", value: 10 },
      ],
      spatial: {
        type: "bbox" as const,
        west: -10.7,
        south: 51.3,
        east: -5.4,
        north: 55.5,
      },
      time_range: {
        start: "2026-10-10T00:00:00.000Z",
        end: "2026-10-11T00:00:00.000Z",
      },
    };
    expect(dataGovAdapter.queryData).toHaveBeenLastCalledWith({
      data_id: "roads",
      access_id: "roads-json",
      ...selectors,
      limit: 1,
      offset: 0,
    });

    await callTool("query_data_by_id", {
      source: "data_gov_ie",
      data_id: "roads",
      access_id: "roads-json",
      cursor: first.structuredContent?.next_cursor,
    });
    expect(dataGovAdapter.queryData).toHaveBeenLastCalledWith({
      data_id: "roads",
      access_id: "roads-json",
      ...selectors,
      limit: undefined,
      offset: 1,
    });

    const mismatched = await callTool("query_data_by_id", {
      source: "data_gov_ie",
      data_id: "roads",
      access_id: "roads-json",
      fields: ["name"],
      cursor: first.structuredContent?.next_cursor,
    });
    expect(errorContent(mismatched)).toEqual({
      error: "INVALID_REQUEST",
      message: 'The "cursor" field is invalid or does not match this request.',
    });
  });

  it("returns an MCP resource link without querying the resource", async () => {
    const result = await callTool("get_data_link_by_id", {
      source: "data_gov_ie",
      data_id: "roads",
      access_id: "roads-xlsx",
    });

    expect(dataGovAdapter.getDataLink).toHaveBeenCalledWith({
      data_id: "roads",
      access_id: "roads-xlsx",
    });
    expect(dataGovAdapter.queryData).not.toHaveBeenCalled();
    expect(result.structuredContent).toEqual(dataLink);
    expect(result.content?.[1]).toMatchObject({
      type: "resource_link",
      uri: dataLink.url,
      name: "roads.xlsx",
      title: "Road workbook",
      size: 1234,
    });
  });

  it("rejects unsafe links returned by an adapter", async () => {
    vi.mocked(dataGovAdapter.getDataLink).mockResolvedValueOnce({
      ...dataLink,
      url: "https://user:password@example.com/roads.xlsx",
    });

    const result = await callTool("get_data_link_by_id", {
      source: "data_gov_ie",
      data_id: "roads",
      access_id: "roads-xlsx",
    });

    expect(result.isError).toBe(true);
    expect(errorContent(result)).toEqual({
      error: "UNSUPPORTED_OPERATION",
      message:
        "The requested access point does not provide a safe browser-openable link.",
    });
    expect(result.content).toHaveLength(1);
  });

  it("serializes source and capability errors", async () => {
    const invalidSource = await callTool("describe_data_by_id", {
      source: "unknown",
      data_id: "roads",
    });
    const unsupported = await callTool("query_data_by_id", {
      source: "met_eireann",
      data_id: "roads",
      access_id: "roads-json",
    });

    expect(errorContent(invalidSource)).toEqual({
      error: "INVALID_SOURCE",
      message: "The requested source is not supported.",
    });
    expect(errorContent(unsupported)).toEqual({
      error: "UNSUPPORTED_OPERATION",
      message: "The requested operation is not supported by this source.",
    });
  });

  it("returns field-specific validation and malformed-cursor errors", async () => {
    const invalidLimit = await callTool("search_data_by_source", {
      source: "data_gov_ie",
      limit: commonMaximumLimit + 1,
    });
    const missingData = await callTool("query_data_by_id", {
      source: "data_gov_ie",
      access_id: "roads-json",
    });
    const missingAccess = await callTool("get_data_link_by_id", {
      source: "data_gov_ie",
      data_id: "roads",
    });
    const invalidCursor = await callTool("query_data_by_id", {
      source: "data_gov_ie",
      data_id: "roads",
      access_id: "roads-json",
      cursor: "not-a-valid-cursor",
    });
    const duplicateFields = await callTool("query_data_by_id", {
      source: "data_gov_ie",
      data_id: "roads",
      access_id: "roads-json",
      fields: ["id", " id "],
    });
    const invalidSpatial = await callTool("query_data_by_id", {
      source: "data_gov_ie",
      data_id: "roads",
      access_id: "roads-json",
      spatial: { type: "point", latitude: 91, longitude: -6 },
    });
    const invalidFilters = await callTool("query_data_by_id", {
      source: "data_gov_ie",
      data_id: "roads",
      access_id: "roads-json",
      filters: [{ field: "status", operator: "in", value: [] }],
    });
    const invalidScalarFilter = await callTool("query_data_by_id", {
      source: "data_gov_ie",
      data_id: "roads",
      access_id: "roads-json",
      filters: [{ field: "score", operator: "gte", value: [10] }],
    });
    const invalidBoundingBox = await callTool("query_data_by_id", {
      source: "data_gov_ie",
      data_id: "roads",
      access_id: "roads-json",
      spatial: {
        type: "bbox",
        west: -5,
        south: 54,
        east: -10,
        north: 52,
      },
    });
    const invalidTimeRange = await callTool("query_data_by_id", {
      source: "data_gov_ie",
      data_id: "roads",
      access_id: "roads-json",
      time_range: {
        start: "2026-10-11T00:00:00Z",
        end: "2026-10-10T00:00:00Z",
      },
    });

    expect(errorContent(invalidLimit)).toEqual({
      error: "INVALID_REQUEST",
      message: `The "limit" field must be an integer between 1 and ${commonMaximumLimit}.`,
    });
    expect(errorContent(missingData)).toEqual({
      error: "INVALID_REQUEST",
      message: 'The "data_id" field is required and must be a non-empty string.',
    });
    expect(errorContent(missingAccess)).toEqual({
      error: "INVALID_REQUEST",
      message:
        'The "access_id" field is required and must be a non-empty string.',
    });
    expect(errorContent(invalidCursor)).toEqual({
      error: "INVALID_REQUEST",
      message: 'The "cursor" field is invalid or does not match this request.',
    });
    expect(errorContent(duplicateFields)).toEqual({
      error: "INVALID_REQUEST",
      message:
        'The "fields" field must contain 1 to 10 unique, non-empty strings.',
    });
    expect(errorContent(invalidSpatial)).toEqual({
      error: "INVALID_REQUEST",
      message:
        'The "spatial" field must be a valid WGS84 point or bounding box with west < east and south < north.',
    });
    expect(errorContent(invalidFilters)).toEqual({
      error: "INVALID_REQUEST",
      message:
        'The "filters" field must contain 1 to 20 typed filters; in accepts 1 to 100 scalar values.',
    });
    expect(errorContent(invalidScalarFilter)).toEqual({
      error: "INVALID_REQUEST",
      message:
        'The "filters" field must contain 1 to 20 typed filters; in accepts 1 to 100 scalar values.',
    });
    expect(errorContent(invalidBoundingBox)).toEqual({
      error: "INVALID_REQUEST",
      message:
        'The "spatial" field must be a valid WGS84 point or bounding box with west < east and south < north.',
    });
    expect(errorContent(invalidTimeRange)).toEqual({
      error: "INVALID_REQUEST",
      message:
        'The "time_range" field must contain RFC3339 start and end timestamps, with end after start.',
    });
  });
});
