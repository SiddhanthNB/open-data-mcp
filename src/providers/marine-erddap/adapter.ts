import { AppError } from "../../errors";
import { isBrowserDataUrl } from "../../links";
import type {
  AccessPoint,
  DataDescription,
  DataLink,
  DataSearchResult,
  DataSummary,
  QueryDataResult,
  QueryFieldDescription,
  QueryFilter,
  QueryFilterScalar,
  QuerySchema,
  Source,
} from "../../models";
import { enforceSerializedSize } from "../../resources/limits";
import type {
  DescribeDataInput,
  GetDataLinkInput,
  QueryDataInput,
  SearchDataInput,
} from "../provider";

export const MARINE_ERDDAP_SOURCE_ID = "marine_institute";
export const MARINE_ERDDAP_BASE_URL =
  "https://erddap.marine.ie/erddap" as const;

// Removed when the shared Source union gains the Marine Institute source.
const MARINE_SOURCE = MARINE_ERDDAP_SOURCE_ID as Source;

const ACCESS_IDS = ["tabledap", "griddap", "files"] as const;
type AccessId = (typeof ACCESS_IDS)[number];

const FILTER_OPERATOR = {
  eq: "=",
  lt: "<",
  lte: "<=",
  gt: ">",
  gte: ">=",
} as const;

type JsonRecord = Record<string, unknown>;

export interface MarineErddapSettings {
  baseUrl: typeof MARINE_ERDDAP_BASE_URL;
  timeoutMs: number;
  maxInputBytes: number;
  maxOutputBytes: number;
  defaultLimit: number;
  maxLimit: number;
  maxSchemaFields: number;
  maxSelectedFields: number;
}

export interface MarineErddapDependencies {
  fetch?: typeof fetch;
  now?: () => Date;
}

interface ErddapTable {
  columnNames: readonly string[];
  columnTypes: readonly string[];
  columnUnits: readonly (string | null)[];
  rows: readonly (readonly unknown[])[];
}

interface SearchRecord {
  dataId: string;
  title: string;
  summary?: string;
  institution?: string;
  licence?: string;
  accessible?: string;
  accessUrls: Readonly<Partial<Record<AccessId, string>>>;
}

interface ErddapField extends QueryFieldDescription {
  units?: string;
  dimension: boolean;
  size?: number;
  actualRange?: readonly [QueryFilterScalar, QueryFilterScalar];
  axis?: "latitude" | "longitude" | "time";
}

interface DatasetMetadata {
  title?: string;
  summary?: string;
  institution?: string;
  licence?: string;
  keywords: readonly string[];
  fields: readonly ErddapField[];
  fieldsTruncated: boolean;
}

interface ResolvedDataset {
  record: SearchRecord;
  metadata: DatasetMetadata;
  infoUrl: string;
}

interface GridSelection {
  hyperslabs: readonly string[];
  indexPaged: boolean;
  empty: boolean;
  total?: number;
}

export class MarineErddapAdapter {
  readonly config: MarineErddapSettings;

  private readonly fetcher: typeof fetch;
  private readonly now: () => Date;

  constructor(
    settings: MarineErddapSettings,
    dependencies: MarineErddapDependencies = {},
  ) {
    validateSettings(settings);
    this.config = settings;
    this.fetcher = dependencies.fetch ?? fetch;
    this.now = dependencies.now ?? (() => new Date());
  }

  async searchData(input: SearchDataInput): Promise<DataSearchResult> {
    const { limit, offset } = this.pagination(input.limit, input.offset);
    const records: SearchRecord[] = [];
    let nextOffset = offset;

    while (records.length < limit) {
      const page = Math.floor(nextOffset / 100) + 1;
      const withinPage = nextOffset % 100;
      const lastUrl = this.searchUrl(input.query, page, 100);
      const table = await this.requestTable(lastUrl);
      const pageRecords = parseSearchTable(table);
      const available = pageRecords.slice(withinPage, withinPage + limit - records.length);
      records.push(...available);
      if (withinPage + available.length < pageRecords.length) {
        break;
      }
      if (pageRecords.length < 100) {
        break;
      }
      nextOffset = page * 100;
    }

    const results = records.map((record) =>
      this.summary(record, `${this.config.baseUrl}/info/${encodeURIComponent(record.dataId)}/index.html`),
    );
    return this.bounded({
      results,
      pagination: { limit, offset, returned: results.length },
    });
  }

  async describeData(input: DescribeDataInput): Promise<DataDescription> {
    const dataset = await this.resolveDataset(input.data_id);
    const { record, metadata } = dataset;
    const describedRecord: SearchRecord = {
      ...record,
      title: metadata.title ?? record.title,
      ...(metadata.summary ? { summary: metadata.summary } : {}),
      ...(metadata.institution ? { institution: metadata.institution } : {}),
    };
    const accessPoints = ACCESS_IDS.flatMap((accessId) => {
      const advertisedUrl = record.accessUrls[accessId];
      if (!advertisedUrl) {
        return [];
      }
      return [this.accessPoint(input.data_id, accessId, advertisedUrl, metadata)];
    });
    const result: DataDescription = {
      ...this.summary(describedRecord, dataset.infoUrl),
      ...(metadata.licence ?? record.licence
        ? { licence: metadata.licence ?? record.licence }
        : {}),
      ...(metadata.keywords.length > 0 ? { tags: metadata.keywords } : {}),
      access_points: accessPoints,
    };
    return this.bounded(result);
  }

  async queryData(input: QueryDataInput): Promise<QueryDataResult> {
    const { limit, offset } = this.pagination(input.limit, input.offset);
    const dataset = await this.resolveDataset(input.data_id);
    const accessId = parseAccessId(input.access_id);
    if (accessId === "files") {
      throw new AppError("UNSUPPORTED_OPERATION");
    }
    if (!dataset.record.accessUrls[accessId]) {
      throw new AppError("RESOURCE_NOT_FOUND");
    }
    if (accessId === "tabledap") {
      return this.queryTabledap(dataset, input, limit, offset);
    }
    return this.queryGriddap(dataset, input, limit, offset);
  }

  async getDataLink(input: GetDataLinkInput): Promise<DataLink> {
    const dataset = await this.resolveDataset(input.data_id);
    const accessId = parseAccessId(input.access_id);
    const advertisedUrl = dataset.record.accessUrls[accessId];
    if (!advertisedUrl) {
      throw new AppError("RESOURCE_NOT_FOUND");
    }
    const url =
      accessId === "files"
        ? validateFilesUrl(advertisedUrl, input.data_id)
        : this.protocolUrl(accessId, input.data_id, "html");
    return this.bounded({
      data_id: input.data_id,
      access_id: accessId,
      url,
      format: "html",
      title: `${dataset.record.title} — ${accessTitle(accessId)}`,
      provenance: {
        source: MARINE_SOURCE,
        upstream_url: url,
        retrieved_at: this.now().toISOString(),
        original_format: "html",
      },
    });
  }

  private async queryTabledap(
    dataset: ResolvedDataset,
    input: QueryDataInput,
    limit: number,
    offset: number,
  ): Promise<QueryDataResult> {
    if (offset !== 0) {
      throw new AppError(
        "INVALID_REQUEST",
        "offset is not supported for ERDDAP tabledap queries.",
      );
    }
    const fields = selectedTableFields(
      input.fields,
      dataset.metadata,
      this.config.maxSelectedFields,
    );
    const constraints = tableConstraints(input, dataset.metadata);
    const query = [
      fields.map((field) => field.name).join(","),
      ...constraints,
      `orderByLimit(\"${limit + 1}\")`,
    ]
      .map((component) => encodeURIComponent(component))
      .join("&");
    const url = `${this.protocolUrl("tabledap", input.data_id, "json")}?${query}`;
    const table = await this.requestTable(url, true);
    const normalized = normalizeRows(table);
    const truncated = normalized.rows.length > limit;
    const rows = normalized.rows.slice(0, limit);
    const result: QueryDataResult = {
      data_id: input.data_id,
      access_id: "tabledap",
      data: { columns: normalized.columns, rows },
      provenance: {
        source: MARINE_SOURCE,
        upstream_url: url,
        retrieved_at: this.now().toISOString(),
        original_format: "json",
      },
      pagination_supported: false,
      truncated,
    };
    return this.bounded(result);
  }

  private async queryGriddap(
    dataset: ResolvedDataset,
    input: QueryDataInput,
    limit: number,
    offset: number,
  ): Promise<QueryDataResult> {
    const metadata = dataset.metadata;
    const dimensions = metadata.fields.filter((field) => field.dimension);
    const variables = metadata.fields.filter((field) => !field.dimension);
    if (dimensions.length === 0 || variables.length === 0) {
      throw new AppError("UNSUPPORTED_OPERATION");
    }
    const selected = selectedGridFields(
      input.fields,
      variables,
      this.config.maxSelectedFields,
    );
    const selection = gridSelection(input, dimensions, limit, offset);
    const projection = selected
      .map((field) => `${field.name}${selection.hyperslabs.join("")}`)
      .join(",");
    const url = `${this.protocolUrl("griddap", input.data_id, "json")}?${encodeURIComponent(projection)}`;
    const table = selection.empty
      ? { columnNames: [], columnTypes: [], columnUnits: [], rows: [] }
      : await this.requestTable(url, true);
    const normalized = normalizeRows(table);
    const truncated = normalized.rows.length > limit;
    const rows = normalized.rows.slice(0, limit);
    const result: QueryDataResult = {
      data_id: input.data_id,
      access_id: "griddap",
      data: { columns: normalized.columns, rows },
      provenance: {
        source: MARINE_SOURCE,
        upstream_url: url,
        retrieved_at: this.now().toISOString(),
        original_format: "json",
      },
      pagination_supported: selection.indexPaged,
      truncated,
      ...(selection.indexPaged
        ? {
            pagination: {
              limit,
              offset,
              returned: rows.length,
              ...(selection.total === undefined ? {} : { total: selection.total }),
            },
          }
        : {}),
    };
    return this.bounded(result);
  }

  private async resolveDataset(dataId: string): Promise<ResolvedDataset> {
    validateDataId(dataId);
    const searchUrl = this.searchUrl(dataId, 1, 100);
    const search = parseSearchTable(await this.requestTable(searchUrl));
    const record = search.find((candidate) => candidate.dataId === dataId);
    if (!record || !isPublicRecord(record)) {
      throw new AppError("DATASET_NOT_FOUND");
    }
    const infoUrl = `${this.config.baseUrl}/info/${encodeURIComponent(dataId)}/index.json`;
    let metadata: DatasetMetadata;
    try {
      metadata = parseInfoTable(
        await this.requestTable(infoUrl),
        this.config.maxSchemaFields,
      );
    } catch (error) {
      if (
        error instanceof AppError &&
        (error.code === "DATASET_NOT_FOUND" || error.code === "RESOURCE_NOT_FOUND")
      ) {
        throw new AppError("DATASET_NOT_FOUND");
      }
      throw error;
    }
    return { record, metadata, infoUrl };
  }

  private accessPoint(
    dataId: string,
    accessId: AccessId,
    advertisedUrl: string,
    metadata: DatasetMetadata,
  ): AccessPoint {
    const queryable = accessId !== "files";
    const link =
      accessId === "files"
        ? validateFilesUrl(advertisedUrl, dataId)
        : this.protocolUrl(accessId, dataId, "html");
    const schema = queryable ? querySchema(metadata, accessId) : undefined;
    return {
      access_id: accessId,
      title: accessTitle(accessId),
      format: accessId === "files" ? "files" : "json",
      capabilities: { query: queryable, link: true },
      ...(schema ? { query_schema: schema } : {}),
      upstream_url: link,
    };
  }

  private summary(record: SearchRecord, upstreamUrl: string): DataSummary {
    const formats = ACCESS_IDS.filter((accessId) => record.accessUrls[accessId]).map(
      (accessId) => (accessId === "files" ? "files" : "json"),
    );
    return {
      data_id: record.dataId,
      title: record.title,
      ...(record.summary ? { description: record.summary } : {}),
      ...(record.institution ? { publisher: record.institution } : {}),
      ...(formats.length > 0 ? { available_formats: [...new Set(formats)] } : {}),
      provenance: {
        source: MARINE_SOURCE,
        upstream_url: upstreamUrl,
        retrieved_at: this.now().toISOString(),
      },
    };
  }

  private searchUrl(query: string | undefined, page: number, items: number): string {
    const url = new URL(`${this.config.baseUrl}/search/index.json`);
    url.searchParams.set("page", String(page));
    url.searchParams.set("itemsPerPage", String(items));
    const normalized = query?.trim();
    if (normalized) {
      url.searchParams.set("searchFor", normalized);
    }
    return url.toString();
  }

  private protocolUrl(
    protocol: "tabledap" | "griddap",
    dataId: string,
    extension: "html" | "json",
  ): string {
    validateDataId(dataId);
    return `${this.config.baseUrl}/${protocol}/${encodeURIComponent(dataId)}.${extension}`;
  }

  private async requestTable(url: string, zeroRowsAreEmpty = false): Promise<ErddapTable> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
      try {
        const response = await this.fetcher(url, {
          headers: { accept: "application/json" },
          signal: controller.signal,
        });
        if (isRetryableStatus(response.status) && attempt === 0) {
          void response.body?.cancel().catch(() => undefined);
          continue;
        }
        const text = await readBoundedText(response, this.config.maxInputBytes, controller.signal);
        if (!response.ok) {
          if (response.status === 429) {
            throw new AppError("RATE_LIMITED");
          }
          if (zeroRowsAreEmpty && response.status === 404 && isNoRowsMessage(text)) {
            return { columnNames: [], columnTypes: [], columnUnits: [], rows: [] };
          }
          if (response.status === 401 || response.status === 403 || response.status === 404) {
            throw new AppError("DATASET_NOT_FOUND");
          }
          throw new AppError("UPSTREAM_ERROR", plainErddapError(text));
        }
        let value: unknown;
        try {
          value = JSON.parse(text);
        } catch {
          throw new AppError("UPSTREAM_ERROR");
        }
        return parseTable(value);
      } catch (error) {
        if (error instanceof AppError) {
          throw error;
        }
        if (controller.signal.aborted || isAbortError(error)) {
          if (attempt === 0) {
            continue;
          }
          throw new AppError("UPSTREAM_TIMEOUT");
        }
        throw new AppError("UPSTREAM_ERROR");
      } finally {
        clearTimeout(timer);
      }
    }
    throw new AppError("UPSTREAM_ERROR");
  }

  private pagination(limitValue?: number, offsetValue?: number) {
    const limit = limitValue ?? this.config.defaultLimit;
    const offset = offsetValue ?? 0;
    if (!Number.isInteger(limit) || limit < 1 || limit > this.config.maxLimit) {
      throw new AppError(
        "INVALID_REQUEST",
        `limit must be an integer from 1 to ${this.config.maxLimit}.`,
      );
    }
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new AppError("INVALID_REQUEST", "offset must be a non-negative integer.");
    }
    return { limit, offset };
  }

  private bounded<T>(value: T): T {
    enforceSerializedSize(value, this.config.maxOutputBytes);
    return value;
  }
}

function validateSettings(settings: MarineErddapSettings): void {
  if (settings.baseUrl !== MARINE_ERDDAP_BASE_URL) {
    throw new RangeError("baseUrl must be the official Marine Institute ERDDAP URL");
  }
  for (const [name, value] of Object.entries({
    timeoutMs: settings.timeoutMs,
    maxInputBytes: settings.maxInputBytes,
    maxOutputBytes: settings.maxOutputBytes,
    defaultLimit: settings.defaultLimit,
    maxLimit: settings.maxLimit,
    maxSchemaFields: settings.maxSchemaFields,
    maxSelectedFields: settings.maxSelectedFields,
  })) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new RangeError(`${name} must be a positive integer`);
    }
  }
  if (
    settings.defaultLimit > settings.maxLimit ||
    settings.maxLimit > 100 ||
    settings.maxSelectedFields > settings.maxSchemaFields
  ) {
    throw new RangeError("invalid ERDDAP limits");
  }
}

function parseTable(value: unknown): ErddapTable {
  const root = recordValue(value);
  const table = recordValue(root.table);
  const columnNames = stringArray(table.columnNames);
  const columnTypes = stringArray(table.columnTypes);
  const rawUnits = table.columnUnits === undefined
    ? columnNames.map(() => null)
    : arrayValue(table.columnUnits);
  const rows = arrayValue(table.rows).map((row) => arrayValue(row));
  if (
    columnNames.length === 0 ||
    columnTypes.length !== columnNames.length ||
    rawUnits.length !== columnNames.length ||
    rows.some((row) => row.length !== columnNames.length)
  ) {
    throw new AppError("UPSTREAM_ERROR");
  }
  const columnUnits = rawUnits.map((unit) => {
    if (unit === null || unit === "") return null;
    if (typeof unit !== "string") throw new AppError("UPSTREAM_ERROR");
    return unit;
  });
  return { columnNames, columnTypes, columnUnits, rows };
}

function parseSearchTable(table: ErddapTable): SearchRecord[] {
  const keys = table.columnNames.map(normalizedKey);
  const index = (aliases: readonly string[]) =>
    keys.findIndex((key) => aliases.includes(key));
  const positions = {
    dataId: index(["datasetid"]),
    title: index(["title"]),
    summary: index(["summary"]),
    institution: index(["institution"]),
    licence: index(["license", "licence"]),
    accessible: index(["accessible"]),
    tabledap: index(["tabledap", "dataaccessform"]),
    griddap: index(["griddap"]),
    files: index(["files"]),
  };
  if (positions.dataId < 0 || positions.title < 0) {
    throw new AppError("UPSTREAM_ERROR");
  }
  return table.rows.map((row) => {
    const dataId = rowString(row, positions.dataId, true)!;
    validateDataId(dataId);
    const tabledap = validatedAdvertisedProtocolUrl(
      rowString(row, positions.tabledap),
      "tabledap",
      dataId,
    );
    const griddap = validatedAdvertisedProtocolUrl(
      rowString(row, positions.griddap),
      "griddap",
      dataId,
    );
    const files = validatedAdvertisedFilesUrl(rowString(row, positions.files), dataId);
    return {
      dataId,
      title: rowString(row, positions.title, true)!,
      ...(rowString(row, positions.summary)
        ? { summary: rowString(row, positions.summary)! }
        : {}),
      ...(rowString(row, positions.institution)
        ? { institution: rowString(row, positions.institution)! }
        : {}),
      ...(rowString(row, positions.licence)
        ? { licence: rowString(row, positions.licence)! }
        : {}),
      ...(rowString(row, positions.accessible)
        ? { accessible: rowString(row, positions.accessible)! }
        : {}),
      accessUrls: {
        ...(tabledap ? { tabledap } : {}),
        ...(griddap ? { griddap } : {}),
        ...(files ? { files } : {}),
      },
    };
  });
}

function parseInfoTable(table: ErddapTable, maxFields: number): DatasetMetadata {
  const keys = table.columnNames.map(normalizedKey);
  const position = (name: string) => keys.indexOf(name);
  const rowTypeIndex = position("rowtype");
  const variableIndex = position("variablename");
  const attributeIndex = position("attributename");
  const dataTypeIndex = position("datatype");
  const valueIndex = position("value");
  if ([rowTypeIndex, variableIndex, attributeIndex, dataTypeIndex, valueIndex].some((i) => i < 0)) {
    throw new AppError("UPSTREAM_ERROR");
  }

  const global = new Map<string, string>();
  const rawFields: Array<{
    name: string;
    dataType: string;
    dimension: boolean;
    size?: number;
    attributes: Map<string, string>;
  }> = [];
  const fieldByName = new Map<string, (typeof rawFields)[number]>();

  for (const row of table.rows) {
    const rowType = rowString(row, rowTypeIndex, true)!.toLowerCase();
    const variable = rowString(row, variableIndex) ?? "";
    const attribute = rowString(row, attributeIndex) ?? "";
    const value = rowString(row, valueIndex) ?? "";
    if (rowType === "attribute") {
      if (variable === "NC_GLOBAL") {
        global.set(attribute.toLowerCase(), value);
      } else {
        fieldByName.get(variable)?.attributes.set(attribute.toLowerCase(), value);
      }
      continue;
    }
    if (rowType !== "variable" && rowType !== "dimension") {
      continue;
    }
    validateFieldName(variable);
    if (fieldByName.has(variable)) {
      throw new AppError("UPSTREAM_ERROR");
    }
    const field = {
      name: variable,
      dataType: rowString(row, dataTypeIndex, true)!,
      dimension: rowType === "dimension",
      ...(rowType === "dimension" && parseDimensionSize(value) !== undefined
        ? { size: parseDimensionSize(value) }
        : {}),
      attributes: new Map<string, string>(),
    };
    rawFields.push(field);
    fieldByName.set(variable, field);
  }

  const fieldsTruncated = rawFields.length > maxFields;
  const fields = rawFields.slice(0, maxFields).map((field) => {
    const axis = coordinateAxis(field.name, field.attributes);
    const type = fieldType(field.dataType, axis);
    const units = field.attributes.get("units")?.trim();
    const label = field.attributes.get("long_name")?.trim() || field.name;
    const actualRange = parseActualRange(field.attributes.get("actual_range"), type);
    return {
      name: field.name,
      label,
      type,
      operators: field.dimension
        ? (["eq", "lte", "gte"] as const)
        : operatorsForType(type),
      ...(units ? { units } : {}),
      dimension: field.dimension,
      ...(field.size === undefined ? {} : { size: field.size }),
      ...(actualRange ? { actualRange } : {}),
      ...(axis ? { axis } : {}),
    } satisfies ErddapField;
  });
  return {
    ...(global.get("title") ? { title: global.get("title") } : {}),
    ...(global.get("summary") ? { summary: global.get("summary") } : {}),
    ...(global.get("institution") ? { institution: global.get("institution") } : {}),
    ...(global.get("license") ?? global.get("licence")
      ? { licence: global.get("license") ?? global.get("licence") }
      : {}),
    keywords: splitKeywords(global.get("keywords")),
    fields,
    fieldsTruncated,
  };
}

function querySchema(metadata: DatasetMetadata, accessId: "tabledap" | "griddap"): QuerySchema {
  const fields = metadata.fields.map(({ dimension, size: _size, actualRange: _range, axis: _axis, ...field }) => ({
    ...field,
    ...(accessId === "griddap"
      ? { operators: dimension ? (["eq"] as const) : [] }
      : {}),
  }));
  const axes = new Set(metadata.fields.flatMap((field) => (field.axis ? [field.axis] : [])));
  const spatial = axes.has("latitude") && axes.has("longitude")
    ? (accessId === "griddap"
      ? (["point"] as const)
      : (["point", "bbox"] as const))
    : undefined;
  return {
    fields,
    truncated: metadata.fieldsTruncated,
    ...(spatial ? { spatial } : {}),
    supported_selectors: accessId === "griddap"
      ? ["fields", "filters", "spatial"]
      : ["fields", "filters", "spatial", "time_range"],
    required_selectors: [],
  };
}

function tableConstraints(input: QueryDataInput, metadata: DatasetMetadata): string[] {
  const fields = new Map(metadata.fields.map((field) => [field.name, field]));
  const filters = [...(input.filters ?? [])];
  addSpatialFilters(filters, input.spatial, metadata);
  addTimeFilters(filters, input.time_range, metadata);
  return filters.map((filter) => {
    const field = fields.get(filter.field);
    if (!field) {
      throw new AppError("INVALID_REQUEST", `Unknown field: ${filter.field}.`);
    }
    if (filter.operator === "in") {
      throw new AppError("UNSUPPORTED_OPERATION", "ERDDAP does not support the in operator.");
    }
    if (!field.operators.includes(filter.operator)) {
      throw new AppError("INVALID_REQUEST", `Operator ${filter.operator} is invalid for ${filter.field}.`);
    }
    return `${field.name}${FILTER_OPERATOR[filter.operator]}${formatConstraintValue(filter.value, field.type)}`;
  });
}

function gridSelection(
  input: QueryDataInput,
  dimensions: readonly ErddapField[],
  limit: number,
  offset: number,
): GridSelection {
  if (input.spatial?.type === "bbox") {
    throw new AppError(
      "INVALID_REQUEST",
      "Marine griddap queries support point spatial selection only.",
    );
  }
  if (input.time_range !== undefined) {
    throw new AppError(
      "INVALID_REQUEST",
      "Marine griddap queries do not support time_range; use an exact time filter or page one unbounded dimension.",
    );
  }
  const filters = [...(input.filters ?? [])];
  addSpatialFilters(filters, input.spatial, { fields: dimensions } as DatasetMetadata);
  const byDimension = new Map<string, QueryFilter[]>();
  for (const filter of filters) {
    const field = dimensions.find((candidate) => candidate.name === filter.field);
    if (!field) {
      throw new AppError(
        "INVALID_REQUEST",
        `Grid filters must target a described dimension: ${filter.field}.`,
      );
    }
    if (filter.operator !== "eq") {
      throw new AppError(
        "INVALID_REQUEST",
        "Marine griddap dimensions support exact eq filters only.",
      );
    }
    const current = byDimension.get(field.name) ?? [];
    current.push(filter);
    byDimension.set(field.name, current);
  }

  const unbounded = dimensions.filter(
    (dimension) => !byDimension.has(dimension.name),
  );
  if (unbounded.length > 1) {
    throw new AppError(
      "INVALID_REQUEST",
      "Marine griddap queries may leave at most one dimension unbounded; constrain every other dimension with eq.",
    );
  }
  if (unbounded.length === 0 && offset !== 0) {
    throw new AppError(
      "INVALID_REQUEST",
      "offset is unavailable when every grid dimension is constrained.",
    );
  }

  const pagedDimension = unbounded[0];
  const indexPaged = pagedDimension !== undefined;
  let empty = false;
  const total = pagedDimension?.size;
  if (pagedDimension && total === undefined) {
    throw new AppError(
      "INVALID_REQUEST",
      `A size is required to page grid dimension ${pagedDimension.name}.`,
    );
  }
  const hyperslabs = dimensions.map((dimension) => {
    const selected = dimensionSelection(dimension, byDimension.get(dimension.name) ?? []);
    if (selected) {
      return selected;
    }
    if (offset >= total!) {
      empty = true;
      return "[0:1:0]";
    }
    const stop = Math.min(offset + limit, total! - 1);
    return `[${offset}:1:${stop}]`;
  });
  return { hyperslabs, indexPaged, empty, ...(total === undefined ? {} : { total }) };
}

function dimensionSelection(
  dimension: ErddapField,
  filters: readonly QueryFilter[],
): string | undefined {
  if (filters.length === 0) return undefined;
  const equals = filters.filter((filter) => filter.operator === "eq");
  const lower = filters.filter((filter) => filter.operator === "gte");
  const upper = filters.filter((filter) => filter.operator === "lte");
  if (equals.length > 1 || lower.length > 1 || upper.length > 1 || (equals.length && filters.length > 1)) {
    throw new AppError("INVALID_REQUEST", `Conflicting constraints for ${dimension.name}.`);
  }
  if (equals[0]) {
    return `[(${formatGridValue(equals[0].value, dimension.type)})]`;
  }
  const min = lower[0]?.value ?? dimension.actualRange?.[0];
  const max = upper[0]?.value ?? dimension.actualRange?.[1];
  if (min === undefined || max === undefined) {
    throw new AppError(
      "INVALID_REQUEST",
      `Both bounds are required for grid dimension ${dimension.name}.`,
    );
  }
  return `[(${formatGridValue(min, dimension.type)}):1:(${formatGridValue(max, dimension.type)})]`;
}

function selectedTableFields(
  requested: readonly string[] | undefined,
  metadata: DatasetMetadata,
  maximum: number,
): readonly ErddapField[] {
  const fields = requested ?? metadata.fields.map((field) => field.name);
  if (fields.length === 0 || fields.length > maximum) {
    throw new AppError("INVALID_REQUEST", `Select between 1 and ${maximum} fields.`);
  }
  const available = new Map(metadata.fields.map((field) => [field.name, field]));
  return fields.map((name) => {
    const field = available.get(name);
    if (!field) throw new AppError("INVALID_REQUEST", `Unknown field: ${name}.`);
    return field;
  });
}

function selectedGridFields(
  requested: readonly string[] | undefined,
  variables: readonly ErddapField[],
  maximum: number,
): readonly ErddapField[] {
  const fields = requested ?? variables.map((field) => field.name);
  if (fields.length === 0 || fields.length > maximum) {
    throw new AppError("INVALID_REQUEST", `Select between 1 and ${maximum} grid variables.`);
  }
  const available = new Map(variables.map((field) => [field.name, field]));
  return fields.map((name) => {
    const field = available.get(name);
    if (!field) throw new AppError("INVALID_REQUEST", `Unknown grid variable: ${name}.`);
    return field;
  });
}

function addSpatialFilters(
  filters: QueryFilter[],
  spatial: QueryDataInput["spatial"],
  metadata: Pick<DatasetMetadata, "fields">,
): void {
  if (!spatial) return;
  const latitude = metadata.fields.find((field) => field.axis === "latitude");
  const longitude = metadata.fields.find((field) => field.axis === "longitude");
  if (!latitude || !longitude) {
    throw new AppError("UNSUPPORTED_OPERATION", "This dataset has no spatial coordinates.");
  }
  if (spatial.type === "point") {
    filters.push(
      { field: latitude.name, operator: "eq", value: spatial.latitude },
      { field: longitude.name, operator: "eq", value: spatial.longitude },
    );
  } else {
    filters.push(
      { field: longitude.name, operator: "gte", value: spatial.west },
      { field: longitude.name, operator: "lte", value: spatial.east },
      { field: latitude.name, operator: "gte", value: spatial.south },
      { field: latitude.name, operator: "lte", value: spatial.north },
    );
  }
}

function addTimeFilters(
  filters: QueryFilter[],
  range: QueryDataInput["time_range"],
  metadata: Pick<DatasetMetadata, "fields">,
): void {
  if (!range) return;
  const time = metadata.fields.find((field) => field.axis === "time");
  if (!time) {
    throw new AppError("UNSUPPORTED_OPERATION", "This dataset has no time coordinate.");
  }
  validateDateTime(range.start);
  validateDateTime(range.end);
  if (Date.parse(range.start) > Date.parse(range.end)) {
    throw new AppError("INVALID_REQUEST", "time_range start must not be after end.");
  }
  filters.push(
    { field: time.name, operator: "gte", value: range.start },
    { field: time.name, operator: "lte", value: range.end },
  );
}

function normalizeRows(table: ErddapTable) {
  const columns = table.columnNames.map((name, index) => ({
    name,
    type: normalizedType(table.columnTypes[index]!),
    ...(table.columnUnits[index] ? { units: table.columnUnits[index]! } : {}),
  }));
  const rows = table.rows.map((row) =>
    Object.fromEntries(
      table.columnNames.map((name, index) => [
        name,
        normalizeCell(row[index], columns[index]!.type),
      ]),
    ),
  );
  return { columns, rows };
}

function normalizeCell(value: unknown, type: QueryFieldDescription["type"]): unknown {
  if (value === null) return null;
  if (type === "number") {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
      return Number(value);
    }
    throw new AppError("UPSTREAM_ERROR");
  }
  if (type === "boolean") {
    if (typeof value === "boolean") return value;
    if (value === "true") return true;
    if (value === "false") return false;
    throw new AppError("UPSTREAM_ERROR");
  }
  if (typeof value !== "string") throw new AppError("UPSTREAM_ERROR");
  return value;
}

function formatConstraintValue(
  value: QueryFilterScalar,
  type: QueryFieldDescription["type"],
): string {
  if (type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new AppError("INVALID_REQUEST", "A numeric constraint requires a finite number.");
    }
    return String(value);
  }
  if (type === "boolean") {
    if (typeof value !== "boolean") {
      throw new AppError("INVALID_REQUEST", "A boolean constraint requires true or false.");
    }
    return String(value);
  }
  if (typeof value !== "string" || value.length > 500 || /[\u0000-\u001f]/u.test(value)) {
    throw new AppError("INVALID_REQUEST", "A string constraint is invalid.");
  }
  if (type === "datetime") validateDateTime(value);
  return JSON.stringify(value);
}

function formatGridValue(
  value: QueryFilterScalar | readonly QueryFilterScalar[],
  type: QueryFieldDescription["type"],
): string {
  if (Array.isArray(value)) throw new AppError("INVALID_REQUEST");
  const formatted = formatConstraintValue(value as QueryFilterScalar, type);
  return type === "datetime" ? formatted.slice(1, -1) : formatted;
}

function parseActualRange(
  value: string | undefined,
  type: QueryFieldDescription["type"],
): readonly [QueryFilterScalar, QueryFilterScalar] | undefined {
  if (!value) return undefined;
  const parts = value.split(",").map((part) => part.trim());
  if (parts.length !== 2) return undefined;
  if (type === "number") {
    const numbers = parts.map(Number);
    return numbers.every(Number.isFinite)
      ? [numbers[0]!, numbers[1]!]
      : undefined;
  }
  if (type === "datetime" && parts.every((part) => Number.isFinite(Date.parse(part)))) {
    return [parts[0]!, parts[1]!];
  }
  return undefined;
}

function parseDimensionSize(value: string): number | undefined {
  const match = /(?:^|\s)nValues\s*=\s*(\d+)/iu.exec(value);
  if (!match) return undefined;
  const size = Number(match[1]);
  return Number.isSafeInteger(size) && size > 0 ? size : undefined;
}

function coordinateAxis(
  name: string,
  attributes: ReadonlyMap<string, string>,
): ErddapField["axis"] | undefined {
  const axis = attributes.get("_coordinateaxistype")?.toLowerCase();
  const normalized = name.toLowerCase();
  if (axis === "lat" || axis === "latitude" || normalized === "latitude") return "latitude";
  if (axis === "lon" || axis === "longitude" || normalized === "longitude") return "longitude";
  if (axis === "time" || normalized === "time") return "time";
  return undefined;
}

function fieldType(
  dataType: string,
  axis: ErddapField["axis"],
): QueryFieldDescription["type"] {
  if (axis === "time") return "datetime";
  return normalizedType(dataType);
}

function normalizedType(dataType: string): QueryFieldDescription["type"] {
  const type = dataType.toLowerCase();
  if (type === "boolean") return "boolean";
  if (type === "string" || type === "char") return "string";
  if (/^(?:u?int|float|double|long|short|byte)/u.test(type)) return "number";
  throw new AppError("UPSTREAM_ERROR");
}

function operatorsForType(type: QueryFieldDescription["type"]): QueryFieldDescription["operators"] {
  return type === "boolean" ? ["eq"] : ["eq", "lt", "lte", "gt", "gte"];
}

function isPublicRecord(record: SearchRecord): boolean {
  if (!record.accessible) return true;
  return record.accessible.trim().toLowerCase() === "public";
}

function parseAccessId(value: string): AccessId {
  if (!ACCESS_IDS.includes(value as AccessId)) {
    throw new AppError("RESOURCE_NOT_FOUND");
  }
  return value as AccessId;
}

function accessTitle(accessId: AccessId): string {
  if (accessId === "tabledap") return "ERDDAP tabular data";
  if (accessId === "griddap") return "ERDDAP gridded data";
  return "ERDDAP source files";
}

function validatedAdvertisedProtocolUrl(
  value: string | undefined,
  protocol: "tabledap" | "griddap",
  dataId: string,
): string | undefined {
  if (!value) return undefined;
  const parsed = safeUrl(value);
  const expectedPath = `/erddap/${protocol}/${encodeURIComponent(dataId)}`;
  if (
    !parsed ||
    (parsed.pathname !== expectedPath && parsed.pathname !== `${expectedPath}.html`) ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new AppError("UPSTREAM_ERROR");
  }
  return parsed.toString();
}

function validatedAdvertisedFilesUrl(
  value: string | undefined,
  dataId: string,
): string | undefined {
  return value ? validateFilesUrl(value, dataId) : undefined;
}

function validateFilesUrl(value: string, dataId: string): string {
  const parsed = safeUrl(value);
  const expectedPrefix = `${MARINE_ERDDAP_BASE_URL}/files/${encodeURIComponent(dataId)}/`;
  if (!parsed || !parsed.toString().startsWith(expectedPrefix)) {
    throw new AppError("UPSTREAM_ERROR");
  }
  return parsed.toString();
}

function safeUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    if (
      !isBrowserDataUrl(value) ||
      url.protocol !== "https:" ||
      url.origin !== new URL(MARINE_ERDDAP_BASE_URL).origin
    ) {
      return undefined;
    }
    return url;
  } catch {
    return undefined;
  }
}

function validateDataId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/u.test(value)) {
    throw new AppError("INVALID_REQUEST", "data_id is not a valid ERDDAP dataset ID.");
  }
}

function validateFieldName(value: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,199}$/u.test(value)) {
    throw new AppError("UPSTREAM_ERROR");
  }
}

function validateDateTime(value: string): void {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new AppError("INVALID_REQUEST", "A datetime value must be valid ISO 8601.");
  }
}

function splitKeywords(value: string | undefined): string[] {
  if (!value) return [];
  return [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))].slice(0, 100);
}

function rowString(
  row: readonly unknown[],
  index: number,
  required = false,
): string | undefined {
  if (index < 0) return undefined;
  const value = row[index];
  if (value === null || value === "") {
    if (required) throw new AppError("UPSTREAM_ERROR");
    return undefined;
  }
  if (typeof value !== "string") throw new AppError("UPSTREAM_ERROR");
  const trimmed = value.trim();
  if (!trimmed && required) throw new AppError("UPSTREAM_ERROR");
  return trimmed || undefined;
}

function normalizedKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/gu, "");
}

function recordValue(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AppError("UPSTREAM_ERROR");
  }
  return value as JsonRecord;
}

function arrayValue(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new AppError("UPSTREAM_ERROR");
  return value;
}

function stringArray(value: unknown): string[] {
  const array = arrayValue(value);
  if (!array.every((item) => typeof item === "string")) {
    throw new AppError("UPSTREAM_ERROR");
  }
  return array as string[];
}

function isNoRowsMessage(value: string): boolean {
  const normalized = value.toLowerCase();
  return normalized.includes("no matching results") || normalized.includes("no data");
}

function plainErddapError(value: string): string {
  const firstLine = value.replace(/\s+/gu, " ").trim().slice(0, 300);
  return firstLine ? `ERDDAP: ${firstLine}` : "The upstream provider returned an error.";
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function isRetryableStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 504;
}

async function readBoundedText(
  response: Response,
  maximum: number,
  signal: AbortSignal,
): Promise<string> {
  const length = response.headers.get("content-length");
  if (length && /^\d+$/u.test(length) && BigInt(length) > BigInt(maximum)) {
    void response.body?.cancel().catch(() => undefined);
    throw new AppError("RESOURCE_TOO_LARGE");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new AppError("UPSTREAM_ERROR");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  let text = "";
  try {
    while (true) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      const part = await reader.read();
      if (part.done) {
        text += decoder.decode();
        break;
      }
      size += part.value.byteLength;
      if (size > maximum) {
        void reader.cancel().catch(() => undefined);
        throw new AppError("RESOURCE_TOO_LARGE");
      }
      text += decoder.decode(part.value, { stream: true });
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  return text;
}
