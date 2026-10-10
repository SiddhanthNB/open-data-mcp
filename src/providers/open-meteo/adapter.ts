import { AppError } from "../../errors";
import {
  OPEN_METEO_HOURLY_FIELDS,
  type ForecastApiProviderConfig,
  type DataDescription,
  type DataLink,
  type DataSearchResult,
  type DataSummary,
  type OpenMeteoHourlyField,
  type QueryDataResult,
  type SpatialPoint,
  type TimeRange,
} from "../../models";
import { cancelBody, enforceSerializedSize, readBoundedJsonResponse } from "../../resources/limits";
import type {
  DescribeDataInput,
  GetDataLinkInput,
  ProviderAdapter,
  QueryDataInput,
  SearchDataInput,
} from "../provider";
import { isInRepublicOfIreland } from "./ireland-boundary";

export const OPEN_METEO_DATA_ID = "weather_forecast";
export const OPEN_METEO_ACCESS_ID = "hourly_forecast";

const PROVIDER_ID = "open_meteo_ie";
const OFFICIAL_API_ENDPOINT = "https://api.open-meteo.com/v1/forecast";
const SUPPORTED_MODEL = "ecmwf_ifs";
const ABSOLUTE_MAX_FIELDS = 10;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

export { OPEN_METEO_HOURLY_FIELDS };
export type { OpenMeteoHourlyField };
export type OpenMeteoSettings = ForecastApiProviderConfig["forecast"];
export type OpenMeteoProviderConfig = ForecastApiProviderConfig;

export interface OpenMeteoAdapterDependencies {
  maxInputBytes: number;
  maxOutputBytes: number;
  fetch?: typeof fetch;
  now?: () => Date;
}

interface ForecastRow {
  timestamp: string;
  [field: string]: string | number | null;
}

interface ForecastData {
  rows: readonly ForecastRow[];
  units: Readonly<Record<string, string>>;
  requested_coordinates: {
    latitude: number;
    longitude: number;
  };
  resolved_coordinates: {
    latitude: number;
    longitude: number;
  };
  data_kind: "model_forecast";
  observation: false;
  authoritative: false;
  model_id: string;
  snapshot_stable: false;
  attribution: OpenMeteoSettings["attribution"];
}

export class OpenMeteoAdapter implements ProviderAdapter {
  readonly config: OpenMeteoProviderConfig;

  private readonly fetcher: typeof fetch;
  private readonly maxInputBytes: number;
  private readonly maxOutputBytes: number;
  private readonly now: () => Date;

  constructor(
    config: OpenMeteoProviderConfig,
    dependencies: OpenMeteoAdapterDependencies,
  ) {
    if (String(config.provider) !== PROVIDER_ID) {
      throw new RangeError(`provider must be ${PROVIDER_ID}`);
    }
    requirePositiveInteger(config.http_timeout_ms, "http_timeout_ms");
    requirePositiveInteger(config.pagination.default_limit, "default_limit");
    requirePositiveInteger(config.pagination.max_limit, "max_limit");
    requirePositiveInteger(dependencies.maxInputBytes, "maxInputBytes");
    requirePositiveInteger(dependencies.maxOutputBytes, "maxOutputBytes");
    validateSettings(config.forecast);
    this.config = config;
    this.fetcher = dependencies.fetch ?? fetch;
    this.maxInputBytes = dependencies.maxInputBytes;
    this.maxOutputBytes = dependencies.maxOutputBytes;
    this.now = dependencies.now ?? (() => new Date());
  }

  async searchData(input: SearchDataInput): Promise<DataSearchResult> {
    const { limit, offset } = this.pagination(input.limit, input.offset);
    const matches = matchesSearch(input.query);
    const catalogue = matches ? [this.summary()] : [];
    const results = catalogue.slice(offset, offset + limit);

    return {
      results,
      pagination: {
        limit,
        offset,
        returned: results.length,
        total: catalogue.length,
      },
    };
  }

  async describeData(input: DescribeDataInput): Promise<DataDescription> {
    this.requireDataId(input.data_id);
    return {
      ...this.summary(),
      licence: this.config.forecast.attribution.licence,
      tags: ["weather", "forecast", "Ireland", "ECMWF"],
      access_points: [
        {
          access_id: this.config.forecast.access_id,
          title: "Hourly ECMWF IFS forecast",
          description:
            "Point forecast for the Republic of Ireland. Model output, not an observation or an official Irish forecast.",
          format: "json",
          capabilities: { query: true, link: false },
          upstream_url: this.config.forecast.endpoint,
        },
      ],
    };
  }

  async queryData(input: QueryDataInput): Promise<QueryDataResult> {
    this.requireDataId(input.data_id);
    this.requireAccessId(input.access_id);
    const { limit, offset } = this.pagination(input.limit, input.offset);
    const point = requireIrishPoint(input.spatial);
    const fields = requireFields(input.fields, this.config.forecast);
    const range = requireForecastRange(
      input.time_range,
      this.now(),
      this.config.forecast.horizon_days,
    );
    const upstreamUrl = buildForecastUrl(
      point,
      fields,
      range,
      this.config.forecast,
    );
    const response = await this.fetchForecast(upstreamUrl);
    const normalized = normalizeForecast(
      response,
      fields,
      point,
      range,
      this.config.forecast,
    );
    const rows = normalized.rows.slice(offset, offset + limit);

    const result: QueryDataResult = {
      data_id: this.config.forecast.data_id,
      access_id: this.config.forecast.access_id,
      data: { ...normalized, rows },
      provenance: {
        source: this.config.provider,
        upstream_url: upstreamUrl,
        retrieved_at: this.now().toISOString(),
        original_format: "json",
      },
      pagination_supported: true,
      pagination: {
        limit,
        offset,
        returned: rows.length,
        total: normalized.rows.length,
      },
    };
    enforceSerializedSize(result, this.maxOutputBytes);
    return result;
  }

  async getDataLink(input: GetDataLinkInput): Promise<DataLink> {
    this.requireDataId(input.data_id);
    this.requireAccessId(input.access_id);
    throw new AppError(
      "UNSUPPORTED_OPERATION",
      "Open-Meteo forecasts require a dynamic point and time-range query.",
    );
  }

  private summary(): DataSummary {
    return {
      data_id: this.config.forecast.data_id,
      title: "Ireland ECMWF IFS weather forecast",
      description:
        "Non-authoritative ECMWF IFS model forecasts delivered by Open-Meteo for points inside the Republic of Ireland.",
      publisher: "Open-Meteo GmbH",
      available_formats: ["json"],
      provenance: {
        source: this.config.provider,
        upstream_url: this.config.forecast.endpoint,
        retrieved_at: this.now().toISOString(),
      },
    };
  }

  private async fetchForecast(url: string): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.http_timeout_ms);
    try {
      const response = await this.fetcher(url, {
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
      if (response.status === 429) {
        cancelBody(response.body);
        throw new AppError("RATE_LIMITED");
      }
      if (!response.ok) {
        cancelBody(response.body);
        throw new AppError("UPSTREAM_ERROR");
      }
      return await readBoundedJsonResponse(response, this.maxInputBytes, controller.signal);
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
      throw new AppError("INVALID_REQUEST", "limit or offset is outside the configured bounds.");
    }
    return { limit, offset };
  }

  private requireDataId(dataId: string): void {
    if (dataId !== this.config.forecast.data_id) {
      throw new AppError("DATASET_NOT_FOUND");
    }
  }

  private requireAccessId(accessId: string): void {
    if (accessId !== this.config.forecast.access_id) {
      throw new AppError("RESOURCE_NOT_FOUND");
    }
  }
}

function matchesSearch(query: string | undefined): boolean {
  if (query === undefined || query.trim() === "") {
    return true;
  }
  const searchable = [
    OPEN_METEO_DATA_ID,
    "Ireland ECMWF IFS weather forecast",
    "Open-Meteo GmbH",
    "weather forecast Ireland ECMWF model",
  ].join(" ").toLowerCase();
  return query.trim().toLowerCase().split(/\s+/u).every((term) => searchable.includes(term));
}

function requireIrishPoint(spatial: SpatialPoint | undefined): SpatialPoint {
  if (
    !spatial ||
    spatial.type !== "point" ||
    !Number.isFinite(spatial.latitude) ||
    !Number.isFinite(spatial.longitude)
  ) {
    throw new AppError("INVALID_REQUEST", "spatial must be a finite WGS84 point.");
  }
  if (!isInRepublicOfIreland(spatial.latitude, spatial.longitude)) {
    throw new AppError("INVALID_REQUEST", "spatial point must be inside the Republic of Ireland.");
  }
  return spatial;
}

function requireFields(
  fields: readonly string[] | undefined,
  settings: OpenMeteoSettings,
): readonly OpenMeteoHourlyField[] {
  if (!fields || fields.length === 0 || fields.length > settings.max_fields) {
    throw new AppError(
      "INVALID_REQUEST",
      `fields must contain between 1 and ${settings.max_fields} values.`,
    );
  }
  const unique = new Set(fields);
  if (
    unique.size !== fields.length ||
    fields.some(
      (field) =>
        !settings.allowed_hourly_fields.includes(
          field as OpenMeteoHourlyField,
        ),
    )
  ) {
    throw new AppError("INVALID_REQUEST", "fields contains a duplicate or unsupported hourly field.");
  }
  return fields as readonly OpenMeteoHourlyField[];
}

function isHourlyField(value: string): value is OpenMeteoHourlyField {
  return (OPEN_METEO_HOURLY_FIELDS as readonly string[]).includes(value);
}

function validateSettings(settings: OpenMeteoSettings): void {
  if (
    settings.data_id !== OPEN_METEO_DATA_ID ||
    settings.access_id !== OPEN_METEO_ACCESS_ID
  ) {
    throw new RangeError("Open-Meteo data and access IDs are fixed");
  }
  if (settings.endpoint !== OFFICIAL_API_ENDPOINT) {
    throw new RangeError("Open-Meteo endpoint must be the official forecast endpoint");
  }
  if (settings.model !== SUPPORTED_MODEL) {
    throw new RangeError(`Open-Meteo model must be ${SUPPORTED_MODEL}`);
  }
  requirePositiveInteger(settings.horizon_days, "horizon_days");
  if (settings.horizon_days > 15) {
    throw new RangeError("horizon_days must not exceed 15");
  }
  requirePositiveInteger(settings.max_fields, "max_fields");
  if (settings.max_fields > ABSOLUTE_MAX_FIELDS) {
    throw new RangeError(`max_fields must not exceed ${ABSOLUTE_MAX_FIELDS}`);
  }
  if (
    settings.allowed_hourly_fields.length === 0 ||
    new Set(settings.allowed_hourly_fields).size !==
      settings.allowed_hourly_fields.length ||
    settings.allowed_hourly_fields.some((field) => !isHourlyField(field))
  ) {
    throw new RangeError("allowed_hourly_fields is invalid");
  }
  if (
    settings.timezone !== "GMT" ||
    settings.timeformat !== "iso8601" ||
    settings.temperature_unit !== "celsius" ||
    settings.wind_speed_unit !== "kmh" ||
    settings.precipitation_unit !== "mm" ||
    settings.cell_selection !== "land"
  ) {
    throw new RangeError("Open-Meteo request settings are not supported");
  }
  const attribution = settings.attribution;
  if (
    attribution.provider.trim() === "" ||
    attribution.weather_model.trim() === "" ||
    attribution.licence.trim() === "" ||
    !isHttpsUrl(attribution.url)
  ) {
    throw new RangeError("Open-Meteo attribution is invalid");
  }
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

interface ParsedTimeRange {
  start: number;
  end: number;
  startHour: string;
  endHour: string;
}

function requireForecastRange(
  range: TimeRange | undefined,
  now: Date,
  horizonDays: number,
): ParsedTimeRange {
  if (!range) {
    throw new AppError("INVALID_REQUEST", "time_range is required.");
  }
  const start = parseUtcTimestamp(range.start, "time_range.start");
  const end = parseUtcTimestamp(range.end, "time_range.end");
  if (start % HOUR_MS !== 0 || end % HOUR_MS !== 0) {
    throw new AppError(
      "INVALID_REQUEST",
      "time_range bounds must align to whole UTC hours.",
    );
  }
  if (start > end) {
    throw new AppError("INVALID_REQUEST", "time_range.start must not be after time_range.end.");
  }
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const horizonEnd = today + horizonDays * DAY_MS;
  if (start < today || end >= horizonEnd) {
    throw new AppError(
      "INVALID_REQUEST",
      `time_range must stay within the current ${horizonDays}-day forecast window in UTC.`,
    );
  }
  return {
    start,
    end,
    startHour: range.start.slice(0, 16),
    endHour: range.end.slice(0, 16),
  };
}

function parseUtcTimestamp(value: string, field: string): number {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z$/u.test(value)) {
    throw new AppError("INVALID_REQUEST", `${field} must be an RFC 3339 UTC timestamp.`);
  }
  const timestamp = Date.parse(value);
  if (
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString().slice(0, 16) !== value.slice(0, 16)
  ) {
    throw new AppError("INVALID_REQUEST", `${field} must be a valid UTC timestamp.`);
  }
  return timestamp;
}

function buildForecastUrl(
  point: SpatialPoint,
  fields: readonly OpenMeteoHourlyField[],
  range: ParsedTimeRange,
  settings: OpenMeteoSettings,
): string {
  const url = new URL(settings.endpoint);
  url.searchParams.set("latitude", String(point.latitude));
  url.searchParams.set("longitude", String(point.longitude));
  url.searchParams.set("hourly", fields.join(","));
  url.searchParams.set("models", settings.model);
  url.searchParams.set("timezone", settings.timezone);
  url.searchParams.set("timeformat", settings.timeformat);
  url.searchParams.set("temperature_unit", settings.temperature_unit);
  url.searchParams.set("wind_speed_unit", settings.wind_speed_unit);
  url.searchParams.set("precipitation_unit", settings.precipitation_unit);
  url.searchParams.set("cell_selection", settings.cell_selection);
  url.searchParams.set("start_hour", range.startHour);
  url.searchParams.set("end_hour", range.endHour);
  return url.toString();
}

function normalizeForecast(
  value: unknown,
  fields: readonly OpenMeteoHourlyField[],
  requestedPoint: SpatialPoint,
  range: ParsedTimeRange,
  settings: OpenMeteoSettings,
): ForecastData {
  const record = requireRecord(value);
  const resolvedLatitude = requireFiniteNumber(record.latitude);
  const resolvedLongitude = requireFiniteNumber(record.longitude);
  const hourly = requireRecord(record.hourly);
  const hourlyUnits = requireRecord(record.hourly_units);
  const times = requireArray(hourly.time);
  const units: Record<string, string> = { timestamp: requireString(hourlyUnits.time) };
  const valuesByField = new Map<OpenMeteoHourlyField, readonly unknown[]>();

  for (const field of fields) {
    const values = requireArray(hourly[field]);
    if (values.length !== times.length) {
      throw new AppError("UPSTREAM_ERROR");
    }
    for (const item of values) {
      if (item !== null && (typeof item !== "number" || !Number.isFinite(item))) {
        throw new AppError("UPSTREAM_ERROR");
      }
    }
    units[field] = requireString(hourlyUnits[field]);
    valuesByField.set(field, values);
  }

  const rows: ForecastRow[] = [];
  for (let index = 0; index < times.length; index += 1) {
    const timestamp = normalizeUpstreamTimestamp(requireString(times[index]));
    const time = Date.parse(timestamp);
    if (!Number.isFinite(time)) {
      throw new AppError("UPSTREAM_ERROR");
    }
    if (time < range.start || time > range.end) {
      continue;
    }
    const row: ForecastRow = { timestamp };
    for (const field of fields) {
      row[field] = valuesByField.get(field)![index] as number | null;
    }
    rows.push(row);
  }

  return {
    rows,
    units,
    requested_coordinates: {
      latitude: requestedPoint.latitude,
      longitude: requestedPoint.longitude,
    },
    resolved_coordinates: {
      latitude: resolvedLatitude,
      longitude: resolvedLongitude,
    },
    data_kind: "model_forecast",
    observation: false,
    authoritative: false,
    model_id: settings.model,
    snapshot_stable: false,
    attribution: settings.attribution,
  };
}

function normalizeUpstreamTimestamp(value: string): string {
  if (/Z$/u.test(value)) {
    return value;
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/u.test(value)) {
    return `${value}Z`;
  }
  throw new AppError("UPSTREAM_ERROR");
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AppError("UPSTREAM_ERROR");
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new AppError("UPSTREAM_ERROR");
  }
  return value;
}

function requireString(value: unknown): string {
  if (typeof value !== "string" || value === "") {
    throw new AppError("UPSTREAM_ERROR");
  }
  return value;
}

function requireFiniteNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new AppError("UPSTREAM_ERROR");
  }
  return value;
}

function requirePositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
