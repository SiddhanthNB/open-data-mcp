import { AppError } from "../../errors";
import type {
  AccessPoint,
  DataDescription,
  DataLink,
  DataSearchResult,
  DataSummary,
  QueryDataResult,
  QueryFieldDescription,
  QueryFilter,
  Source,
} from "../../models";
import {
  abortable,
  cancelBody,
  enforceSerializedSize,
  readBoundedJsonResponse,
} from "../../resources/limits";
import type {
  DescribeDataInput,
  GetDataLinkInput,
  QueryDataInput,
  SearchDataInput,
} from "../provider";

export const EIRGRID_SOURCE_ID = "eirgrid";
export const EIRGRID_ACCESS_ID = "quarter_hourly";
export const EIRGRID_ATTRIBUTION = "Supported by EirGrid Group Data";

export const EIRGRID_VARGEN_TEMPLATE =
  "https://www.vargen.smartgriddashboard.com/api/export/{start}/{end}/{region}/{area}?FORMAT=JSON";
export const EIRGRID_INTERCONNECTOR_TEMPLATE =
  "https://www.interconn.smartgriddashboard.com/api/Interconnector/{start}/{end}/ALL?format=json";

const EIRGRID_SOURCE = EIRGRID_SOURCE_ID as Source;
const DUBLIN_TIME_ZONE = "Europe/Dublin";
const DAY_MS = 24 * 60 * 60 * 1_000;

const REGIONS = ["ROI", "NI", "ALL"] as const;
type Region = (typeof REGIONS)[number];

export const EIRGRID_INTERCONNECTOR_FIELDS = [
  "INTER_EWIC",
  "INTER_GRNLK",
  "INTER_MOYLE",
  "INTER_NET",
] as const;
type InterconnectorField = (typeof EIRGRID_INTERCONNECTOR_FIELDS)[number];

const VARGEN_FIELDS: readonly QueryFieldDescription[] = [
  { name: "Effective_Date", type: "datetime", operators: [] },
  { name: "MW_ACTUAL", type: "number", operators: [] },
  { name: "MW_FORECAST", type: "number", operators: [] },
  {
    name: "Region",
    type: "string",
    operators: ["eq"],
    values: REGIONS.map((value) => ({ value })),
  },
];

const INTERCONNECTOR_FIELDS: readonly QueryFieldDescription[] = [
  { name: "Effective_Date", type: "datetime", operators: [] },
  {
    name: "Field_Name",
    type: "string",
    operators: ["eq", "in"],
    values: EIRGRID_INTERCONNECTOR_FIELDS.map((value) => ({ value })),
  },
  { name: "Region", type: "string", operators: [] },
  { name: "Value", type: "number", operators: [] },
];

export type EirGridDatasetSetting =
  | {
      dataId: "wind_generation" | "solar_generation";
      title: string;
      description: string;
      kind: "variable_generation";
      area: "WIND" | "SOLAR";
      endpointTemplate: typeof EIRGRID_VARGEN_TEMPLATE;
    }
  | {
      dataId: "interconnector_flows";
      title: string;
      description: string;
      kind: "interconnector";
      endpointTemplate: typeof EIRGRID_INTERCONNECTOR_TEMPLATE;
      allowedFieldNames: readonly InterconnectorField[];
    };

export const EIRGRID_DATASETS: readonly EirGridDatasetSetting[] = [
  {
    dataId: "wind_generation",
    title: "Wind generation",
    description:
      "Actual and forecast wind generation for ROI, NI or ALL at 15-minute resolution. Upstream timestamps are Europe/Dublin local wall-clock values.",
    kind: "variable_generation",
    area: "WIND",
    endpointTemplate: EIRGRID_VARGEN_TEMPLATE,
  },
  {
    dataId: "solar_generation",
    title: "Solar generation",
    description:
      "Actual and forecast large-scale solar generation for ROI, NI or ALL at 15-minute resolution. Upstream timestamps are Europe/Dublin local wall-clock values.",
    kind: "variable_generation",
    area: "SOLAR",
    endpointTemplate: EIRGRID_VARGEN_TEMPLATE,
  },
  {
    dataId: "interconnector_flows",
    title: "Interconnector flows",
    description:
      "EWIC and Greenlink (ROI), Moyle (NI), and net all-island (ALL) flows at 15-minute resolution. Upstream timestamps are Europe/Dublin local wall-clock values; geographic modes remain separate.",
    kind: "interconnector",
    endpointTemplate: EIRGRID_INTERCONNECTOR_TEMPLATE,
    allowedFieldNames: EIRGRID_INTERCONNECTOR_FIELDS,
  },
] as const;

export interface EirGridSettings {
  sourceId: typeof EIRGRID_SOURCE_ID;
  accessId: typeof EIRGRID_ACCESS_ID;
  attribution: typeof EIRGRID_ATTRIBUTION;
  datasets: readonly EirGridDatasetSetting[];
  timeoutMs: number;
  maxInputBytes: number;
  maxOutputBytes: number;
  defaultLimit: number;
  maxLimit: number;
}

export interface EirGridDependencies {
  fetch?: typeof fetch;
  now?: () => Date;
}

type JsonScalar = string | number | boolean | null;
type UpstreamRow = Readonly<Record<string, JsonScalar>>;

export class EirGridAdapter {
  readonly config: EirGridSettings;

  private readonly fetcher: typeof fetch;
  private readonly now: () => Date;
  private readonly datasets: ReadonlyMap<string, EirGridDatasetSetting>;

  constructor(
    settings: EirGridSettings,
    dependencies: EirGridDependencies = {},
  ) {
    validateSettings(settings);
    this.config = settings;
    this.fetcher = dependencies.fetch ?? fetch;
    this.now = dependencies.now ?? (() => new Date());
    this.datasets = new Map(
      settings.datasets.map((dataset) => [dataset.dataId, dataset]),
    );
  }

  async searchData(input: SearchDataInput): Promise<DataSearchResult> {
    const { limit, offset } = this.pagination(input.limit, input.offset);
    const terms = input.query?.trim().toLocaleLowerCase("en-IE").split(/\s+/u) ?? [];
    const matches = this.config.datasets.filter((dataset) => {
      const searchable = `${dataset.dataId} ${dataset.title} ${dataset.description} EirGrid electricity energy`.toLocaleLowerCase("en-IE");
      return terms.every((term) => searchable.includes(term));
    });
    const results = matches
      .slice(offset, offset + limit)
      .map((dataset) => this.summary(dataset));
    return this.bounded({
      results,
      pagination: {
        limit,
        offset,
        returned: results.length,
        total: matches.length,
      },
    });
  }

  async describeData(input: DescribeDataInput): Promise<DataDescription> {
    const dataset = this.requireDataset(input.data_id);
    return this.bounded({
      ...this.summary(dataset),
      licence: this.config.attribution,
      tags: ["electricity", "EirGrid", "quarter-hourly"],
      access_points: [this.accessPoint(dataset)],
    });
  }

  async queryData(input: QueryDataInput): Promise<QueryDataResult> {
    const dataset = this.requireDataset(input.data_id);
    this.requireAccessId(input.access_id);
    rejectUnsupportedSelectors(input);
    const { limit, offset } = this.pagination(input.limit, input.offset);
    const range = requireTimeRange(input.time_range);
    const fields = requireProjection(input.fields, dataset);
    const selection = requireFilters(input.filters, dataset);
    const url = buildUrl(dataset, range, selection.region);
    const body = await this.requestJson(url);
    let rows = parseRows(body);

    if (dataset.kind === "variable_generation") {
      if (rows.some((row) => row.Region !== selection.region)) {
        throw new AppError("UPSTREAM_ERROR");
      }
    } else if (selection.fieldNames) {
      const allowed = new Set(selection.fieldNames);
      rows = rows.filter(
        (row) =>
          typeof row.Field_Name === "string" &&
          allowed.has(row.Field_Name as InterconnectorField),
      );
    }

    if (fields) {
      rows = rows.map((row) => projectRow(row, fields));
    }
    const page = rows.slice(offset, offset + limit);
    return this.bounded({
      data_id: dataset.dataId,
      access_id: this.config.accessId,
      data: { rows: page },
      provenance: {
        source: EIRGRID_SOURCE,
        upstream_url: url,
        retrieved_at: this.now().toISOString(),
        original_format: "json",
      },
      pagination_supported: true,
      pagination: {
        limit,
        offset,
        returned: page.length,
        total: rows.length,
      },
    });
  }

  async getDataLink(input: GetDataLinkInput): Promise<DataLink> {
    this.requireDataset(input.data_id);
    this.requireAccessId(input.access_id);
    throw new AppError(
      "UNSUPPORTED_OPERATION",
      "EirGrid time-series access requires a dynamic time-range query.",
    );
  }

  private summary(dataset: EirGridDatasetSetting): DataSummary {
    return {
      data_id: dataset.dataId,
      title: dataset.title,
      description: `${dataset.description} ${this.config.attribution}.`,
      publisher: "EirGrid Group",
      available_formats: ["json"],
      provenance: {
        source: EIRGRID_SOURCE,
        upstream_url: dataset.endpointTemplate,
        retrieved_at: this.now().toISOString(),
      },
    };
  }

  private accessPoint(dataset: EirGridDatasetSetting): AccessPoint {
    const queryInstructions =
      dataset.kind === "variable_generation"
        ? "Selectable fields: Effective_Date, MW_ACTUAL, MW_FORECAST, Region. Exactly one Region eq ROI|NI|ALL filter is required."
        : "Selectable fields: Effective_Date, Field_Name, Region, Value. One optional Field_Name eq|in filter may select configured interconnectors.";
    return {
      access_id: this.config.accessId,
      title: `${dataset.title} — quarter-hourly`,
      description:
        `${dataset.description} ${queryInstructions} RFC3339 request instants are converted to Europe/Dublin local wall-clock request timestamps. ${this.config.attribution}.`,
      format: "json",
      capabilities: { query: true, link: false },
      query_schema: {
        fields:
          dataset.kind === "variable_generation"
            ? VARGEN_FIELDS
            : INTERCONNECTOR_FIELDS,
        truncated: false,
      },
      upstream_url: dataset.endpointTemplate,
    };
  }

  private requireDataset(dataId: string): EirGridDatasetSetting {
    const dataset = this.datasets.get(dataId);
    if (!dataset) {
      throw new AppError("DATASET_NOT_FOUND");
    }
    return dataset;
  }

  private requireAccessId(accessId: string): void {
    if (accessId !== this.config.accessId) {
      throw new AppError("RESOURCE_NOT_FOUND");
    }
  }

  private pagination(
    requestedLimit: number | undefined,
    requestedOffset: number | undefined,
  ): { limit: number; offset: number } {
    const limit = requestedLimit ?? this.config.defaultLimit;
    const offset = requestedOffset ?? 0;
    if (
      !Number.isInteger(limit) ||
      limit <= 0 ||
      limit > this.config.maxLimit ||
      !Number.isInteger(offset) ||
      offset < 0
    ) {
      throw new AppError(
        "INVALID_REQUEST",
        `limit must be between 1 and ${this.config.maxLimit}; offset must be a non-negative integer.`,
      );
    }
    return { limit, offset };
  }

  private async requestJson(url: string): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const response = await abortable(
        this.fetcher(url, {
          headers: { accept: "application/json" },
          redirect: "error",
          signal: controller.signal,
        }),
        controller.signal,
      );
      if (response.status === 429) {
        cancelBody(response.body);
        throw new AppError("RATE_LIMITED");
      }
      if (!response.ok) {
        cancelBody(response.body);
        throw new AppError("UPSTREAM_ERROR");
      }
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (contentType !== "" && !contentType.includes("application/json")) {
        cancelBody(response.body);
        throw new AppError("UPSTREAM_ERROR");
      }
      return await readBoundedJsonResponse(
        response,
        this.config.maxInputBytes,
        controller.signal,
      );
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      if (controller.signal.aborted || isAbortError(error)) {
        throw new AppError("UPSTREAM_TIMEOUT");
      }
      throw new AppError("UPSTREAM_ERROR");
    } finally {
      clearTimeout(timeout);
    }
  }

  private bounded<T>(value: T): T {
    enforceSerializedSize(value, this.config.maxOutputBytes);
    return value;
  }
}

interface FilterSelection {
  region?: Region;
  fieldNames?: readonly InterconnectorField[];
}

function requireFilters(
  filters: readonly QueryFilter[] | undefined,
  dataset: EirGridDatasetSetting,
): FilterSelection {
  if (dataset.kind === "variable_generation") {
    if (
      filters?.length !== 1 ||
      filters[0]?.field !== "Region" ||
      filters[0].operator !== "eq" ||
      typeof filters[0].value !== "string" ||
      !REGIONS.includes(filters[0].value as Region)
    ) {
      throw new AppError(
        "INVALID_REQUEST",
        "Wind and solar queries require exactly one Region eq ROI|NI|ALL filter.",
      );
    }
    return { region: filters[0].value as Region };
  }

  if (!filters || filters.length === 0) {
    return {};
  }
  if (filters.length !== 1 || filters[0]?.field !== "Field_Name") {
    throw new AppError(
      "INVALID_REQUEST",
      "Interconnector queries allow only one optional Field_Name eq|in filter.",
    );
  }
  const filter = filters[0];
  const values =
    filter.operator === "eq" && typeof filter.value === "string"
      ? [filter.value]
      : filter.operator === "in" && Array.isArray(filter.value)
        ? filter.value
        : undefined;
  if (
    !values ||
    values.length === 0 ||
    new Set(values).size !== values.length ||
    values.some(
      (value) =>
        typeof value !== "string" ||
        !dataset.allowedFieldNames.includes(value as InterconnectorField),
    )
  ) {
    throw new AppError(
      "INVALID_REQUEST",
      "Field_Name must use eq or in with configured interconnector field names.",
    );
  }
  return { fieldNames: values as InterconnectorField[] };
}

function requireProjection(
  requested: readonly string[] | undefined,
  dataset: EirGridDatasetSetting,
): readonly string[] | undefined {
  if (requested === undefined) {
    return undefined;
  }
  const allowed = new Set(
    (dataset.kind === "variable_generation"
      ? VARGEN_FIELDS
      : INTERCONNECTOR_FIELDS
    ).map((field) => field.name),
  );
  if (
    requested.length === 0 ||
    new Set(requested).size !== requested.length ||
    requested.some((field) => !allowed.has(field))
  ) {
    throw new AppError(
      "INVALID_REQUEST",
      "fields must be a non-empty unique selection from the described schema.",
    );
  }
  return requested;
}

function rejectUnsupportedSelectors(input: QueryDataInput): void {
  if (input.spatial !== undefined) {
    throw new AppError(
      "UNSUPPORTED_OPERATION",
      "EirGrid time-series queries do not support spatial selection.",
    );
  }
}

function requireTimeRange(
  range: QueryDataInput["time_range"],
): { start: Date; end: Date } {
  if (!range) {
    throw new AppError("INVALID_REQUEST", "time_range is required.");
  }
  const start = parseRfc3339Minute(range.start, "time_range.start");
  const end = parseRfc3339Minute(range.end, "time_range.end");
  const duration = end.getTime() - start.getTime();
  if (duration <= 0 || duration > DAY_MS) {
    throw new AppError(
      "INVALID_REQUEST",
      "time_range.end must be after start and no more than 24 hours later.",
    );
  }
  return { start, end };
}

function parseRfc3339Minute(value: string, name: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/.exec(
    value,
  );
  if (!match) {
    throw new AppError("INVALID_REQUEST", `${name} must be an RFC3339 timestamp.`);
  }
  const [, year, month, day, hour, minute, second, fraction = "", offset] = match;
  const yearNumber = Number(year);
  const monthNumber = Number(month);
  const dayNumber = Number(day);
  const validDay =
    monthNumber >= 1 &&
    monthNumber <= 12 &&
    dayNumber >= 1 &&
    dayNumber <= new Date(Date.UTC(yearNumber, monthNumber, 0)).getUTCDate();
  const offsetValid =
    offset === "Z" ||
    (Number(offset.slice(1, 3)) <= 23 && Number(offset.slice(4, 6)) <= 59);
  if (
    !validDay ||
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(second) !== 0 ||
    (fraction !== "" && !/^0+$/u.test(fraction)) ||
    !offsetValid
  ) {
    throw new AppError(
      "INVALID_REQUEST",
      `${name} must be a valid RFC3339 timestamp aligned to a whole minute.`,
    );
  }
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime())) {
    throw new AppError("INVALID_REQUEST", `${name} must be an RFC3339 timestamp.`);
  }
  return instant;
}

function buildUrl(
  dataset: EirGridDatasetSetting,
  range: { start: Date; end: Date },
  region: Region | undefined,
): string {
  const start = dublinRequestTimestamp(range.start);
  const end = dublinRequestTimestamp(range.end);
  if (dataset.kind === "variable_generation") {
    if (!region) {
      throw new AppError("INVALID_REQUEST");
    }
    return dataset.endpointTemplate
      .replace("{start}", start)
      .replace("{end}", end)
      .replace("{region}", region)
      .replace("{area}", dataset.area);
  }
  return dataset.endpointTemplate
    .replace("{start}", start)
    .replace("{end}", end);
}

export function dublinRequestTimestamp(instant: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: DUBLIN_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}${values.month}${values.day}${values.hour}${values.minute}`;
}

function parseRows(value: unknown): UpstreamRow[] {
  if (!isRecord(value) || !Array.isArray(value.Rows)) {
    throw new AppError("UPSTREAM_ERROR");
  }
  if ("Status" in value && value.Status !== "Success") {
    throw new AppError("UPSTREAM_ERROR");
  }
  return value.Rows.map((row) => {
    if (
      !isRecord(row) ||
      Object.values(row).some(
        (field) =>
          field !== null &&
          typeof field !== "string" &&
          typeof field !== "number" &&
          typeof field !== "boolean",
      )
    ) {
      throw new AppError("UPSTREAM_ERROR");
    }
    return row as UpstreamRow;
  });
}

function projectRow(
  row: UpstreamRow,
  fields: readonly string[],
): UpstreamRow {
  return Object.fromEntries(
    fields.filter((field) => field in row).map((field) => [field, row[field]!]),
  );
}

function validateSettings(settings: EirGridSettings): void {
  if (
    settings.sourceId !== EIRGRID_SOURCE_ID ||
    settings.accessId !== EIRGRID_ACCESS_ID ||
    settings.attribution !== EIRGRID_ATTRIBUTION ||
    !Number.isInteger(settings.timeoutMs) ||
    settings.timeoutMs <= 0 ||
    !Number.isInteger(settings.maxInputBytes) ||
    settings.maxInputBytes <= 0 ||
    !Number.isInteger(settings.maxOutputBytes) ||
    settings.maxOutputBytes <= 0 ||
    !Number.isInteger(settings.defaultLimit) ||
    settings.defaultLimit <= 0 ||
    !Number.isInteger(settings.maxLimit) ||
    settings.maxLimit <= 0 ||
    settings.maxLimit > 100 ||
    settings.defaultLimit > settings.maxLimit
  ) {
    throw new RangeError("Invalid EirGrid settings");
  }
  const expected = new Map(EIRGRID_DATASETS.map((item) => [item.dataId, item]));
  if (
    settings.datasets.length !== expected.size ||
    new Set(settings.datasets.map((item) => item.dataId)).size !== expected.size
  ) {
    throw new RangeError("Exactly three EirGrid datasets must be configured");
  }
  for (const dataset of settings.datasets) {
    const reference = expected.get(dataset.dataId);
    if (
      !reference ||
      dataset.title !== reference.title ||
      dataset.description !== reference.description ||
      dataset.kind !== reference.kind ||
      dataset.endpointTemplate !== reference.endpointTemplate ||
      (dataset.kind === "variable_generation" &&
        (reference.kind !== "variable_generation" || dataset.area !== reference.area)) ||
      (dataset.kind === "interconnector" &&
        (reference.kind !== "interconnector" ||
          dataset.allowedFieldNames.length !==
            EIRGRID_INTERCONNECTOR_FIELDS.length ||
          dataset.allowedFieldNames.some(
            (field, index) => field !== EIRGRID_INTERCONNECTOR_FIELDS[index],
          )))
    ) {
      throw new RangeError("Invalid EirGrid dataset configuration");
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
