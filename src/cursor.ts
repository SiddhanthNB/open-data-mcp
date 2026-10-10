import { AppError } from "./errors";
import {
  isSource,
  type QuerySelectors,
  type Source,
  type SpatialPoint,
  type TimeRange,
} from "./models";

const CURSOR_VERSION = 1;
export const MAX_CURSOR_LENGTH = 32_768;

interface SearchCursor {
  version: typeof CURSOR_VERSION;
  kind: "search";
  source: Source;
  query: string;
  offset: number;
}

interface QueryCursor {
  version: typeof CURSOR_VERSION;
  kind: "query";
  source: Source;
  data_id: string;
  access_id: string;
  offset: number;
  selectors: CursorSelectors;
}

interface CursorSelectors {
  fields: readonly string[] | null;
  spatial: SpatialPoint | null;
  time_range: TimeRange | null;
}

export function encodeSearchCursor(
  source: Source,
  query: string,
  offset: number,
): string {
  return encode({
    version: CURSOR_VERSION,
    kind: "search",
    source,
    query,
    offset,
  });
}

export function decodeSearchCursor(
  cursor: string | undefined,
  source: Source,
  query: string | undefined,
): { offset: number; query: string } {
  if (cursor === undefined) {
    return { offset: 0, query: query ?? "" };
  }

  const value = decode(cursor);
  if (
    !hasExactKeys(value, ["version", "kind", "source", "query", "offset"]) ||
    value.version !== CURSOR_VERSION ||
    value.kind !== "search" ||
    !isSourceValue(value.source) ||
    typeof value.query !== "string" ||
    !isOffset(value.offset) ||
    value.source !== source ||
    (query !== undefined && value.query !== query)
  ) {
    throw invalidCursor();
  }

  return { offset: value.offset, query: value.query };
}

export function encodeQueryCursor(
  source: Source,
  dataId: string,
  accessId: string,
  offset: number,
  selectors: QuerySelectors = {},
): string {
  return encode({
    version: CURSOR_VERSION,
    kind: "query",
    source,
    data_id: dataId,
    access_id: accessId,
    offset,
    selectors: toCursorSelectors(selectors),
  });
}

export function decodeQueryCursor(
  cursor: string | undefined,
  source: Source,
  dataId: string,
  accessId: string,
  selectors: QuerySelectors = {},
): { offset: number; selectors: QuerySelectors } {
  if (cursor === undefined) {
    return {
      offset: 0,
      selectors: fromCursorSelectors(toCursorSelectors(selectors)),
    };
  }

  const value = decode(cursor);
  if (
    !hasExactKeys(value, [
      "version",
      "kind",
      "source",
      "data_id",
      "access_id",
      "offset",
      "selectors",
    ]) ||
    value.version !== CURSOR_VERSION ||
    value.kind !== "query" ||
    !isSourceValue(value.source) ||
    typeof value.data_id !== "string" ||
    typeof value.access_id !== "string" ||
    !isOffset(value.offset) ||
    !isCursorSelectors(value.selectors) ||
    value.source !== source ||
    value.data_id !== dataId ||
    value.access_id !== accessId ||
    !requestedSelectorsMatch(value.selectors, selectors)
  ) {
    throw invalidCursor();
  }

  return {
    offset: value.offset,
    selectors: fromCursorSelectors(value.selectors),
  };
}

function encode(value: SearchCursor | QueryCursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decode(cursor: string): Record<string, unknown> {
  if (
    cursor.length === 0 ||
    cursor.length > MAX_CURSOR_LENGTH ||
    !/^[A-Za-z0-9_-]+$/.test(cursor)
  ) {
    throw invalidCursor();
  }

  try {
    const base64 = cursor.replaceAll("-", "+").replaceAll("_", "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );
    const value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw invalidCursor();
    }
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    throw invalidCursor();
  }
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}

function isSourceValue(value: unknown): value is Source {
  return typeof value === "string" && isSource(value);
}

function isOffset(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function toCursorSelectors(selectors: QuerySelectors): CursorSelectors {
  return {
    fields: selectors.fields ? [...selectors.fields] : null,
    spatial: selectors.spatial ? { ...selectors.spatial } : null,
    time_range: selectors.time_range
      ? {
          start: normalizeCursorTimestamp(selectors.time_range.start),
          end: normalizeCursorTimestamp(selectors.time_range.end),
        }
      : null,
  };
}

function normalizeCursorTimestamp(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : value;
}

function fromCursorSelectors(selectors: CursorSelectors): QuerySelectors {
  return {
    ...(selectors.fields ? { fields: selectors.fields } : {}),
    ...(selectors.spatial ? { spatial: selectors.spatial } : {}),
    ...(selectors.time_range ? { time_range: selectors.time_range } : {}),
  };
}

function requestedSelectorsMatch(
  cursorSelectors: CursorSelectors,
  requested: QuerySelectors,
): boolean {
  const normalized = toCursorSelectors(requested);
  return (
    (requested.fields === undefined ||
      JSON.stringify(normalized.fields) ===
        JSON.stringify(cursorSelectors.fields)) &&
    (requested.spatial === undefined ||
      JSON.stringify(normalized.spatial) ===
        JSON.stringify(cursorSelectors.spatial)) &&
    (requested.time_range === undefined ||
      JSON.stringify(normalized.time_range) ===
        JSON.stringify(cursorSelectors.time_range))
  );
}

function isCursorSelectors(value: unknown): value is CursorSelectors {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !hasExactKeys(value as Record<string, unknown>, [
      "fields",
      "spatial",
      "time_range",
    ])
  ) {
    return false;
  }

  const selectors = value as Record<string, unknown>;
  return (
    (selectors.fields === null || isFields(selectors.fields)) &&
    (selectors.spatial === null || isSpatialPoint(selectors.spatial)) &&
    (selectors.time_range === null || isTimeRange(selectors.time_range))
  );
}

function isFields(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length >= 1 &&
    value.length <= 10 &&
    value.every(
      (field) =>
        typeof field === "string" &&
        field.length > 0 &&
        field === field.trim(),
    ) &&
    new Set(value).size === value.length
  );
}

function isSpatialPoint(value: unknown): value is SpatialPoint {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !hasExactKeys(value as Record<string, unknown>, [
      "type",
      "latitude",
      "longitude",
    ])
  ) {
    return false;
  }

  const point = value as Record<string, unknown>;
  return (
    point.type === "point" &&
    typeof point.latitude === "number" &&
    Number.isFinite(point.latitude) &&
    point.latitude >= -90 &&
    point.latitude <= 90 &&
    typeof point.longitude === "number" &&
    Number.isFinite(point.longitude) &&
    point.longitude >= -180 &&
    point.longitude <= 180
  );
}

function isTimeRange(value: unknown): value is TimeRange {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !hasExactKeys(value as Record<string, unknown>, ["start", "end"])
  ) {
    return false;
  }

  const range = value as Record<string, unknown>;
  return (
    isCanonicalTimestamp(range.start) &&
    isCanonicalTimestamp(range.end) &&
    Date.parse(range.end) > Date.parse(range.start)
  );
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function invalidCursor(): AppError {
  return new AppError(
    "INVALID_REQUEST",
    'The "cursor" field is invalid or does not match this request.',
  );
}
