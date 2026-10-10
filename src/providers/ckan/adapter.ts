import { AppError } from "../../errors";
import { isBrowserDataUrl } from "../../links";
import type {
  AccessPoint,
  DataLink,
  DataDescription,
  DataSearchResult,
  DataSummary,
  Pagination,
  ProviderConfig,
  QueryDataResult,
  ResourceFormat,
} from "../../models";
import type {
  DescribeDataInput,
  GetDataLinkInput,
  ProviderAdapter,
  QueryDataInput,
  SearchDataInput,
} from "../provider";
import { enforceSerializedSize } from "../../resources/limits";
import { CkanClient, isRecord, type CkanRecord } from "./client";
import { plainText } from "./text";

export interface ResourceLoadRequest {
  url: string;
  format: ResourceFormat;
  limit: number;
  offset: number;
  timeout_ms: number;
}

export interface ResourceLoadResult {
  data: unknown;
  pagination_supported?: boolean;
  pagination?: Pagination;
}

export interface ResourceLoader {
  load(input: ResourceLoadRequest): Promise<ResourceLoadResult>;
}

export interface CkanAdapterDependencies {
  resourceLoader: ResourceLoader;
  maxInputBytes: number;
  maxOutputBytes: number;
  fetch?: typeof fetch;
  now?: () => Date;
}

export class CkanAdapter implements ProviderAdapter {
  readonly config: ProviderConfig;

  private readonly client: CkanClient;
  private readonly resourceLoader: ResourceLoader;
  private readonly maxOutputBytes: number;
  private readonly now: () => Date;

  constructor(config: ProviderConfig, dependencies: CkanAdapterDependencies) {
    this.config = config;
    requirePositiveInteger(dependencies.maxInputBytes, "maxInputBytes");
    requirePositiveInteger(dependencies.maxOutputBytes, "maxOutputBytes");
    this.client = new CkanClient(
      config,
      dependencies.fetch ?? fetch,
      dependencies.maxInputBytes,
    );
    this.resourceLoader = dependencies.resourceLoader;
    this.maxOutputBytes = dependencies.maxOutputBytes;
    this.now = dependencies.now ?? (() => new Date());
  }

  async searchData(input: SearchDataInput): Promise<DataSearchResult> {
    const { limit, offset } = this.pagination(input.limit, input.offset);
    const parameters = new URLSearchParams({
      rows: String(limit),
      start: String(offset),
    });
    if (input.query !== undefined && input.query !== "") {
      parameters.set("q", input.query);
    }
    if (this.config.scope) {
      parameters.set(
        "fq",
        `organization:${this.config.scope.organization_name}`,
      );
    }

    const result = await this.client.packageSearch(parameters);
    const count = numberField(result, "count");
    const packages = arrayField(result, "results").map(recordValue);
    const results = packages
      .filter((dataset) => this.isInScope(dataset))
      .map((dataset) => this.mapDataSummary(dataset));

    return {
      results,
      pagination: {
        limit,
        offset,
        returned: results.length,
        total: count,
      },
    };
  }

  async describeData(input: DescribeDataInput): Promise<DataDescription> {
    const dataset = await this.client.packageShow(input.data_id);
    this.enforceScope(dataset);
    return this.mapDataDescription(dataset);
  }

  async queryData(input: QueryDataInput): Promise<QueryDataResult> {
    if (!input.data_id) {
      throw new AppError("INVALID_REQUEST");
    }
    if (
      input.fields !== undefined ||
      input.filters !== undefined ||
      input.spatial !== undefined ||
      input.time_range !== undefined
    ) {
      throw new AppError(
        "INVALID_REQUEST",
        "CKAN resources do not support fields, filters, spatial, or time_range selectors.",
      );
    }

    const dataset = await this.client.packageShow(input.data_id);
    this.enforceScope(dataset);
    const resources = arrayField(dataset, "resources");
    const resource = resources
      .map(recordValue)
      .find((candidate) => stringField(candidate, "id") === input.access_id);
    if (!resource) {
      throw new AppError("RESOURCE_NOT_FOUND");
    }

    const originalFormat = advertisedResourceFormat(resource.format);
    const format = resourceFormat(resource.format);
    const datastoreActive = resource.datastore_active === true;
    if (
      !originalFormat ||
      (!datastoreActive &&
        (!format || !this.config.formats.includes(format)))
    ) {
      throw new AppError("UNSUPPORTED_FORMAT");
    }

    const { limit, offset } = this.pagination(input.limit, input.offset);
    const datasetId = stringField(dataset, "id");
    const resourceId = stringField(resource, "id");
    const resourceUrl = stringField(resource, "url");

    if (datastoreActive) {
      const parameters = new URLSearchParams({
        resource_id: resourceId,
        limit: String(limit),
        offset: String(offset),
      });
      const result = await this.client.datastoreSearch(parameters);
      const records = arrayField(result, "records");
      const total = numberField(result, "total");

      return this.boundedQueryResult({
        data_id: datasetId,
        access_id: resourceId,
        data: records,
        provenance: {
          source: this.config.provider,
          upstream_url: this.client.endpointUrl(
            "datastore_search",
            parameters,
          ),
          retrieved_at: this.now().toISOString(),
          original_format: originalFormat,
        },
        pagination_supported: true,
        pagination: {
          limit,
          offset,
          returned: records.length,
          total,
        },
      });
    }

    if (!format) {
      throw new AppError("UNSUPPORTED_FORMAT");
    }

    let loaded: ResourceLoadResult;
    try {
      loaded = await this.resourceLoader.load({
        url: resourceUrl,
        format,
        limit,
        offset,
        timeout_ms: this.config.http_timeout_ms,
      });
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError("UPSTREAM_ERROR");
    }

    return this.boundedQueryResult({
      data_id: datasetId,
      access_id: resourceId,
      data: loaded.data,
      provenance: {
        source: this.config.provider,
        upstream_url: resourceUrl,
        retrieved_at: this.now().toISOString(),
        original_format: originalFormat,
      },
      pagination_supported:
        loaded.pagination_supported ?? loaded.pagination !== undefined,
      ...(loaded.pagination ? { pagination: loaded.pagination } : {}),
    });
  }

  async getDataLink(input: GetDataLinkInput): Promise<DataLink> {
    const dataset = await this.client.packageShow(input.data_id);
    this.enforceScope(dataset);
    const resource = arrayField(dataset, "resources")
      .map(recordValue)
      .find((candidate) => stringField(candidate, "id") === input.access_id);
    if (!resource) {
      throw new AppError("RESOURCE_NOT_FOUND");
    }

    const summary = this.mapAccessPoint(resource);
    if (!isBrowserDataUrl(summary.upstream_url)) {
      throw new AppError(
        "UNSUPPORTED_OPERATION",
        "The requested access point does not provide a browser-openable link.",
      );
    }

    return {
      data_id: stringField(dataset, "id"),
      access_id: summary.access_id,
      url: summary.upstream_url,
      format: summary.format,
      ...(summary.title ? { title: summary.title } : {}),
      ...(summary.description ? { description: summary.description } : {}),
      ...(summary.size !== undefined ? { size: summary.size } : {}),
      ...(summary.last_modified
        ? { last_modified: summary.last_modified }
        : {}),
      provenance: {
        source: this.config.provider,
        upstream_url: summary.upstream_url,
        retrieved_at: this.now().toISOString(),
        original_format: summary.format,
      },
    };
  }

  private boundedQueryResult(result: QueryDataResult): QueryDataResult {
    enforceSerializedSize(result, this.maxOutputBytes);
    return result;
  }

  private mapDataSummary(dataset: CkanRecord): DataSummary {
    const resources = arrayField(dataset, "resources").map(recordValue);
    const formats = uniqueFormats(resources);
    const organization = optionalRecord(dataset.organization);
    const description = normalizedDescription(dataset.notes);

    return {
      data_id: stringField(dataset, "id"),
      title: optionalString(dataset.title) ?? stringField(dataset, "name"),
      ...(description ? { description } : {}),
      ...(organization && optionalString(organization.title)
        ? { publisher: optionalString(organization.title) }
        : {}),
      ...(formats.length > 0 ? { available_formats: formats } : {}),
      provenance: {
        source: this.config.provider,
        upstream_url: this.datasetUrl(dataset),
        retrieved_at: this.now().toISOString(),
      },
    };
  }

  private mapDataDescription(dataset: CkanRecord): DataDescription {
    const summary = this.mapDataSummary(dataset);
    const accessPoints = arrayField(dataset, "resources")
      .map(recordValue)
      .map((resource) => this.mapAccessPoint(resource));
    const tags = uniqueTags(optionalArray(dataset.tags));

    return {
      ...summary,
      ...(optionalString(dataset.license_title)
        ? { licence: optionalString(dataset.license_title) }
        : {}),
      ...(tags && tags.length > 0 ? { tags } : {}),
      access_points: accessPoints,
    };
  }

  private mapAccessPoint(resource: CkanRecord): AccessPoint {
    const format = advertisedResourceFormat(resource.format);
    const retrievableFormat = resourceFormat(resource.format);
    const datastoreActive = validOptionalBoolean(resource.datastore_active);
    const size = validOptionalNonnegativeNumber(resource.size);
    const lastModified = validOptionalString(resource.last_modified);
    const description = normalizedDescription(resource.description);
    return {
      access_id: stringField(resource, "id"),
      ...(optionalString(resource.name)
        ? { title: optionalString(resource.name) }
        : {}),
      ...(description ? { description } : {}),
      format: format ?? "unknown",
      capabilities: {
        query:
          format !== undefined &&
          (datastoreActive === true ||
            (retrievableFormat !== undefined &&
              this.config.formats.includes(retrievableFormat))),
        link: isBrowserDataUrl(stringField(resource, "url")),
      },
      ...(size !== undefined ? { size } : {}),
      ...(lastModified !== undefined ? { last_modified: lastModified } : {}),
      upstream_url: stringField(resource, "url"),
    };
  }

  private datasetUrl(dataset: CkanRecord): string {
    const id = stringField(dataset, "id");
    return this.client.endpointUrl(
      "package_show",
      new URLSearchParams({ id }),
    );
  }

  private enforceScope(dataset: CkanRecord): void {
    if (!this.isInScope(dataset)) {
      throw new AppError("DATASET_NOT_FOUND");
    }
  }

  private isInScope(dataset: CkanRecord): boolean {
    const requiredOwner = this.config.scope?.organization_id;
    return (
      requiredOwner === undefined ||
      optionalString(dataset.owner_org) === requiredOwner
    );
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
      throw new AppError("INVALID_REQUEST");
    }
    return { limit, offset };
  }
}

function requirePositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
}

function uniqueFormats(resources: readonly CkanRecord[]): string[] {
  return [
    ...new Set(
      resources
        .map((resource) => advertisedResourceFormat(resource.format))
        .filter((format): format is string => format !== undefined),
    ),
  ];
}

function resourceFormat(value: unknown): ResourceFormat | undefined {
  const normalized = advertisedResourceFormat(value);
  if (!normalized) {
    return undefined;
  }
  if (normalized === "csv" || normalized === "text/csv") {
    return "csv";
  }
  if (
    normalized === "json" ||
    normalized === "geojson" ||
    normalized === "application/json" ||
    hasStructuredSyntaxSuffix(normalized, "json")
  ) {
    return "json";
  }
  if (
    normalized === "xml" ||
    normalized === "application/xml" ||
    normalized === "text/xml" ||
    hasStructuredSyntaxSuffix(normalized, "xml")
  ) {
    return "xml";
  }
  return undefined;
}

function advertisedResourceFormat(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "") {
    return undefined;
  }
  const parameterSeparator = normalized.indexOf(";");
  const mediaType = normalized.slice(
    0,
    parameterSeparator === -1 ? undefined : parameterSeparator,
  ).trim();
  const advertised =
    parameterSeparator !== -1 && MEDIA_TYPE_PATTERN.test(mediaType)
      ? mediaType
      : normalized;
  if (advertised === "text/csv") {
    return "csv";
  }
  if (advertised === "application/json") {
    return "json";
  }
  if (advertised === "application/xml" || advertised === "text/xml") {
    return "xml";
  }
  return advertised;
}

function hasStructuredSyntaxSuffix(
  value: string,
  suffix: "json" | "xml",
): boolean {
  if (!MEDIA_TYPE_PATTERN.test(value)) {
    return false;
  }
  const subtype = value.slice(value.indexOf("/") + 1);
  const suffixMarker = `+${suffix}`;
  return subtype.length > suffixMarker.length && subtype.endsWith(suffixMarker);
}

const MEDIA_TYPE_PATTERN =
  /^[!#$%&'*+.^_`|~0-9a-z-]+\/[!#$%&'*+.^_`|~0-9a-z-]+$/;

function uniqueTags(values: unknown[] | undefined): string[] | undefined {
  if (!values) {
    return undefined;
  }
  const tags = values
    .map((tag) => optionalString(recordValue(tag).name)?.trim())
    .filter((tag): tag is string => tag !== undefined && tag !== "");
  return [...new Set(tags)];
}

function recordValue(value: unknown): CkanRecord {
  if (!isRecord(value)) {
    throw new AppError("UPSTREAM_ERROR");
  }
  return value;
}

function arrayField(record: CkanRecord, field: string): unknown[] {
  const value = record[field];
  if (!Array.isArray(value)) {
    throw new AppError("UPSTREAM_ERROR");
  }
  return value;
}

function optionalArray(value: unknown): unknown[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new AppError("UPSTREAM_ERROR");
  }
  return value;
}

function stringField(record: CkanRecord, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new AppError("UPSTREAM_ERROR");
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new AppError("UPSTREAM_ERROR");
  }
  return value;
}

function normalizedDescription(value: unknown): string | undefined {
  const description = optionalString(value);
  if (!description) {
    return undefined;
  }
  const normalized = plainText(description);
  return normalized === "" ? undefined : normalized;
}

function validOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function validOptionalNonnegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function validOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function numberField(record: CkanRecord, field: string): number {
  const value = record[field];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new AppError("UPSTREAM_ERROR");
  }
  return value;
}

function optionalRecord(value: unknown): CkanRecord | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return recordValue(value);
}
