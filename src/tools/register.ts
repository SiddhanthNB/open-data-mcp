import {
  McpServer,
  type CallToolResult,
  type ResourceLink,
  type StandardSchemaWithJSON,
} from "@modelcontextprotocol/server";
import { z } from "zod";

import { providerConfigs, serverConfig } from "../config";
import {
  decodeQueryCursor,
  decodeSearchCursor,
  encodeQueryCursor,
  encodeSearchCursor,
  MAX_CURSOR_LENGTH,
} from "../cursor";
import { AppError } from "../errors";
import { isBrowserDataUrl, linkName } from "../links";
import type {
  DataLink,
  DataSearchResult,
  QuerySelectors,
  QueryDataResult,
  Source,
} from "../models";
import { enforceSerializedSize } from "../resources/limits";
import type { RateLimitService, ToolRateLimitInput } from "../rate-limit";
import type { SourceRouter } from "../router";

const configuredProviders = Object.values(providerConfigs).filter(
  (config) => config.enabled !== false,
);
const commonMaximumLimit = Math.min(
  ...configuredProviders.map((config) => config.pagination.max_limit),
  100,
);
const configuredDefaults = configuredProviders
  .map((config) => `${config.provider}=${config.pagination.default_limit}`)
  .join(", ");
const limitRange = `integer from 1 to ${commonMaximumLimit}`;
const defaultLimitDescription = configuredDefaults
  ? `Provider defaults: ${configuredDefaults}.`
  : "No providers are currently enabled.";
const rateLimitDescription =
  `Valid tool executions are limited to ${serverConfig.rate_limits.user.requests_per_minute} per rolling minute and ${serverConfig.rate_limits.user.requests_per_24_hours} per rolling 24 hours per user; service-wide limits are ${serverConfig.rate_limits.global.requests_per_minute} per rolling minute and ${serverConfig.rate_limits.global.requests_per_24_hours} per rolling 24 hours. open_meteo_ie additionally has global limits of ${serverConfig.rate_limits.providers.open_meteo_ie.requests_per_minute} per minute, ${serverConfig.rate_limits.providers.open_meteo_ie.requests_per_hour} per hour, and ${serverConfig.rate_limits.providers.open_meteo_ie.requests_per_24_hours} per 24 hours.`;
const maxFields = 10;
const maxFilters = 20;
const maxFilterValues = 100;

function publicRateLimits(): object {
  const limits = serverConfig.rate_limits;
  return {
    algorithm: "sliding_window",
    fallback: "cloudflare_native_per_location",
    per_user: {
      requests_per_minute: limits.user.requests_per_minute,
      requests_per_24_hours: limits.user.requests_per_24_hours,
    },
    global: {
      requests_per_minute: limits.global.requests_per_minute,
      requests_per_24_hours: limits.global.requests_per_24_hours,
    },
    providers: {
      open_meteo_ie: {
        enabled: providerConfigs.open_meteo_ie.enabled !== false,
        scope: "global",
        requests_per_minute:
          limits.providers.open_meteo_ie.requests_per_minute,
        requests_per_hour: limits.providers.open_meteo_ie.requests_per_hour,
        requests_per_24_hours:
          limits.providers.open_meteo_ie.requests_per_24_hours,
      },
    },
  };
}

const source = z
  .string()
  .min(1)
  .describe("One configured source ID returned by list_sources.");
const limit = z
  .number()
  .int()
  .min(1)
  .max(commonMaximumLimit)
  .optional()
  .describe(`Items to return: ${limitRange}. ${defaultLimitDescription}`);
const cursor = z
  .string()
  .min(1)
  .max(MAX_CURSOR_LENGTH)
  .optional()
  .describe("Opaque continuation cursor returned by the same tool.");
const dataId = z
  .string()
  .min(1)
  .describe("Source data ID returned by search_data_by_source.");
const accessId = z
  .string()
  .min(1)
  .describe("Access ID returned by describe_data_by_id for this data ID.");
const fields = z
  .array(z.string().trim().min(1))
  .min(1)
  .max(maxFields)
  .refine((values) => new Set(values).size === values.length)
  .optional()
  .describe(`Optional unique field names to return; maximum ${maxFields}.`);
const filterScalar = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
]);
const filters = z
  .array(
    z.discriminatedUnion("operator", [
      z
        .object({
          field: z.string().trim().min(1),
          operator: z.literal("in"),
          value: z.array(filterScalar).min(1).max(maxFilterValues),
        })
        .strict(),
      z
        .object({
          field: z.string().trim().min(1),
          operator: z.enum(["eq", "lt", "lte", "gt", "gte"]),
          value: filterScalar,
        })
        .strict(),
    ]),
  )
  .min(1)
  .max(maxFilters)
  .optional()
  .describe(
    `Optional typed filters; maximum ${maxFilters}. The in operator accepts 1 to ${maxFilterValues} scalar values.`,
  );
const spatialPoint = z
  .object({
    type: z.literal("point"),
    latitude: z.number().finite().min(-90).max(90),
    longitude: z.number().finite().min(-180).max(180),
  })
  .strict();
const spatialBoundingBox = z
  .object({
    type: z.literal("bbox"),
    west: z.number().finite().min(-180).max(180),
    south: z.number().finite().min(-90).max(90),
    east: z.number().finite().min(-180).max(180),
    north: z.number().finite().min(-90).max(90),
  })
  .strict()
  .refine((value) => value.west < value.east && value.south < value.north);
const spatial = z
  .discriminatedUnion("type", [spatialPoint, spatialBoundingBox])
  .optional()
  .describe("Optional WGS84 point coordinates or bounding box.");
const rfc3339 = z.iso.datetime({ offset: true });
const timeRange = z
  .object({
    start: rfc3339,
    end: rfc3339,
  })
  .strict()
  .refine((value) => Date.parse(value.end) > Date.parse(value.start), {
    path: ["end"],
  })
  .transform((value) => ({
    start: new Date(value.start).toISOString(),
    end: new Date(value.end).toISOString(),
  }))
  .optional()
  .describe("Optional bounded RFC3339 time range; end must be after start.");

const validationMessages: Readonly<Record<string, string>> = {
  source: 'The "source" field must be a non-empty string.',
  query: 'The "query" field must be a string.',
  limit: `The "limit" field must be an integer between 1 and ${commonMaximumLimit}.`,
  cursor: 'The "cursor" field must be a valid non-empty cursor.',
  data_id: 'The "data_id" field is required and must be a non-empty string.',
  access_id:
    'The "access_id" field is required and must be a non-empty string.',
  fields: `The "fields" field must contain 1 to ${maxFields} unique, non-empty strings.`,
  filters: `The "filters" field must contain 1 to ${maxFilters} typed filters; in accepts 1 to ${maxFilterValues} scalar values.`,
  spatial:
    'The "spatial" field must be a valid WGS84 point or bounding box with west < east and south < north.',
  time_range:
    'The "time_range" field must contain RFC3339 start and end timestamps, with end after start.',
};

function validationMessage(error: z.ZodError): string {
  const issue = error.issues[0];
  const field = issue?.path[0];

  if (typeof field === "string" && validationMessages[field]) {
    return validationMessages[field];
  }

  if (issue?.code === "unrecognized_keys") {
    return "The request contains unsupported fields.";
  }

  return "The request is invalid.";
}

function advertisedSchema(schema: z.ZodType): StandardSchemaWithJSON {
  const standard = schema["~standard"];

  return {
    "~standard": {
      ...standard,
      validate: (value: unknown) => ({ value }),
    },
  } as StandardSchemaWithJSON;
}

function toolResult(value: object): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value as Record<string, unknown>,
  };
}

function linkToolResult(value: DataLink): CallToolResult {
  const resourceLink: ResourceLink = {
    type: "resource_link",
    uri: value.url,
    name: linkName(value.url, value.access_id),
    ...(value.title ? { title: value.title } : {}),
    ...(value.description ? { description: value.description } : {}),
    ...(value.size !== undefined ? { size: value.size } : {}),
  };

  return {
    content: [
      { type: "text", text: JSON.stringify(value) },
      resourceLink,
    ],
    structuredContent: value as unknown as Record<string, unknown>,
  };
}

function toolError(error: unknown): CallToolResult {
  const appError =
    error instanceof AppError ? error : new AppError("UPSTREAM_ERROR");
  const value = appError.toJSON();

  return {
    ...toolResult(value),
    isError: true,
  };
}

async function execute(operation: () => Promise<object>): Promise<CallToolResult> {
  try {
    const value = await operation();
    enforceSerializedSize(value, serverConfig.resources.max_output_bytes);
    return toolResult(value);
  } catch (error) {
    return toolError(error);
  }
}

async function executeLink(
  operation: () => Promise<DataLink>,
): Promise<CallToolResult> {
  try {
    const value = await operation();
    if (!isBrowserDataUrl(value.url)) {
      throw new AppError(
        "UNSUPPORTED_OPERATION",
        "The requested access point does not provide a safe browser-openable link.",
      );
    }
    enforceSerializedSize(value, serverConfig.resources.max_output_bytes);
    return linkToolResult(value);
  } catch (error) {
    return toolError(error);
  }
}

async function executeValidated<T>(
  schema: z.ZodType<T>,
  input: unknown,
  operation: (input: T) => Promise<object>,
  rateLimiter: RateLimitService,
): Promise<CallToolResult> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    return toolError(
      new AppError("INVALID_REQUEST", validationMessage(parsed.error)),
    );
  }

  return execute(async () => {
    await rateLimiter.limitTool(rateLimitInput(parsed.data));
    return operation(parsed.data);
  });
}

async function executeValidatedLink<T>(
  schema: z.ZodType<T>,
  input: unknown,
  operation: (input: T) => Promise<DataLink>,
  rateLimiter: RateLimitService,
): Promise<CallToolResult> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    return toolError(
      new AppError("INVALID_REQUEST", validationMessage(parsed.error)),
    );
  }

  return executeLink(async () => {
    await rateLimiter.limitTool(rateLimitInput(parsed.data));
    return operation(parsed.data);
  });
}

function rateLimitInput(value: unknown): ToolRateLimitInput {
  if (
    typeof value === "object" &&
    value !== null &&
    "source" in value &&
    typeof value.source === "string"
  ) {
    return { source: value.source };
  }
  return {};
}

export function registerTools(
  server: McpServer,
  router: SourceRouter,
  rateLimiter: RateLimitService,
): void {
  const listSourcesInput = z.object({}).strict();
  const searchDataInput = z
    .object({
      source,
      query: z.string().optional().describe("Optional upstream keyword query."),
      limit,
      cursor,
    })
    .strict();
  const describeDataInput = z
    .object({
      source,
      data_id: dataId,
    })
    .strict();
  const queryDataInput = z
    .object({
      source,
      data_id: dataId,
      access_id: accessId,
      fields,
      filters,
      spatial,
      time_range: timeRange,
      limit,
      cursor,
    })
    .strict();
  const getDataLinkInput = z
    .object({
      source,
      data_id: dataId,
      access_id: accessId,
    })
    .strict();

  server.registerTool(
    "list_sources",
    {
      description:
        `List configured public-data and Ireland-scoped sources with their type, authority status, geographic coverage, enabled capabilities, formats, pagination limits, and structured request-rate limits. ${rateLimitDescription}`,
      inputSchema: advertisedSchema(listSourcesInput),
    },
    async (input) =>
      executeValidated(
        listSourcesInput,
        input,
        async () => ({
          sources: router.listSources(),
          rate_limits: publicRateLimits(),
        }),
        rateLimiter,
      ),
  );

  server.registerTool(
    "search_data_by_source",
    {
      description:
        `Search one source and return source-neutral data_id values. Results may overlap between catalogues because source selects the upstream representation. Use next_cursor to continue without handling provider offsets. Maximum limit: ${commonMaximumLimit}. ${defaultLimitDescription} ${rateLimitDescription}`,
      inputSchema: advertisedSchema(searchDataInput),
    },
    async (input) =>
      executeValidated(
        searchDataInput,
        input,
        async ({ source: requestedSource, query, limit, cursor }) => {
          const adapter = router.resolve(
            requestedSource,
            "search_data_by_source",
          );
          const source = adapter.config.provider;
          const continuation = decodeSearchCursor(cursor, source, query);
          const result = await adapter.searchData({
            query: continuation.query,
            limit,
            offset: continuation.offset,
          });
          return searchResponse(source, continuation.query, result);
        },
        rateLimiter,
      ),
  );

  server.registerTool(
    "describe_data_by_id",
    {
      description:
        `Describe one logical data object. Use a data_id from search_data_by_source. Access points expose independent query and link capabilities; unsupported query formats remain discoverable. ${rateLimitDescription}`,
      inputSchema: advertisedSchema(describeDataInput),
    },
    async (input) =>
      executeValidated(
        describeDataInput,
        input,
        async ({ source, data_id }) => {
          const adapter = router.resolve(source, "describe_data_by_id");
          return adapter.describeData({ data_id });
        },
        rateLimiter,
      ),
  );

  server.registerTool(
    "query_data_by_id",
    {
      description:
        `Return bounded structured data from one access point. Pass source, data_id, and access_id from describe_data_by_id. Sources may support optional field selection, typed filters, point or bounding-box coordinates, and a bounded time range. Use the access point query_schema to determine supported selectors. This tool never executes APIs described by OpenAPI documents. Use next_cursor to continue pageable data. Maximum limit: ${commonMaximumLimit}. ${defaultLimitDescription} ${rateLimitDescription}`,
      inputSchema: advertisedSchema(queryDataInput),
    },
    async (input) =>
      executeValidated(
        queryDataInput,
        input,
        async ({
          source: requestedSource,
          data_id,
          access_id,
          fields,
          filters,
          spatial,
          time_range,
          limit,
          cursor,
        }) => {
          const adapter = router.resolve(requestedSource, "query_data_by_id");
          const source = adapter.config.provider;
          const continuation = decodeQueryCursor(
            cursor,
            source,
            data_id,
            access_id,
            { fields, filters, spatial, time_range },
          );
          const result = await adapter.queryData({
            data_id,
            access_id,
            ...continuation.selectors,
            limit,
            offset: continuation.offset,
          });
          return queryResponse(
            source,
            data_id,
            access_id,
            result,
            continuation.selectors,
          );
        },
        rateLimiter,
      ),
  );

  server.registerTool(
    "get_data_link_by_id",
    {
      description:
        `Return metadata plus a clickable MCP resource_link for a catalogued access point. The tool does not fetch, stream, parse, or preview the linked bytes and accepts no arbitrary URL. ${rateLimitDescription}`,
      inputSchema: advertisedSchema(getDataLinkInput),
    },
    async (input) =>
      executeValidatedLink(
        getDataLinkInput,
        input,
        async ({ source, data_id, access_id }) => {
          const adapter = router.resolve(source, "get_data_link_by_id");
          return adapter.getDataLink({
            data_id,
            access_id,
          });
        },
        rateLimiter,
      ),
  );
}

function searchResponse(
  source: Source,
  query: string,
  result: DataSearchResult,
): object {
  const { pagination } = result;
  const hasMore =
    pagination.returned > 0 &&
    (pagination.total !== undefined
      ? pagination.offset + pagination.returned < pagination.total
      : pagination.returned === pagination.limit);
  const nextOffset = pagination.offset + pagination.returned;

  return {
    source,
    results: result.results,
    returned: pagination.returned,
    ...(pagination.total !== undefined ? { total: pagination.total } : {}),
    truncated: hasMore,
    ...(hasMore
      ? { next_cursor: encodeSearchCursor(source, query, nextOffset) }
      : {}),
  };
}

function queryResponse(
  source: Source,
  dataId: string,
  accessId: string,
  result: QueryDataResult,
  selectors: QuerySelectors,
): object {
  const page = result.pagination;
  const hasMore =
    result.pagination_supported &&
    page !== undefined &&
    page.returned > 0 &&
    (page.total !== undefined
      ? page.offset + page.returned < page.total
      : page.returned === page.limit);
  const nextOffset = page ? page.offset + page.returned : 0;
  const truncated = result.truncated === true || hasMore;

  return {
    source,
    data_id: dataId,
    access_id: accessId,
    data: result.data,
    provenance: result.provenance,
    pagination_supported: result.pagination_supported,
    ...(page ? { returned: page.returned } : {}),
    ...(page?.total !== undefined ? { total: page.total } : {}),
    truncated,
    ...(hasMore
      ? {
          next_cursor: encodeQueryCursor(
            source,
            dataId,
            accessId,
            nextOffset,
            selectors,
          ),
        }
      : {}),
  };
}
