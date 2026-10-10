import { AppError } from "../../errors";
import type {
  AccessPoint,
  QueryDataResult,
  QueryFilter,
} from "../../models";
import type {
  DescribeDataInput,
  GetDataLinkInput,
  QueryDataInput,
  SearchDataInput,
} from "../provider";
import { enforceSerializedSize } from "../../resources/limits";
import {
  CSO_DATASET_METHOD,
  CSO_JSON_RPC_ENDPOINT,
  CSO_REST_BASE,
  CSO_SEARCH_METHOD,
  CsoPxStatClient,
  type CsoSearchRecord,
} from "./client";
import {
  buildSelection,
  datasetQueryParams,
  normalizeDataset,
  parseMetadata,
  querySchema,
  type CsoAttribution,
  type CsoMetadata,
  type CsoNormalizedRow,
  type CsoSelection,
} from "./json-stat";

export const CSO_SOURCE = "cso_pxstat" as const;
export const CSO_QUERY_ACCESS_ID = "json_stat_2";

const ABSOLUTE_SEARCH_MAX = 100;
const ABSOLUTE_CELL_MAX = 100;
const CSO_LICENCE = "Creative Commons Attribution 4.0 International (CC BY 4.0)";

const ACCESS_FORMATS = [
  {
    id: "json_stat_2",
    title: "JSON-stat 2.0",
    format: "json-stat2",
    type: "JSON-stat",
    version: "2.0",
    query: true,
  },
  {
    id: "json_stat_1",
    title: "JSON-stat 1.0",
    format: "json-stat1",
    type: "JSON-stat",
    version: "1.0",
    query: false,
  },
  {
    id: "csv_1",
    title: "CSV 1.0",
    format: "csv",
    type: "CSV",
    version: "1.0",
    query: false,
  },
  {
    id: "px_2013",
    title: "PC-Axis 2013",
    format: "px",
    type: "PX",
    version: "2013",
    query: false,
  },
  {
    id: "xlsx_2007",
    title: "Excel 2007",
    format: "xlsx",
    type: "XLSX",
    version: "2007",
    query: false,
  },
] as const;

type CsoAccessId = (typeof ACCESS_FORMATS)[number]["id"];

export interface CsoPxStatAdapterConfig {
  provider: typeof CSO_SOURCE;
  type: "statistical_cube";
  base_url: string;
  endpoints: {
    json_rpc: string;
    restful: string;
  };
  methods: {
    search: string;
    read_dataset: string;
  };
  language: "en";
  http_timeout_ms: number;
  pagination: {
    default_limit: number;
    max_limit: number;
  };
  search_result_limit: number;
  max_dimension_values: number;
  max_cells: number;
}

export interface CsoPxStatAdapterDependencies {
  maxInputBytes: number;
  maxOutputBytes: number;
  fetch?: typeof fetch;
  now?: () => Date;
}

interface CsoProvenance {
  source: typeof CSO_SOURCE;
  upstream_url: string;
  retrieved_at: string;
  original_format?: string;
}

export interface CsoDataSummary {
  data_id: string;
  title: string;
  description?: string;
  publisher?: string;
  available_formats?: readonly string[];
  provenance: CsoProvenance;
}

export interface CsoDataDescription extends CsoDataSummary {
  licence?: string;
  access_points: readonly AccessPoint[];
  attribution: CsoAttribution;
}

export interface CsoSearchResult {
  results: readonly CsoDataSummary[];
  pagination: {
    limit: number;
    offset: number;
    returned: number;
    total?: number;
  };
}

export interface CsoQueryDataResult
  extends Omit<QueryDataResult, "provenance"> {
  provenance: CsoProvenance & { original_format: string };
}

export interface CsoDataLink {
  data_id: string;
  access_id: string;
  url: string;
  format: string;
  title: string;
  description: string;
  provenance: CsoProvenance & { original_format: string };
}

export class CsoPxStatAdapter {
  readonly config: CsoPxStatAdapterConfig;

  private readonly client: CsoPxStatClient;
  private readonly maxOutputBytes: number;
  private readonly now: () => Date;

  constructor(
    config: CsoPxStatAdapterConfig,
    dependencies: CsoPxStatAdapterDependencies,
  ) {
    validateConfig(config);
    requirePositiveInteger(dependencies.maxInputBytes, "maxInputBytes");
    requirePositiveInteger(dependencies.maxOutputBytes, "maxOutputBytes");
    this.config = config;
    this.client = new CsoPxStatClient(
      {
        jsonRpcEndpoint: config.endpoints.json_rpc,
        restfulBaseUrl: config.endpoints.restful,
        searchMethod: config.methods.search,
        datasetMethod: config.methods.read_dataset,
        language: config.language,
        timeoutMs: config.http_timeout_ms,
        maxInputBytes: dependencies.maxInputBytes,
      },
      dependencies.fetch ?? fetch,
    );
    this.maxOutputBytes = dependencies.maxOutputBytes;
    this.now = dependencies.now ?? (() => new Date());
  }

  async searchData(input: SearchDataInput): Promise<CsoSearchResult> {
    const query = requireSearchQuery(input.query);
    const { limit, offset } = this.pagination(input.limit, input.offset);
    const upstream = await this.client.search(query);
    const bounded = upstream.slice(0, this.config.search_result_limit);
    const results = bounded
      .slice(offset, offset + limit)
      .map((record) => this.mapSearchRecord(record));
    return this.bounded({
      results,
      pagination: {
        limit,
        offset,
        returned: results.length,
        ...(upstream.length < this.config.search_result_limit
          ? { total: upstream.length }
          : {}),
      },
    });
  }

  async describeData(input: DescribeDataInput): Promise<CsoDataDescription> {
    const metadata = await this.readMetadata(input.data_id);
    const result: CsoDataDescription = {
      ...this.metadataSummary(metadata),
      ...(metadata.copyright.code === "CSO" ? { licence: CSO_LICENCE } : {}),
      access_points: ACCESS_FORMATS.map((format) => ({
        access_id: format.id,
        title: format.title,
        description: `Published by ${metadata.copyright.name}.`,
        format: format.format,
        capabilities: { query: format.query, link: true },
        ...(format.query
          ? {
              query_schema: querySchema(
                metadata,
                this.config.max_dimension_values,
              ),
            }
          : {}),
        ...(metadata.updated ? { last_modified: metadata.updated } : {}),
        upstream_url: this.client.datasetUrl(
          metadata.matrix,
          format.type,
          format.version,
        ),
      })),
      attribution: metadata.copyright,
    };
    return this.bounded(result);
  }

  async queryData(input: QueryDataInput): Promise<CsoQueryDataResult> {
    if (input.access_id !== CSO_QUERY_ACCESS_ID) {
      if (isAccessId(input.access_id)) {
        throw new AppError(
          "UNSUPPORTED_OPERATION",
          "CSO PxStat queries are supported only through json_stat_2.",
        );
      }
      throw new AppError("RESOURCE_NOT_FOUND");
    }
    rejectUnsupportedSelectors(input);
    const { limit, offset } = this.pagination(input.limit, input.offset);
    const metadata = await this.readMetadata(input.data_id);
    const selection = buildSelection(
      metadata,
      input.filters,
      this.config.max_cells,
    );
    const params = datasetQueryParams(metadata, selection, this.config.language);
    const response = await this.client.readDataset(metadata.matrix, params);
    const allRows = normalizeDataset(response);
    if (
      allRows.length !== selection.cellCount ||
      allRows.length > this.config.max_cells ||
      !matchesSelection(allRows, metadata, selection)
    ) {
      throw new AppError("UPSTREAM_ERROR");
    }
    const rows = allRows.slice(offset, offset + limit);
    return this.bounded({
      data_id: metadata.matrix,
      access_id: CSO_QUERY_ACCESS_ID,
      data: {
        rows,
        attribution: metadata.copyright,
      },
      provenance: {
        source: CSO_SOURCE,
        upstream_url: this.config.endpoints.json_rpc,
        retrieved_at: this.now().toISOString(),
        original_format: "json-stat2",
      },
      pagination_supported: true,
      pagination: {
        limit,
        offset,
        returned: rows.length,
        total: allRows.length,
      },
    });
  }

  async getDataLink(input: GetDataLinkInput): Promise<CsoDataLink> {
    const format = ACCESS_FORMATS.find(
      (candidate) => candidate.id === input.access_id,
    );
    if (!format) {
      throw new AppError("RESOURCE_NOT_FOUND");
    }
    const metadata = await this.readMetadata(input.data_id);
    const url = this.client.datasetUrl(
      metadata.matrix,
      format.type,
      format.version,
    );
    return this.bounded({
      data_id: metadata.matrix,
      access_id: format.id,
      url,
      format: format.format,
      title: `${metadata.title} — ${format.title}`,
      description: `Published by ${metadata.copyright.name}.`,
      provenance: {
        source: CSO_SOURCE,
        upstream_url: url,
        retrieved_at: this.now().toISOString(),
        original_format: format.format,
      },
    });
  }

  private async readMetadata(dataId: string): Promise<CsoMetadata> {
    const metadata = parseMetadata(await this.client.metadata(dataId));
    if (metadata.matrix !== dataId) {
      throw new AppError("UPSTREAM_ERROR");
    }
    return metadata;
  }

  private mapSearchRecord(record: CsoSearchRecord): CsoDataSummary {
    const description = [record.SbjValue, record.PrcValue]
      .filter((value): value is string => value !== undefined)
      .join(" — ");
    return {
      data_id: record.MtrCode,
      title: record.MtrTitle,
      ...(description ? { description } : {}),
      ...(record.CprValue ? { publisher: record.CprValue } : {}),
      available_formats: ACCESS_FORMATS.map((format) => format.format),
      provenance: {
        source: CSO_SOURCE,
        upstream_url: this.client.metadataUrl(record.MtrCode),
        retrieved_at: this.now().toISOString(),
      },
    };
  }

  private metadataSummary(metadata: CsoMetadata): CsoDataSummary {
    const description = [metadata.subject, metadata.product]
      .filter((value): value is string => value !== undefined)
      .join(" — ");
    return {
      data_id: metadata.matrix,
      title: metadata.title,
      ...(description ? { description } : {}),
      publisher: metadata.copyright.name,
      available_formats: ACCESS_FORMATS.map((format) => format.format),
      provenance: {
        source: CSO_SOURCE,
        upstream_url: this.client.metadataUrl(metadata.matrix),
        retrieved_at: this.now().toISOString(),
      },
    };
  }

  private pagination(
    requestedLimit: number | undefined,
    requestedOffset: number | undefined,
  ): { limit: number; offset: number } {
    const limit = requestedLimit ?? this.config.pagination.default_limit;
    const offset = requestedOffset ?? 0;
    if (
      !Number.isInteger(limit) ||
      limit <= 0 ||
      limit > this.config.pagination.max_limit ||
      !Number.isInteger(offset) ||
      offset < 0
    ) {
      throw new AppError(
        "INVALID_REQUEST",
        `limit must be between 1 and ${this.config.pagination.max_limit}; offset must be a non-negative integer.`,
      );
    }
    return { limit, offset };
  }

  private bounded<T>(value: T): T {
    enforceSerializedSize(value, this.maxOutputBytes);
    return value;
  }
}

function rejectUnsupportedSelectors(input: QueryDataInput): void {
  if (
    (input.fields && input.fields.length > 0) ||
    input.spatial !== undefined ||
    input.time_range !== undefined
  ) {
    throw new AppError(
      "INVALID_REQUEST",
      "CSO PxStat supports dimension filters only.",
    );
  }
}

function matchesSelection(
  rows: readonly CsoNormalizedRow[],
  metadata: CsoMetadata,
  selection: CsoSelection,
): boolean {
  const expectedFields = metadata.dimensions.map((dimension) => dimension.code);
  const allowed = new Map(
    Object.entries(selection.dimension).map(([field, value]) => [
      field,
      new Set(value.category.index),
    ]),
  );
  return rows.every(
    (row) =>
      row.dimensions.length === expectedFields.length &&
      row.dimensions.every(
        (dimension, index) =>
          dimension.field === expectedFields[index] &&
          allowed.get(dimension.field)?.has(dimension.value) === true,
      ),
  );
}

function isAccessId(value: string): value is CsoAccessId {
  return ACCESS_FORMATS.some((candidate) => candidate.id === value);
}

function requireSearchQuery(value: string | undefined): string {
  if (value === undefined || value.trim() === "") {
    throw new AppError(
      "INVALID_REQUEST",
      "query is required for CSO PxStat search.",
    );
  }
  return value.trim();
}

function validateConfig(config: CsoPxStatAdapterConfig): void {
  if (
    config.provider !== CSO_SOURCE ||
    config.type !== "statistical_cube" ||
    config.base_url !== CSO_REST_BASE ||
    config.endpoints.json_rpc !== CSO_JSON_RPC_ENDPOINT ||
    config.endpoints.restful !== CSO_REST_BASE ||
    config.methods.search !== CSO_SEARCH_METHOD ||
    config.methods.read_dataset !== CSO_DATASET_METHOD ||
    config.language !== "en"
  ) {
    throw new RangeError("CSO PxStat configuration must use the official allowlisted API");
  }
  requirePositiveInteger(config.http_timeout_ms, "http_timeout_ms");
  requirePositiveInteger(config.pagination.default_limit, "default_limit");
  requirePositiveInteger(config.pagination.max_limit, "max_limit");
  if (config.pagination.default_limit > config.pagination.max_limit) {
    throw new RangeError("default_limit must not exceed max_limit");
  }
  requirePositiveInteger(config.search_result_limit, "search_result_limit");
  if (config.search_result_limit > ABSOLUTE_SEARCH_MAX) {
    throw new RangeError(`search_result_limit must not exceed ${ABSOLUTE_SEARCH_MAX}`);
  }
  requirePositiveInteger(config.max_dimension_values, "max_dimension_values");
  requirePositiveInteger(config.max_cells, "max_cells");
  if (config.max_cells > ABSOLUTE_CELL_MAX) {
    throw new RangeError(`max_cells must not exceed ${ABSOLUTE_CELL_MAX}`);
  }
}

function requirePositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
}

export type { QueryFilter };
