import { AppError } from "../../errors";
import type {
  QueryFieldDescription,
  QueryFilter,
  QuerySchema,
} from "../../models";

export interface CsoAttribution {
  name: string;
  code?: string;
  url?: string;
}

export interface CsoDimension {
  code: string;
  label: string;
  values: readonly CsoDimensionValue[];
}

export interface CsoDimensionValue {
  code: string;
  label: string;
}

export interface CsoMetadata {
  matrix: string;
  title: string;
  updated?: string;
  subject?: string;
  product?: string;
  official?: boolean;
  copyright: CsoAttribution;
  dimensions: readonly CsoDimension[];
}

export interface CsoNormalizedRow {
  dimensions: readonly {
    field: string;
    value: string;
    label: string;
  }[];
  value: number | string | null;
  status?: string;
}

export interface CsoSelection {
  readonly dimension: Readonly<
    Record<string, { category: { index: readonly string[] } }>
  >;
  readonly cellCount: number;
}

export function parseMetadata(value: unknown): CsoMetadata {
  const dataset = jsonStatDataset(value);
  const extension = recordField(dataset.raw, "extension");
  const matrix = stringField(extension, "matrix");
  const copyright = recordField(extension, "copyright");
  const dimensions = dataset.id.map((code) =>
    parseDimension(recordField(dataset.dimension, code), code),
  );
  const subject = optionalNestedString(extension, "subject", "value");
  const product = optionalNestedString(extension, "product", "value");

  return {
    matrix,
    title: stringField(dataset.raw, "label"),
    ...(optionalString(dataset.raw.updated)
      ? { updated: optionalString(dataset.raw.updated) }
      : {}),
    ...(subject ? { subject } : {}),
    ...(product ? { product } : {}),
    ...(typeof extension.official === "boolean"
      ? { official: extension.official }
      : {}),
    copyright: {
      name: stringField(copyright, "name"),
      ...(optionalString(copyright.code)
        ? { code: optionalString(copyright.code) }
        : {}),
      ...(optionalHttpsUrl(copyright.href)
        ? { url: optionalHttpsUrl(copyright.href) }
        : {}),
    },
    dimensions,
  };
}

export function querySchema(
  metadata: CsoMetadata,
  maxDimensionValues: number,
): QuerySchema {
  const fields: QueryFieldDescription[] = metadata.dimensions.map(
    (dimension) => ({
      name: dimension.code,
      label: dimension.label,
      type: "string",
      operators: ["in"],
      values: dimension.values.slice(0, maxDimensionValues).map((value) => ({
        value: value.code,
        label: value.label,
      })),
      ...(dimension.values.length > maxDimensionValues
        ? { values_truncated: true }
        : {}),
    }),
  );
  return {
    fields,
    truncated: fields.some((field) => field.values_truncated === true),
  };
}

export function buildSelection(
  metadata: CsoMetadata,
  filters: readonly QueryFilter[] | undefined,
  maxCells: number,
): CsoSelection {
  const byField = new Map<string, QueryFilter>();
  for (const filter of filters ?? []) {
    if (byField.has(filter.field)) {
      throw new AppError(
        "INVALID_REQUEST",
        `filters contains duplicate field ${filter.field}.`,
      );
    }
    byField.set(filter.field, filter);
  }

  const dimensions = new Map(metadata.dimensions.map((item) => [item.code, item]));
  for (const field of byField.keys()) {
    if (!dimensions.has(field)) {
      throw new AppError("INVALID_REQUEST", `Unknown dimension ${field}.`);
    }
  }

  let cellCount = 1;
  const dimension: Record<
    string,
    { category: { index: readonly string[] } }
  > = {};
  for (const item of metadata.dimensions) {
    const filter = byField.get(item.code);
    if (!filter) {
      if (item.values.length !== 1) {
        throw new AppError(
          "INVALID_REQUEST",
          `An in filter is required for dimension ${item.code}.`,
        );
      }
      dimension[item.code] = {
        category: { index: [item.values[0]!.code] },
      };
      continue;
    }
    if (filter.operator !== "in") {
      throw new AppError(
        "INVALID_REQUEST",
        `Dimension ${item.code} only supports the in operator.`,
      );
    }
    if (
      filter.value.length === 0 ||
      filter.value.some((candidate) => typeof candidate !== "string")
    ) {
      throw new AppError(
        "INVALID_REQUEST",
        `Dimension ${item.code} requires one or more string value codes.`,
      );
    }
    const values = filter.value as readonly string[];
    if (new Set(values).size !== values.length) {
      throw new AppError(
        "INVALID_REQUEST",
        `Dimension ${item.code} contains duplicate value codes.`,
      );
    }
    const allowed = new Set(item.values.map((candidate) => candidate.code));
    const invalid = values.find((candidate) => !allowed.has(candidate));
    if (invalid !== undefined) {
      throw new AppError(
        "INVALID_REQUEST",
        `Unknown value ${invalid} for dimension ${item.code}.`,
      );
    }
    cellCount *= values.length;
    if (cellCount > maxCells) {
      throw new AppError(
        "INVALID_REQUEST",
        `The selected cube exceeds the ${maxCells}-cell limit.`,
      );
    }
    dimension[item.code] = { category: { index: values } };
  }

  return { dimension, cellCount };
}

export function datasetQueryParams(
  metadata: CsoMetadata,
  selection: CsoSelection,
  language: string,
): unknown {
  return {
    class: "query",
    id: metadata.dimensions.map((dimension) => dimension.code),
    dimension: selection.dimension,
    extension: {
      matrix: metadata.matrix,
      codes: true,
      pivot: null,
      language: { code: language },
      format: { type: "JSON-stat", version: "2.0" },
    },
    version: "2.0",
    m2m: false,
  };
}

export function normalizeDataset(value: unknown): readonly CsoNormalizedRow[] {
  const dataset = jsonStatDataset(value);
  const dimensions = dataset.id.map((code, index) => {
    const dimension = parseDimension(recordField(dataset.dimension, code), code);
    if (dimension.values.length !== dataset.size[index]) {
      throw new AppError("UPSTREAM_ERROR");
    }
    return dimension;
  });
  const total = product(dataset.size);
  const values = indexedValues(dataset.raw.value, total, true);
  const statuses = indexedValues(dataset.raw.status, total, false);
  const rows: CsoNormalizedRow[] = [];

  for (let linear = 0; linear < total; linear += 1) {
    const rowDimensions = dimensions.map((dimension, dimensionIndex) => {
      const stride = product(dataset.size.slice(dimensionIndex + 1));
      const valueIndex = Math.floor(linear / stride) % dataset.size[dimensionIndex]!;
      const selected = dimension.values[valueIndex];
      if (!selected) {
        throw new AppError("UPSTREAM_ERROR");
      }
      return {
        field: dimension.code,
        value: selected.code,
        label: selected.label,
      };
    });
    const rawValue = values[linear];
    if (
      rawValue !== null &&
      typeof rawValue !== "number" &&
      typeof rawValue !== "string"
    ) {
      throw new AppError("UPSTREAM_ERROR");
    }
    const status = statuses[linear];
    rows.push({
      dimensions: rowDimensions,
      value: rawValue ?? null,
      ...(typeof status === "string" && status !== "" ? { status } : {}),
    });
  }
  return rows;
}

interface ParsedDataset {
  raw: Record<string, unknown>;
  id: readonly string[];
  size: readonly number[];
  dimension: Record<string, unknown>;
}

function jsonStatDataset(value: unknown): ParsedDataset {
  if (!isRecord(value) || value.class !== "dataset") {
    throw new AppError("UPSTREAM_ERROR");
  }
  const id = stringArray(value.id);
  const size = numberArray(value.size);
  if (id.length === 0 || id.length !== size.length) {
    throw new AppError("UPSTREAM_ERROR");
  }
  const dimension = recordField(value, "dimension");
  return { raw: value, id, size, dimension };
}

function parseDimension(value: Record<string, unknown>, code: string): CsoDimension {
  const category = recordField(value, "category");
  const labels = recordField(category, "label");
  const codes = categoryIndex(category.index);
  return {
    code,
    label: stringField(value, "label"),
    values: codes.map((candidate) => ({
      code: candidate,
      label: optionalString(labels[candidate]) ?? candidate,
    })),
  };
}

function categoryIndex(value: unknown): readonly string[] {
  if (Array.isArray(value)) {
    return stringArray(value);
  }
  if (isRecord(value)) {
    const entries = Object.entries(value);
    if (
      entries.some(
        ([code, position]) =>
          code === "" || !Number.isInteger(position) || (position as number) < 0,
      )
    ) {
      throw new AppError("UPSTREAM_ERROR");
    }
    return entries
      .sort((left, right) => (left[1] as number) - (right[1] as number))
      .map(([code]) => code);
  }
  throw new AppError("UPSTREAM_ERROR");
}

function indexedValues(
  value: unknown,
  size: number,
  required: boolean,
): unknown[] {
  if (value === undefined && !required) {
    return Array.from({ length: size });
  }
  if (Array.isArray(value)) {
    if (value.length !== size) {
      throw new AppError("UPSTREAM_ERROR");
    }
    return value;
  }
  if (isRecord(value)) {
    const result = Array.from<unknown>({ length: size }).fill(null);
    for (const [indexText, item] of Object.entries(value)) {
      const index = Number(indexText);
      if (!Number.isInteger(index) || index < 0 || index >= size) {
        throw new AppError("UPSTREAM_ERROR");
      }
      result[index] = item;
    }
    return result;
  }
  throw new AppError("UPSTREAM_ERROR");
}

function product(values: readonly number[]): number {
  return values.reduce((total, value) => total * value, 1);
}

function recordField(
  value: Record<string, unknown>,
  field: string,
): Record<string, unknown> {
  const candidate = value[field];
  if (!isRecord(candidate)) {
    throw new AppError("UPSTREAM_ERROR");
  }
  return candidate;
}

function stringField(value: Record<string, unknown>, field: string): string {
  const candidate = optionalString(value[field]);
  if (!candidate) {
    throw new AppError("UPSTREAM_ERROR");
  }
  return candidate;
}

function stringArray(value: unknown): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.some((candidate) => typeof candidate !== "string" || candidate === "")
  ) {
    throw new AppError("UPSTREAM_ERROR");
  }
  return value;
}

function numberArray(value: unknown): readonly number[] {
  if (
    !Array.isArray(value) ||
    value.some(
      (candidate) => !Number.isInteger(candidate) || (candidate as number) <= 0,
    )
  ) {
    throw new AppError("UPSTREAM_ERROR");
  }
  return value as number[];
}

function optionalNestedString(
  value: Record<string, unknown>,
  objectField: string,
  stringKey: string,
): string | undefined {
  const nested = value[objectField];
  return isRecord(nested) ? optionalString(nested[stringKey]) : undefined;
}

function optionalHttpsUrl(value: unknown): string | undefined {
  const candidate = optionalString(value);
  if (!candidate) {
    return undefined;
  }
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
