import { AppError } from "../../errors";
import type { QueryDataResult } from "../../models";
import type { QueryDataInput } from "../provider";
import {
  abortable,
  cancelBody,
  contentLengthExceeds,
  enforceSerializedSize,
} from "../../resources/limits";
import { parseForecastXml } from "./xml";

export const MET_EIREANN_FORECAST_DATA_ID =
  "fa9574c1-48f4-4a98-a22b-d1c23c433821";
export const MET_EIREANN_FORECAST_ACCESS_ID = "point_forecast";
export const MET_EIREANN_FORECAST_ENDPOINT =
  "http://openaccess.pf.api.met.ie/metno-wdb2ts/locationforecast";

export const MET_EIREANN_FORECAST_LICENCE_NOTICE =
  "Public websites displaying this forecast data must also display Met Éireann weather warnings and acknowledge Met Éireann as the source.";

export const MET_EIREANN_FORECAST_FIELDS = [
  "cloudiness",
  "dewpointTemperature",
  "globalRadiation",
  "highClouds",
  "humidity",
  "lowClouds",
  "mediumClouds",
  "precipitation",
  "pressure",
  "symbol",
  "temperature",
  "windDirection",
  "windGust",
  "windSpeed",
] as const;

export interface ForecastBounds {
  minLatitude: number;
  maxLatitude: number;
  minLongitude: number;
  maxLongitude: number;
}

export interface MetEireannForecastSettings {
  endpoint: string;
  timeoutMs: number;
  maxInputBytes: number;
  maxOutputBytes: number;
  defaultLimit: number;
  maxLimit: number;
  bounds: ForecastBounds;
}

export type MetEireannForecastOverrides = Partial<
  Omit<MetEireannForecastSettings, "bounds">
> & {
  bounds?: Partial<ForecastBounds>;
};

export interface MetEireannForecastDependencies {
  fetcher: typeof fetch;
  now: () => Date;
}

const DEFAULT_BOUNDS: ForecastBounds = {
  minLatitude: 51.3,
  maxLatitude: 55.5,
  minLongitude: -11,
  maxLongitude: -5.2,
};

export function defaultForecastSettings(input: {
  timeoutMs: number;
  maxInputBytes: number;
  maxOutputBytes: number;
  defaultLimit: number;
  maxLimit: number;
}): MetEireannForecastSettings {
  return {
    endpoint: MET_EIREANN_FORECAST_ENDPOINT,
    timeoutMs: input.timeoutMs,
    maxInputBytes: input.maxInputBytes,
    maxOutputBytes: input.maxOutputBytes,
    defaultLimit: input.defaultLimit,
    maxLimit: input.maxLimit,
    bounds: { ...DEFAULT_BOUNDS },
  };
}

export class MetEireannForecastClient {
  private readonly fetcher: typeof fetch;

  constructor(
    private readonly settings: MetEireannForecastSettings,
    dependencies: MetEireannForecastDependencies,
  ) {
    validateSettings(settings);
    this.fetcher = (input, init) => dependencies.fetcher(input, init);
    this.now = dependencies.now;
  }

  private readonly now: () => Date;

  get endpoint(): string {
    return this.settings.endpoint;
  }

  async query(input: QueryDataInput): Promise<QueryDataResult> {
    const point = validateQuery(input, this.settings.bounds);
    const { limit, offset } = pagination(
      input,
      this.settings.defaultLimit,
      this.settings.maxLimit,
    );
    const url = forecastUrl(this.settings.endpoint, point, input.time_range);
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.settings.timeoutMs,
    );

    try {
      const response = await abortable(
        this.fetcher(url, {
          headers: { accept: "application/xml, text/xml;q=0.9" },
          signal: controller.signal,
        }),
        controller.signal,
      );

      if (response.status === 429) {
        cancelBody(response.body);
        throw new AppError("RATE_LIMITED");
      }
      if (response.status === 400 || response.status === 422) {
        cancelBody(response.body);
        throw new AppError(
          "INVALID_REQUEST",
          "Met Éireann rejected the forecast query parameters.",
        );
      }
      if (!response.ok) {
        cancelBody(response.body);
        throw new AppError("UPSTREAM_ERROR");
      }

      const contentType = response.headers.get("content-type")?.toLowerCase();
      if (!contentType?.includes("xml")) {
        cancelBody(response.body);
        throw new AppError("UPSTREAM_ERROR");
      }

      const xml = await readBoundedText(
        response,
        this.settings.maxInputBytes,
        controller.signal,
      );
      const parsed = parseForecastXml(xml, input.fields);
      const selected = parsed.blocks.slice(offset, offset + limit);
      const data = {
        metadata: parsed.metadata,
        product_attributes: parsed.productAttributes,
        instant_blocks: selected.filter((block) => block.kind === "instant"),
        interval_blocks: selected.filter((block) => block.kind === "interval"),
        licence_notice: MET_EIREANN_FORECAST_LICENCE_NOTICE,
      };
      const result: QueryDataResult = {
        data_id: MET_EIREANN_FORECAST_DATA_ID,
        access_id: MET_EIREANN_FORECAST_ACCESS_ID,
        data,
        provenance: {
          source: "met_eireann",
          upstream_url: url,
          retrieved_at: this.now().toISOString(),
          original_format: "xml",
        },
        pagination_supported: true,
        pagination: {
          limit,
          offset,
          returned: selected.length,
          total: parsed.blocks.length,
        },
      };
      enforceSerializedSize(result, this.settings.maxOutputBytes);
      return result;
    } catch (error) {
      if (
        controller.signal.aborted ||
        (error instanceof Error && error.name === "AbortError")
      ) {
        throw new AppError("UPSTREAM_TIMEOUT");
      }
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError("UPSTREAM_ERROR");
    } finally {
      clearTimeout(timeout);
    }
  }
}

function validateQuery(
  input: QueryDataInput,
  bounds: ForecastBounds,
): { latitude: number; longitude: number } {
  if (input.filters !== undefined) {
    throw new AppError(
      "INVALID_REQUEST",
      'The "filters" selector is not supported for Met Éireann forecasts.',
    );
  }
  const point = input.spatial;
  if (!point) {
    throw new AppError(
      "INVALID_REQUEST",
      'The "spatial" point is required for a Met Éireann point forecast.',
    );
  }
  if (
    point.type !== "point" ||
    !Number.isFinite(point.latitude) ||
    !Number.isFinite(point.longitude) ||
    point.latitude < bounds.minLatitude ||
    point.latitude > bounds.maxLatitude ||
    point.longitude < bounds.minLongitude ||
    point.longitude > bounds.maxLongitude
  ) {
    throw new AppError(
      "INVALID_REQUEST",
      'The "spatial" point must be within the configured forecast model bounds.',
    );
  }

  if (input.fields) {
    if (
      input.fields.length === 0 ||
      input.fields.length > 10 ||
      new Set(input.fields).size !== input.fields.length ||
      input.fields.some(
        (field) =>
          typeof field !== "string" ||
          !MET_EIREANN_FORECAST_FIELDS.includes(
            field as (typeof MET_EIREANN_FORECAST_FIELDS)[number],
          ),
      )
    ) {
      throw new AppError(
        "INVALID_REQUEST",
        'The "fields" values must be unique supported forecast element names.',
      );
    }
  }

  if (input.time_range) {
    const { start, end } = input.time_range;
    if (
      !isUtcTimestamp(start) ||
      !isUtcTimestamp(end) ||
      Date.parse(end) <= Date.parse(start)
    ) {
      throw new AppError(
        "INVALID_REQUEST",
        'The "time_range" must contain increasing UTC timestamps.',
      );
    }
  }

  return { latitude: point.latitude, longitude: point.longitude };
}

function pagination(
  input: QueryDataInput,
  defaultLimit: number,
  maxLimit: number,
): { limit: number; offset: number } {
  const limit = input.limit ?? defaultLimit;
  const offset = input.offset ?? 0;
  if (
    !Number.isInteger(limit) ||
    limit <= 0 ||
    limit > maxLimit ||
    !Number.isInteger(offset) ||
    offset < 0
  ) {
    throw new AppError("INVALID_REQUEST");
  }
  return { limit, offset };
}

function forecastUrl(
  endpoint: string,
  point: { latitude: number; longitude: number },
  timeRange: QueryDataInput["time_range"],
): string {
  const parameters = [
    `lat=${encodeURIComponent(String(point.latitude))}`,
    `long=${encodeURIComponent(String(point.longitude))}`,
  ];
  if (timeRange) {
    parameters.push(`from=${encodeURIComponent(upstreamTimestamp(timeRange.start))}`);
    parameters.push(`to=${encodeURIComponent(upstreamTimestamp(timeRange.end))}`);
  }
  return `${endpoint}?${parameters.join(";")}`;
}

function upstreamTimestamp(value: string): string {
  return new Date(value).toISOString().slice(0, 16);
}

function isUtcTimestamp(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) {
    return false;
  }
  const parsed = new Date(value);
  return (
    Number.isFinite(parsed.getTime()) &&
    `${parsed.toISOString().slice(0, 19)}Z` === `${value.slice(0, 19)}Z`
  );
}

function validateSettings(settings: MetEireannForecastSettings): void {
  let endpoint: URL;
  try {
    endpoint = new URL(settings.endpoint);
  } catch {
    throw new TypeError("Forecast endpoint must be an absolute URL");
  }
  if (
    (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.search !== "" ||
    endpoint.hash !== ""
  ) {
    throw new TypeError("Forecast endpoint is invalid");
  }
  requirePositiveInteger(settings.timeoutMs, "timeoutMs");
  requirePositiveInteger(settings.maxInputBytes, "maxInputBytes");
  requirePositiveInteger(settings.maxOutputBytes, "maxOutputBytes");
  requirePositiveInteger(settings.defaultLimit, "defaultLimit");
  requirePositiveInteger(settings.maxLimit, "maxLimit");
  if (settings.defaultLimit > settings.maxLimit) {
    throw new RangeError("defaultLimit must not exceed maxLimit");
  }
  const { bounds } = settings;
  if (
    !Number.isFinite(bounds.minLatitude) ||
    !Number.isFinite(bounds.maxLatitude) ||
    !Number.isFinite(bounds.minLongitude) ||
    !Number.isFinite(bounds.maxLongitude) ||
    bounds.minLatitude < -90 ||
    bounds.maxLatitude > 90 ||
    bounds.minLongitude < -180 ||
    bounds.maxLongitude > 180 ||
    bounds.minLatitude >= bounds.maxLatitude ||
    bounds.minLongitude >= bounds.maxLongitude
  ) {
    throw new TypeError("Forecast bounds are invalid");
  }
}

function requirePositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
}

async function readBoundedText(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<string> {
  if (contentLengthExceeds(response, maxBytes)) {
    cancelBody(response.body);
    throw new AppError("RESOURCE_TOO_LARGE");
  }
  const reader = response.body?.getReader();
  if (!reader) {
    throw new AppError("UPSTREAM_ERROR");
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await abortable(reader.read(), signal);
      if (chunk.done) {
        reader.releaseLock();
        text += decoder.decode();
        return text;
      }
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) {
        void reader.cancel().catch(() => undefined);
        throw new AppError("RESOURCE_TOO_LARGE");
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  }
}
