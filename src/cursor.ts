import { AppError } from "./errors";
import {
  isSource,
  QUERY_FILTER_OPERATORS,
  type QueryFilter,
  type QueryFilterScalar,
  type QuerySelectors,
  type Source,
  type SpatialQuery,
  type TimeRange,
} from "./models";

const CURSOR_VERSION = 2;
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
  filters: readonly QueryFilter[] | null;
  spatial: SpatialQuery | null;
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
    filters: selectors.filters ? selectors.filters.map(cloneFilter) : null,
    spatial: selectors.spatial ? { ...selectors.spatial } : null,
    time_range: selectors.time_range
      ? {
          start: normalizeCursorTimestamp(selectors.time_range.start),
          end: normalizeCursorTimestamp(selectors.time_range.end),
        }
      : null,
  };
}

function cloneFilter(filter: QueryFilter): QueryFilter {
  return filter.operator === "in"
    ? { ...filter, value: [...filter.value] }
    : { ...filter };
}

function normalizeCursorTimestamp(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : value;
}

function fromCursorSelectors(selectors: CursorSelectors): QuerySelectors {
  return {
    ...(selectors.fields ? { fields: selectors.fields } : {}),
    ...(selectors.filters ? { filters: selectors.filters } : {}),
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
    (requested.filters === undefined ||
      JSON.stringify(normalized.filters) ===
        JSON.stringify(cursorSelectors.filters)) &&
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
      "filters",
      "spatial",
      "time_range",
    ])
  ) {
    return false;
  }

  const selectors = value as Record<string, unknown>;
  return (
    (selectors.fields === null || isFields(selectors.fields)) &&
    (selectors.filters === null || isFilters(selectors.filters)) &&
    (selectors.spatial === null || isSpatialQuery(selectors.spatial)) &&
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

function isFilters(value: unknown): value is readonly QueryFilter[] {
  return (
    Array.isArray(value) &&
    value.length >= 1 &&
    value.length <= 20 &&
    value.every(isFilter)
  );
}

function isFilter(value: unknown): value is QueryFilter {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !hasExactKeys(value as Record<string, unknown>, [
      "field",
      "operator",
      "value",
    ])
  ) {
    return false;
  }

  const filter = value as Record<string, unknown>;
  if (
    typeof filter.field !== "string" ||
    filter.field.length === 0 ||
    filter.field !== filter.field.trim() ||
    typeof filter.operator !== "string" ||
    !QUERY_FILTER_OPERATORS.some((operator) => operator === filter.operator)
  ) {
    return false;
  }

  if (filter.operator === "in") {
    return (
      Array.isArray(filter.value) &&
      filter.value.length >= 1 &&
      filter.value.length <= 100 &&
      filter.value.every(isFilterScalar)
    );
  }

  return isFilterScalar(filter.value);
}

function isFilterScalar(value: unknown): value is QueryFilterScalar {
  return (
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function isSpatialQuery(value: unknown): value is SpatialQuery {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return false;
  }

  const spatial = value as Record<string, unknown>;
  if (spatial.type === "point") {
    return (
      hasExactKeys(spatial, ["type", "latitude", "longitude"]) &&
      isBoundedNumber(spatial.latitude, -90, 90) &&
      isBoundedNumber(spatial.longitude, -180, 180)
    );
  }

  return (
    spatial.type === "bbox" &&
    hasExactKeys(spatial, ["type", "west", "south", "east", "north"]) &&
    isBoundedNumber(spatial.west, -180, 180) &&
    isBoundedNumber(spatial.east, -180, 180) &&
    isBoundedNumber(spatial.south, -90, 90) &&
    isBoundedNumber(spatial.north, -90, 90) &&
    spatial.west < spatial.east &&
    spatial.south < spatial.north
  );
}

function isBoundedNumber(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= minimum &&
    value <= maximum
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
