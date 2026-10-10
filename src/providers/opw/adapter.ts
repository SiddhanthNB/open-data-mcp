import { AppError, type ErrorCode } from "../../errors";
import type {
  AccessPoint,
  DataDescription,
  DataLink,
  DataSearchResult,
  DataSummary,
  QueryDataResult,
  Source,
} from "../../models";
import {
  abortable,
  cancelBody,
  contentLengthExceeds,
  enforceSerializedSize,
  readBoundedJsonResponse,
} from "../../resources/limits";
import type {
  DescribeDataInput,
  GetDataLinkInput,
  QueryDataInput,
  SearchDataInput,
} from "../provider";

export const OPW_SOURCE_ID = "opw";
export const OPW_ORIGIN = "https://waterlevel.ie";
export const OPW_STATIONS_ENDPOINT = `${OPW_ORIGIN}/geojson/`;
export const OPW_LATEST_ENDPOINT = `${OPW_ORIGIN}/geojson/latest/`;
export const OPW_DATA_BASE_URL = `${OPW_ORIGIN}/data/`;

// Removed when the shared Source union gains OPW during integration.
const OPW_SOURCE = OPW_SOURCE_ID as Source;

export type OpwAccessId =
  | "water_level"
  | "ordnance_datum"
  | "temperature"
  | "battery_voltage"
  | "backup_water_level";

export interface OpwSensorSetting {
  accessId: OpwAccessId;
  code: "0001" | "OD" | "0002" | "0003" | "0011";
  title: string;
  unit: "m" | "°C" | "V";
  valueColumn: "value" | "backup_value";
  caveat: string;
}

export const OPW_SENSORS: readonly OpwSensorSetting[] = [
  {
    accessId: "water_level",
    code: "0001",
    title: "Water level",
    unit: "m",
    valueColumn: "value",
    caveat: "Stage above the station staff-gauge zero.",
  },
  {
    accessId: "ordnance_datum",
    code: "OD",
    title: "Water level to ordnance datum",
    unit: "m",
    valueColumn: "value",
    caveat: "The datum may be Poolbeg or Malin; check the official station page.",
  },
  {
    accessId: "temperature",
    code: "0002",
    title: "Temperature",
    unit: "°C",
    valueColumn: "value",
    caveat:
      "Sensor heating can be significant in warm weather; this may not represent waterbody temperature.",
  },
  {
    accessId: "battery_voltage",
    code: "0003",
    title: "Battery voltage",
    unit: "V",
    valueColumn: "value",
    caveat: "Operational station battery reading.",
  },
  {
    accessId: "backup_water_level",
    code: "0011",
    title: "Backup water level",
    unit: "m",
    valueColumn: "backup_value",
    caveat:
      "Backup stream; since 2025-11-18 the file can also contain the main-sensor value.",
  },
] as const;

export interface OpwSettings {
  stationsEndpoint: typeof OPW_STATIONS_ENDPOINT;
  latestEndpoint: typeof OPW_LATEST_ENDPOINT;
  dataBaseUrl: typeof OPW_DATA_BASE_URL;
  stationBaseUrl: typeof OPW_ORIGIN;
  sensors: readonly OpwSensorSetting[];
  rollingWindowDays: 35;
  cacheTtlSeconds: 900;
  timeoutMs: number;
  maxInputBytes: number;
  maxOutputBytes: number;
  defaultLimit: number;
  maxLimit: number;
}

export interface OpwDependencies {
  fetch?: typeof fetch;
  now?: () => Date;
}

interface Station {
  dataId: string;
  reference: string;
  name: string;
  longitude: number;
  latitude: number;
}

interface Reading {
  station: Station;
  sensorCode: string;
}

interface CsvRow {
  datetime: string;
  value: number;
}

const LICENCE = "Creative Commons Attribution 4.0 International (CC BY 4.0)";
const ATTRIBUTION =
  "Contains Irish Public Sector Information licensed under a Creative Commons Attribution 4.0 International (CC BY 4.0) licence (source waterlevel.ie - provided by the Office of Public Works).";
const DISCLAIMER =
  "Realtime data is provisional, unchecked and unvalidated; it may be inaccurate, delayed or incomplete and must be independently verified for its intended use.";

export class OpwAdapter {
  readonly config: OpwSettings;

  private readonly fetcher: typeof fetch;
  private readonly now: () => Date;
  private readonly sensorsByAccess: ReadonlyMap<OpwAccessId, OpwSensorSetting>;
  private readonly sensorsByCode: ReadonlyMap<string, OpwSensorSetting>;

  constructor(settings: OpwSettings, dependencies: OpwDependencies = {}) {
    validateSettings(settings);
    this.config = settings;
    this.fetcher = dependencies.fetch ?? fetch;
    this.now = dependencies.now ?? (() => new Date());
    this.sensorsByAccess = new Map(
      settings.sensors.map((sensor) => [sensor.accessId, sensor]),
    );
    this.sensorsByCode = new Map(
      settings.sensors.map((sensor) => [sensor.code, sensor]),
    );
  }

  async searchData(input: SearchDataInput): Promise<DataSearchResult> {
    const { limit, offset } = this.pagination(input.limit, input.offset);
    const stations = await this.readStations();
    const query = input.query?.trim().toLocaleLowerCase("en-IE") ?? "";
    const matches = stations.filter(
      (station) =>
        query === "" ||
        station.dataId.includes(query) ||
        station.name.toLocaleLowerCase("en-IE").includes(query),
    );
    const results = matches
      .slice(offset, offset + limit)
      .map((station) => this.summary(station));
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
    const station = await this.requireStation(input.data_id);
    const available = await this.availableSensors(station.dataId);
    return this.bounded({
      ...this.summary(station),
      description: `${station.name} realtime monitoring station. ${DISCLAIMER}`,
      licence: `${LICENCE}. ${ATTRIBUTION} ${DISCLAIMER}`,
      access_points: available.map((sensor) => this.accessPoint(station, sensor)),
    });
  }

  async queryData(input: QueryDataInput): Promise<QueryDataResult> {
    rejectUnsupportedSelectors(input);
    const { limit, offset } = this.pagination(input.limit, input.offset);
    const dataId = normalizeInputDataId(input.data_id);
    const sensor = this.requireConfiguredSensor(input.access_id);
    const range = this.timeRange(input.time_range);
    const station = await this.requireStation(dataId);
    await this.requireAvailableSensor(station.dataId, sensor);
    const period = selectPeriod(range.start, this.now().getTime());
    const url = this.dataUrl(period, station.dataId, sensor.code);
    const text = await this.requestText(url, "RESOURCE_NOT_FOUND", "csv");
    const rows = parseCsv(text, sensor)
      .filter((row) => {
        const timestamp = Date.parse(row.datetime);
        return timestamp >= range.start && timestamp <= range.end;
      });
    const page = rows.slice(offset, offset + limit);
    return this.bounded({
      data_id: station.dataId,
      access_id: sensor.accessId,
      data: { rows: page },
      provenance: {
        source: OPW_SOURCE,
        upstream_url: url,
        retrieved_at: this.now().toISOString(),
        original_format: "csv",
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
    const dataId = normalizeInputDataId(input.data_id);
    const sensor = this.requireConfiguredSensor(input.access_id);
    const station = await this.requireStation(dataId);
    await this.requireAvailableSensor(station.dataId, sensor);
    const url = this.dataUrl("month", station.dataId, sensor.code);
    return this.bounded({
      data_id: station.dataId,
      access_id: sensor.accessId,
      url,
      format: "csv",
      title: `${station.name} — ${sensor.title}`,
      description: `${sensor.caveat} ${DISCLAIMER}`,
      provenance: {
        source: OPW_SOURCE,
        upstream_url: url,
        retrieved_at: this.now().toISOString(),
        original_format: "csv",
      },
    });
  }

  private summary(station: Station): DataSummary {
    return {
      data_id: station.dataId,
      title: station.name,
      description: `Realtime OPW monitoring station at ${station.latitude}, ${station.longitude}.`,
      publisher: "Office of Public Works",
      available_formats: ["csv"],
      provenance: {
        source: OPW_SOURCE,
        upstream_url: this.stationUrl(station),
        retrieved_at: this.now().toISOString(),
      },
    };
  }

  private accessPoint(station: Station, sensor: OpwSensorSetting): AccessPoint {
    return {
      access_id: sensor.accessId,
      title: sensor.title,
      description: `${sensor.caveat} Unit: ${sensor.unit}. ${DISCLAIMER}`,
      format: "csv",
      capabilities: { query: true, link: true },
      query_schema: {
        fields: [
          { name: "datetime", type: "datetime", operators: [] },
          { name: "value", type: "number", operators: [] },
        ],
        truncated: false,
      },
      upstream_url: this.dataUrl("month", station.dataId, sensor.code),
    };
  }

  private async requireStation(dataId: string): Promise<Station> {
    const normalized = normalizeInputDataId(dataId);
    const station = (await this.readStations()).find(
      (candidate) => candidate.dataId === normalized,
    );
    if (!station) {
      throw new AppError("DATASET_NOT_FOUND");
    }
    return station;
  }

  private async availableSensors(dataId: string): Promise<readonly OpwSensorSetting[]> {
    const readings = await this.readLatest();
    const codes = new Set(
      readings
        .filter((reading) => reading.station.dataId === dataId)
        .map((reading) => reading.sensorCode),
    );
    return this.config.sensors.filter((sensor) => codes.has(sensor.code));
  }

  private requireConfiguredSensor(accessId: string): OpwSensorSetting {
    const sensor = this.sensorsByAccess.get(accessId as OpwAccessId);
    if (!sensor) {
      throw new AppError("RESOURCE_NOT_FOUND");
    }
    return sensor;
  }

  private async requireAvailableSensor(
    dataId: string,
    sensor: OpwSensorSetting,
  ): Promise<void> {
    const available = await this.availableSensors(dataId);
    if (!available.some((candidate) => candidate.accessId === sensor.accessId)) {
      throw new AppError("RESOURCE_NOT_FOUND");
    }
  }

  private async readStations(): Promise<readonly Station[]> {
    const body = await this.requestJson(this.config.stationsEndpoint);
    return parseStations(body);
  }

  private async readLatest(): Promise<readonly Reading[]> {
    const body = await this.requestJson(this.config.latestEndpoint);
    return parseLatest(body, this.sensorsByCode);
  }

  private async requestJson(url: string): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const response = await this.fetchResponse(
        url,
        "application/json, application/geo+json",
        controller,
      );
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (
        contentType !== "" &&
        !contentType.includes("application/json") &&
        !contentType.includes("application/geo+json")
      ) {
        cancelBody(response.body);
        throw new AppError("UPSTREAM_ERROR");
      }
      return await readBoundedJsonResponse(
        response,
        this.config.maxInputBytes,
        controller.signal,
      );
    } catch (error) {
      throw requestError(error, controller.signal);
    } finally {
      clearTimeout(timeout);
    }
  }

  private async requestText(
    url: string,
    notFoundCode: ErrorCode,
    expected: "csv",
  ): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const response = await this.fetchResponse(
        url,
        "text/csv",
        controller,
        notFoundCode,
      );
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (
        expected === "csv" &&
        contentType !== "" &&
        !contentType.includes("text/csv") &&
        !contentType.includes("application/csv") &&
        !contentType.includes("text/plain")
      ) {
        cancelBody(response.body);
        throw new AppError("UPSTREAM_ERROR");
      }
      return await readBoundedText(
        response,
        this.config.maxInputBytes,
        controller.signal,
      );
    } catch (error) {
      throw requestError(error, controller.signal);
    } finally {
      clearTimeout(timeout);
    }
  }

  private async fetchResponse(
    url: string,
    accept: string,
    controller: AbortController,
    notFoundCode?: ErrorCode,
  ): Promise<Response> {
    const response = await abortable(
      this.fetcher(url, {
        headers: { accept },
        redirect: "error",
        signal: controller.signal,
        cf: { cacheEverything: true, cacheTtl: this.config.cacheTtlSeconds },
      }),
      controller.signal,
    );
    if (response.status === 429) {
      cancelBody(response.body);
      throw new AppError("RATE_LIMITED");
    }
    if (response.status === 404 && notFoundCode) {
      cancelBody(response.body);
      throw new AppError(notFoundCode);
    }
    if (!response.ok) {
      cancelBody(response.body);
      throw new AppError("UPSTREAM_ERROR");
    }
    return response;
  }

  private timeRange(value: QueryDataInput["time_range"]): {
    start: number;
    end: number;
  } {
    if (!value) {
      throw new AppError("INVALID_REQUEST", "time_range is required for OPW data.");
    }
    const start = utcTimestamp(value.start);
    const end = utcTimestamp(value.end);
    const now = this.now().getTime();
    const oldest = now - this.config.rollingWindowDays * 86_400_000;
    if (end <= start) {
      throw new AppError("INVALID_REQUEST", "time_range must be increasing.");
    }
    if (start < oldest || end > now) {
      throw new AppError(
        "INVALID_REQUEST",
        `time_range must be within the rolling ${this.config.rollingWindowDays}-day window.`,
      );
    }
    return { start, end };
  }

  private pagination(
    requestedLimit: number | undefined,
    requestedOffset: number | undefined,
  ): { limit: number; offset: number } {
    const limit = requestedLimit ?? this.config.defaultLimit;
    const offset = requestedOffset ?? 0;
    if (
      !Number.isSafeInteger(limit) ||
      limit <= 0 ||
      limit > this.config.maxLimit ||
      !Number.isSafeInteger(offset) ||
      offset < 0
    ) {
      throw new AppError("INVALID_REQUEST");
    }
    return { limit, offset };
  }

  private dataUrl(
    period: "day" | "week" | "month",
    dataId: string,
    sensorCode: OpwSensorSetting["code"],
  ): string {
    return `${this.config.dataBaseUrl}${period}/${dataId}_${sensorCode}.csv`;
  }

  private stationUrl(station: Station): string {
    return `${this.config.stationBaseUrl}/${station.reference}/`;
  }

  private bounded<T>(value: T): T {
    enforceSerializedSize(value, this.config.maxOutputBytes);
    return value;
  }
}

function validateSettings(settings: OpwSettings): void {
  if (
    settings.stationsEndpoint !== OPW_STATIONS_ENDPOINT ||
    settings.latestEndpoint !== OPW_LATEST_ENDPOINT ||
    settings.dataBaseUrl !== OPW_DATA_BASE_URL ||
    settings.stationBaseUrl !== OPW_ORIGIN
  ) {
    throw new RangeError("OPW endpoints must use the official HTTPS URLs");
  }
  if (settings.rollingWindowDays !== 35 || settings.cacheTtlSeconds !== 900) {
    throw new RangeError("OPW window and shared-cache TTL must be 35 days and 900 seconds");
  }
  for (const [name, value] of Object.entries({
    timeoutMs: settings.timeoutMs,
    maxInputBytes: settings.maxInputBytes,
    maxOutputBytes: settings.maxOutputBytes,
    defaultLimit: settings.defaultLimit,
    maxLimit: settings.maxLimit,
  })) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new RangeError(`${name} must be a positive integer`);
    }
  }
  if (settings.maxLimit > 100 || settings.defaultLimit > settings.maxLimit) {
    throw new RangeError("OPW pagination limits are invalid");
  }
  if (settings.sensors.length !== OPW_SENSORS.length) {
    throw new RangeError("OPW sensor configuration must contain the documented sensor set");
  }
  for (const expected of OPW_SENSORS) {
    const actual = settings.sensors.find(
      (sensor) => sensor.accessId === expected.accessId,
    );
    if (
      !actual ||
      actual.code !== expected.code ||
      actual.unit !== expected.unit ||
      actual.valueColumn !== expected.valueColumn
    ) {
      throw new RangeError("OPW sensor configuration must use documented IDs and codes");
    }
  }
}

function parseStations(value: unknown): readonly Station[] {
  const features = featureCollection(value);
  const stations = new Map<string, Station>();
  for (const featureValue of features) {
    const feature = recordValue(featureValue);
    const properties = recordValue(feature.properties);
    const station = parseStation(
      properties.ref,
      properties.name,
      feature.geometry,
    );
    if (!station) {
      continue;
    }
    if (stations.has(station.dataId)) {
      throw new AppError("UPSTREAM_ERROR");
    }
    stations.set(station.dataId, station);
  }
  return [...stations.values()].sort((left, right) =>
    left.dataId.localeCompare(right.dataId),
  );
}

function parseLatest(
  value: unknown,
  sensors: ReadonlyMap<string, OpwSensorSetting>,
): readonly Reading[] {
  const features = featureCollection(value);
  const readings: Reading[] = [];
  const seen = new Set<string>();
  for (const featureValue of features) {
    const feature = recordValue(featureValue);
    const properties = recordValue(feature.properties);
    const station = parseStation(
      properties.station_ref,
      properties.station_name,
      feature.geometry,
    );
    const sensorCode = stringValue(properties.sensor_ref);
    if (!station || !sensorCode || !sensors.has(sensorCode)) {
      continue;
    }
    const key = `${station.dataId}:${sensorCode}`;
    if (!seen.has(key)) {
      readings.push({ station, sensorCode });
      seen.add(key);
    }
  }
  return readings;
}

function featureCollection(value: unknown): readonly unknown[] {
  const body = recordValue(value);
  if (body.type !== "FeatureCollection" || !Array.isArray(body.features)) {
    throw new AppError("UPSTREAM_ERROR");
  }
  return body.features;
}

function parseStation(
  referenceValue: unknown,
  nameValue: unknown,
  geometryValue: unknown,
): Station | undefined {
  const reference = stringValue(referenceValue);
  const name = stringValue(nameValue)?.trim();
  if (!reference || !name || !/^\d{5,10}$/u.test(reference)) {
    return undefined;
  }
  const number = Number(reference);
  if (!Number.isSafeInteger(number) || number < 1 || number > 41_000) {
    return undefined;
  }
  const geometry = recordValue(geometryValue);
  if (
    geometry.type !== "Point" ||
    !Array.isArray(geometry.coordinates) ||
    geometry.coordinates.length < 2
  ) {
    throw new AppError("UPSTREAM_ERROR");
  }
  const longitude = geometry.coordinates[0];
  const latitude = geometry.coordinates[1];
  if (
    typeof longitude !== "number" ||
    !Number.isFinite(longitude) ||
    typeof latitude !== "number" ||
    !Number.isFinite(latitude) ||
    longitude < -180 ||
    longitude > 180 ||
    latitude < -90 ||
    latitude > 90
  ) {
    throw new AppError("UPSTREAM_ERROR");
  }
  return {
    dataId: String(number).padStart(5, "0"),
    reference: String(number).padStart(10, "0"),
    name,
    longitude,
    latitude,
  };
}

function parseCsv(text: string, sensor: OpwSensorSetting): readonly CsvRow[] {
  const table = csvTable(text);
  if (table.length < 1) {
    throw new AppError("UPSTREAM_ERROR");
  }
  const header = table[0]!.map((value) => value.trim().toLowerCase());
  const datetimeIndex = header.indexOf("datetime");
  const valueIndex = header.indexOf(sensor.valueColumn);
  if (
    datetimeIndex < 0 ||
    valueIndex < 0 ||
    new Set(header).size !== header.length
  ) {
    throw new AppError("UPSTREAM_ERROR");
  }
  return table.slice(1).map((fields) => {
    if (fields.length !== header.length) {
      throw new AppError("UPSTREAM_ERROR");
    }
    const datetime = csvUtcTimestamp(fields[datetimeIndex]!);
    const value = Number(fields[valueIndex]!.trim());
    if (!Number.isFinite(value) || fields[valueIndex]!.trim() === "") {
      throw new AppError("UPSTREAM_ERROR");
    }
    return { datetime, value };
  });
}

function csvTable(text: string): string[][] {
  const normalized = text.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let justClosedQuote = false;
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index]!;
    if (quoted) {
      if (character === '"') {
        if (normalized[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
          justClosedQuote = true;
        }
      } else {
        field += character;
      }
      continue;
    }
    if (justClosedQuote && character !== "," && character !== "\n") {
      throw new AppError("UPSTREAM_ERROR");
    }
    if (character === '"') {
      if (field !== "") {
        throw new AppError("UPSTREAM_ERROR");
      }
      quoted = true;
      justClosedQuote = false;
    } else if (character === ",") {
      row.push(field);
      field = "";
      justClosedQuote = false;
    } else if (character === "\n") {
      row.push(field);
      if (!(row.length === 1 && row[0] === "")) {
        rows.push(row);
      }
      row = [];
      field = "";
      justClosedQuote = false;
    } else {
      field += character;
    }
  }
  if (quoted) {
    throw new AppError("UPSTREAM_ERROR");
  }
  row.push(field);
  if (!(row.length === 1 && row[0] === "")) {
    rows.push(row);
  }
  return rows;
}

function csvUtcTimestamp(value: string): string {
  const trimmed = value.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?Z?$/u.exec(
    trimmed,
  );
  if (!match) {
    throw new AppError("UPSTREAM_ERROR");
  }
  const iso = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6] ?? "00"}.000Z`;
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== iso) {
    throw new AppError("UPSTREAM_ERROR");
  }
  return iso;
}

function normalizeInputDataId(value: string): string {
  if (!/^\d{5}$/u.test(value)) {
    throw new AppError("DATASET_NOT_FOUND");
  }
  const number = Number(value);
  if (number < 1 || number > 41_000) {
    throw new AppError("DATASET_NOT_FOUND");
  }
  return value;
}

function utcTimestamp(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(value)) {
    throw new AppError("INVALID_REQUEST", "time_range must use UTC timestamps.");
  }
  const parsed = Date.parse(value);
  if (
    !Number.isFinite(parsed) ||
    `${new Date(parsed).toISOString().slice(0, 19)}Z` !== `${value.slice(0, 19)}Z`
  ) {
    throw new AppError("INVALID_REQUEST", "time_range must use valid UTC timestamps.");
  }
  return parsed;
}

function selectPeriod(start: number, now: number): "day" | "week" | "month" {
  if (start >= now - 86_400_000) {
    return "day";
  }
  if (start >= now - 7 * 86_400_000) {
    return "week";
  }
  return "month";
}

function rejectUnsupportedSelectors(input: QueryDataInput): void {
  if (input.spatial || (input.filters && input.filters.length > 0)) {
    throw new AppError("UNSUPPORTED_OPERATION");
  }
  if (
    input.fields &&
    (input.fields.length !== 2 ||
      input.fields[0] !== "datetime" ||
      input.fields[1] !== "value")
  ) {
    throw new AppError(
      "INVALID_REQUEST",
      "OPW fields, when supplied, must be datetime and value.",
    );
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
    if (error instanceof TypeError) {
      throw new AppError("UPSTREAM_ERROR");
    }
    throw error;
  }
}

function recordValue(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AppError("UPSTREAM_ERROR");
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function isAbortError(value: unknown): boolean {
  return value instanceof Error && value.name === "AbortError";
}

function requestError(error: unknown, signal: AbortSignal): AppError {
  if (signal.aborted || isAbortError(error)) {
    return new AppError("UPSTREAM_TIMEOUT");
  }
  if (error instanceof AppError) {
    return error;
  }
  return new AppError("UPSTREAM_ERROR");
}
