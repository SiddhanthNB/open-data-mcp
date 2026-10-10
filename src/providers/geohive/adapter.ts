import { AppError } from "../../errors";
import type {
  AccessPoint,
  DataDescription,
  DataLink,
  DataSearchResult,
  DataSummary,
  QueryDataResult,
  QueryFieldDescription,
  QuerySchema,
  QuerySelectors,
  Source,
} from "../../models";
import {
  abortable,
  cancelBody,
  enforceSerializedSize,
  readBoundedJsonResponse,
} from "../../resources/limits";
import { plainText } from "../ckan/text";
import type {
  DescribeDataInput,
  GetDataLinkInput,
  QueryDataInput,
  SearchDataInput,
} from "../provider";
import {
  ARCGIS_PORTAL_ORIGIN,
  GEOHIVE_CATALOGUE_ORIGIN,
  catalogueItemUrl,
  catalogueSearchUrl,
  portalItemDataUrl,
  sameEndpoint,
  validateArcGisUrl,
  validateWmsUrl,
  type ValidatedArcGisUrl,
} from "./urls";

export const GEOHIVE_SOURCE_ID = "geohive";

// Removed when the shared Source union gains GeoHive during integration.
const GEOHIVE_SOURCE = GEOHIVE_SOURCE_ID as Source;

export interface GeoHiveSettings {
  catalogueOrigin: typeof GEOHIVE_CATALOGUE_ORIGIN;
  portalOrigin: typeof ARCGIS_PORTAL_ORIGIN;
  allowedArcgisHosts: readonly string[];
  allowedWmsHosts: readonly string[];
  timeoutMs: number;
  maxInputBytes: number;
  maxOutputBytes: number;
  defaultLimit: number;
  maxLimit: number;
  maxLayers: number;
  maxSchemaFields: number;
  maxSelectedFields: number;
}

export interface GeoHiveDependencies {
  fetch?: typeof fetch;
  now?: () => Date;
}

type JsonRecord = Record<string, unknown>;

interface CatalogueRecord {
  dataId: string;
  properties: JsonRecord;
  itemUrl: string;
}

interface ArcGisField {
  name: string;
  label?: string;
  type: QueryFieldDescription["type"];
}

interface LayerMetadata {
  id: number;
  name: string;
  description?: string;
  copyright?: string;
  fields: readonly ArcGisField[];
  fieldsTruncated: boolean;
  objectIdField?: string;
  queryable: boolean;
  paginating: boolean;
  spatial: boolean;
  timeAware: boolean;
  maxRecordCount?: number;
  lastModified?: string;
}

interface ResolvedAccessPoint {
  accessPoint: AccessPoint;
  kind: "arcgis" | "wms";
  url: string;
  layer?: LayerMetadata;
}

export class GeoHiveAdapter {
  readonly config: GeoHiveSettings;

  private readonly fetcher: typeof fetch;
  private readonly now: () => Date;
  private readonly arcgisHosts: ReadonlySet<string>;
  private readonly wmsHosts: ReadonlySet<string>;

  constructor(settings: GeoHiveSettings, dependencies: GeoHiveDependencies = {}) {
    validateSettings(settings);
    this.config = settings;
    this.fetcher = dependencies.fetch ?? fetch;
    this.now = dependencies.now ?? (() => new Date());
    this.arcgisHosts = normalizedHosts(settings.allowedArcgisHosts);
    this.wmsHosts = normalizedHosts(settings.allowedWmsHosts);
  }

  async searchData(input: SearchDataInput): Promise<DataSearchResult> {
    const { limit, offset } = this.pagination(input.limit, input.offset);
    const url = catalogueSearchUrl(input.query, limit, offset);
    const body = recordValue(await this.requestJson(url));
    const features = arrayField(body, "features");
    const total = nonnegativeInteger(body.numberMatched);
    const results = features.map((value) =>
      this.summary(parseCatalogueFeature(value), false),
    );
    const result: DataSearchResult = {
      results,
      pagination: { limit, offset, returned: results.length, total },
    };
    return this.bounded(result);
  }

  async describeData(input: DescribeDataInput): Promise<DataDescription> {
    const record = await this.getRecord(input.data_id);
    const accessPoints = await this.resolveAccessPoints(record);
    const properties = record.properties;
    const tags = stringArray(properties.tags);
    const licence = licenceAndAttribution(properties);
    return this.bounded({
      ...this.summary(record, true),
      ...(licence ? { licence } : {}),
      ...(tags.length > 0 ? { tags } : {}),
      access_points: accessPoints.map((entry) => entry.accessPoint),
    });
  }

  async queryData(input: QueryDataInput): Promise<QueryDataResult> {
    if (input.filters && input.filters.length > 0) {
      throw new AppError(
        "UNSUPPORTED_OPERATION",
        "GeoHive does not accept attribute filters in this phase.",
      );
    }
    const { limit, offset } = this.pagination(input.limit, input.offset);
    const record = await this.getRecord(input.data_id);
    const resolved = await this.resolveRequestedAccess(record, input.access_id);
    if (resolved.kind !== "arcgis" || !resolved.layer) {
      throw new AppError("UNSUPPORTED_OPERATION");
    }
    const layer = resolved.layer;
    if (!layer.queryable) {
      throw new AppError("UNSUPPORTED_OPERATION", "The ArcGIS layer is not queryable.");
    }
    if (!layer.paginating || !layer.objectIdField) {
      throw new AppError(
        "UNSUPPORTED_OPERATION",
        "The ArcGIS layer does not support stable offset pagination.",
      );
    }
    if (layer.maxRecordCount !== undefined && limit > layer.maxRecordCount) {
      throw new AppError(
        "INVALID_REQUEST",
        `limit must not exceed the layer maximum of ${layer.maxRecordCount}.`,
      );
    }

    const fields = selectedFields(
      input.fields,
      layer,
      this.config.maxSelectedFields,
    );
    const common = querySelectors(input, layer);
    const countUrl = arcgisQueryUrl(resolved.url, {
      where: "1=1",
      returnCountOnly: "true",
      f: "json",
      ...common,
    });
    const countBody = recordValue(await this.requestJson(countUrl));
    rejectArcGisError(countBody);
    const total = nonnegativeInteger(countBody.count);

    const dataUrl = arcgisQueryUrl(resolved.url, {
      where: "1=1",
      outFields: fields.join(","),
      returnGeometry: "false",
      resultOffset: String(offset),
      resultRecordCount: String(limit),
      orderByFields: `${layer.objectIdField} ASC`,
      f: "json",
      ...common,
    });
    const dataBody = recordValue(await this.requestJson(dataUrl));
    rejectArcGisError(dataBody);
    const features = arrayField(dataBody, "features");
    if (features.length > limit) {
      throw new AppError("UPSTREAM_ERROR");
    }
    const rows = features.map((feature) => {
      const attributes = recordValue(recordValue(feature).attributes);
      return Object.fromEntries(fields.map((field) => [field, attributes[field]]));
    });

    return this.bounded({
      data_id: record.dataId,
      access_id: input.access_id,
      data: { rows },
      provenance: {
        source: GEOHIVE_SOURCE,
        upstream_url: dataUrl,
        retrieved_at: this.now().toISOString(),
        original_format: "json",
      },
      pagination_supported: true,
      pagination: { limit, offset, returned: rows.length, total },
    });
  }

  async getDataLink(input: GetDataLinkInput): Promise<DataLink> {
    const record = await this.getRecord(input.data_id);
    const resolved = await this.resolveRequestedAccess(record, input.access_id);
    const point = resolved.accessPoint;
    return this.bounded({
      data_id: record.dataId,
      access_id: point.access_id,
      url: resolved.url,
      format: point.format,
      ...(point.title ? { title: point.title } : {}),
      ...(point.description ? { description: point.description } : {}),
      ...(point.last_modified ? { last_modified: point.last_modified } : {}),
      provenance: {
        source: GEOHIVE_SOURCE,
        upstream_url: resolved.url,
        retrieved_at: this.now().toISOString(),
        original_format: point.format,
      },
    });
  }

  private async getRecord(dataId: string): Promise<CatalogueRecord> {
    const itemUrl = catalogueItemUrl(dataId);
    const body = await this.requestJson(itemUrl, true);
    const record = parseCatalogueFeature(body, dataId);
    return { ...record, dataId, itemUrl };
  }

  private summary(record: CatalogueRecord, detailed: boolean): DataSummary {
    const properties = record.properties;
    const title = requiredString(properties.title);
    const description = normalizedText(
      detailed ? properties.description ?? properties.snippet : properties.snippet,
    );
    const publisher = optionalString(properties.source) ?? optionalString(properties.owner);
    const format = advertisedFormat(properties.type);
    return {
      data_id: record.dataId,
      title,
      ...(description ? { description } : {}),
      ...(publisher ? { publisher } : {}),
      ...(format ? { available_formats: [format] } : {}),
      provenance: {
        source: GEOHIVE_SOURCE,
        upstream_url: record.itemUrl,
        retrieved_at: this.now().toISOString(),
      },
    };
  }

  private async resolveAccessPoints(
    record: CatalogueRecord,
  ): Promise<readonly ResolvedAccessPoint[]> {
    const recordUrl = optionalString(record.properties.url);
    if (!recordUrl) {
      return [];
    }
    const arcgis = validateArcGisUrl(recordUrl, this.arcgisHosts);
    if (arcgis) {
      return this.resolveArcGisAccessPoints(arcgis);
    }
    const wms = validateWmsUrl(recordUrl, this.wmsHosts);
    if (wms && normalizedType(record.properties.type) === "wms") {
      return this.resolveWmsAccessPoints(record.dataId, wms);
    }
    return [];
  }

  private async resolveRequestedAccess(
    record: CatalogueRecord,
    accessId: string,
  ): Promise<ResolvedAccessPoint> {
    const points = await this.resolveAccessPoints(record);
    const point = points.find((candidate) => candidate.accessPoint.access_id === accessId);
    if (!point) {
      throw new AppError("RESOURCE_NOT_FOUND");
    }
    return point;
  }

  private async resolveArcGisAccessPoints(
    service: ValidatedArcGisUrl,
  ): Promise<readonly ResolvedAccessPoint[]> {
    if (service.layerId !== undefined) {
      return [await this.arcgisLayerAccessPoint(service, service.layerId)];
    }

    const serviceUrl = withJsonFormat(service.serviceUrl);
    const metadata = recordValue(await this.requestJson(serviceUrl));
    rejectArcGisError(metadata);
    const layers = optionalArray(metadata.layers) ?? [];
    if (layers.length > this.config.maxLayers) {
      throw new AppError("RESOURCE_TOO_LARGE");
    }
    const ids = layers.map((value) => layerId(recordValue(value)));
    if (new Set(ids).size !== ids.length) {
      throw new AppError("UPSTREAM_ERROR");
    }
    const points: ResolvedAccessPoint[] = [];
    for (const id of ids) {
      points.push(await this.arcgisLayerAccessPoint(service, id));
    }
    return points;
  }

  private async arcgisLayerAccessPoint(
    service: ValidatedArcGisUrl,
    id: number,
  ): Promise<ResolvedAccessPoint> {
    const layerUrl = `${service.serviceUrl}/${id}`;
    const body = recordValue(await this.requestJson(withJsonFormat(layerUrl)));
    rejectArcGisError(body);
    const layer = parseLayerMetadata(body, id, this.config.maxSchemaFields);
    const description = layerDescription(layer);
    const querySchema = layerSchema(layer);
    return {
      kind: "arcgis",
      url: layerUrl,
      layer,
      accessPoint: {
        access_id: `layer:${id}`,
        title: layer.name,
        ...(description ? { description } : {}),
        format: "json",
        capabilities: {
          query: layer.queryable && layer.paginating && layer.objectIdField !== undefined,
          link: true,
        },
        ...(querySchema ? { query_schema: querySchema } : {}),
        ...(layer.lastModified ? { last_modified: layer.lastModified } : {}),
        upstream_url: layerUrl,
      },
    };
  }

  private async resolveWmsAccessPoints(
    dataId: string,
    wmsUrl: string,
  ): Promise<readonly ResolvedAccessPoint[]> {
    const body = recordValue(await this.requestJson(portalItemDataUrl(dataId)));
    if (!sameEndpoint(requiredString(body.url), wmsUrl)) {
      return [];
    }
    const layers = optionalArray(body.layers) ?? [];
    if (layers.length > this.config.maxLayers) {
      throw new AppError("RESOURCE_TOO_LARGE");
    }
    const points: ResolvedAccessPoint[] = [];
    const seen = new Set<string>();
    for (const value of layers) {
      const layer = recordValue(value);
      const name = requiredString(layer.name);
      if (!validWmsLayerName(name) || seen.has(name)) {
        throw new AppError("UPSTREAM_ERROR");
      }
      seen.add(name);
      const title = optionalString(layer.title);
      points.push({
        kind: "wms",
        url: wmsUrl,
        accessPoint: {
          access_id: `wms:${name}`,
          ...(title ? { title } : {}),
          format: "wms",
          capabilities: { query: false, link: true },
          upstream_url: wmsUrl,
        },
      });
    }
    return points;
  }

  private async requestJson(url: string, notFound = false): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const response = await abortable(
        this.fetcher(url, {
          headers: { accept: "application/json, application/geo+json" },
          redirect: "error",
          signal: controller.signal,
        }),
        controller.signal,
      );
      if (response.status === 429) {
        cancelBody(response.body);
        throw new AppError("RATE_LIMITED");
      }
      if (response.status === 404 && notFound) {
        cancelBody(response.body);
        throw new AppError("DATASET_NOT_FOUND");
      }
      if (!response.ok) {
        cancelBody(response.body);
        throw new AppError("UPSTREAM_ERROR");
      }
      return await readBoundedJsonResponse(
        response,
        this.config.maxInputBytes,
        controller.signal,
      );
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) {
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

  private bounded<T>(value: T): T {
    enforceSerializedSize(value, this.config.maxOutputBytes);
    return value;
  }
}

function parseCatalogueFeature(
  value: unknown,
  requiredDataId?: string,
): CatalogueRecord {
  const feature = recordValue(value);
  const properties = recordValue(feature.properties);
  const propertyId = optionalString(properties.id);
  const featureId = optionalString(feature.id);
  const stableId = propertyId && /^[a-f0-9]{32}$/iu.test(propertyId)
    ? propertyId
    : featureId && /^[a-f0-9]{32}$/iu.test(featureId)
      ? featureId
      : undefined;
  if (!stableId || (requiredDataId !== undefined && stableId !== requiredDataId)) {
    throw new AppError("UPSTREAM_ERROR");
  }
  return {
    dataId: stableId,
    properties,
    itemUrl: catalogueItemUrl(stableId),
  };
}

function parseLayerMetadata(
  value: JsonRecord,
  expectedId: number,
  maxSchemaFields: number,
): LayerMetadata {
  const id = layerId(value);
  if (id !== expectedId) {
    throw new AppError("UPSTREAM_ERROR");
  }
  const rawFields = arrayField(value, "fields");
  const mappedFields = rawFields
    .map((field) => mapArcGisField(recordValue(field)))
    .filter((field): field is ArcGisField => field !== undefined);
  const fields = mappedFields.slice(0, maxSchemaFields);
  const capabilities = optionalString(value.capabilities)
    ?.split(",")
    .map((entry) => entry.trim().toLowerCase()) ?? [];
  const advanced = optionalRecord(value.advancedQueryCapabilities);
  const objectIdCandidate = optionalString(value.objectIdField);
  const objectIdField = objectIdCandidate && mappedFields.some(
    (field) => field.name === objectIdCandidate,
  )
    ? objectIdCandidate
    : undefined;
  const maxRecordCount = optionalPositiveInteger(value.maxRecordCount);
  const editingInfo = optionalRecord(value.editingInfo);
  const lastEdit = editingInfo
    ? optionalNonnegativeNumber(editingInfo.lastEditDate)
    : undefined;
  return {
    id,
    name: requiredString(value.name),
    ...(normalizedText(value.description)
      ? { description: normalizedText(value.description) }
      : {}),
    ...(normalizedText(value.copyrightText)
      ? { copyright: normalizedText(value.copyrightText) }
      : {}),
    fields,
    fieldsTruncated:
      mappedFields.length !== rawFields.length || mappedFields.length > fields.length,
    ...(objectIdField ? { objectIdField } : {}),
    queryable: capabilities.includes("query"),
    paginating: advanced?.supportsPagination === true,
    spatial: typeof value.geometryType === "string" && value.geometryType !== "",
    timeAware: isTimeAware(value.timeInfo),
    ...(maxRecordCount ? { maxRecordCount } : {}),
    ...(lastEdit !== undefined ? { lastModified: new Date(lastEdit).toISOString() } : {}),
  };
}

function mapArcGisField(value: JsonRecord): ArcGisField | undefined {
  const name = requiredString(value.name);
  if (!/^[a-z_][a-z0-9_.]*$/iu.test(name)) {
    return undefined;
  }
  const arcType = requiredString(value.type).toLowerCase();
  let type: QueryFieldDescription["type"] | undefined;
  if (
    arcType === "esrifieldtypestring" ||
    arcType === "esrifieldtypeguid" ||
    arcType === "esrifieldtypeglobalid"
  ) {
    type = "string";
  } else if (
    arcType === "esrifieldtypeoid" ||
    arcType === "esrifieldtypesmallinteger" ||
    arcType === "esrifieldtypeinteger" ||
    arcType === "esrifieldtypesingle" ||
    arcType === "esrifieldtypedouble" ||
    arcType === "esrifieldtypebiginteger"
  ) {
    type = "number";
  } else if (arcType.includes("date") || arcType.includes("time")) {
    type = "datetime";
  }
  if (!type) {
    return undefined;
  }
  const label = optionalString(value.alias);
  return { name, ...(label ? { label } : {}), type };
}

function layerSchema(layer: LayerMetadata): QuerySchema | undefined {
  if (layer.fields.length === 0) {
    return undefined;
  }
  return {
    fields: layer.fields.map((field) => ({
      name: field.name,
      ...(field.label ? { label: field.label } : {}),
      type: field.type,
      operators: [],
    })),
    truncated: layer.fieldsTruncated,
    ...(layer.spatial ? { spatial: ["point", "bbox"] } : {}),
  };
}

function selectedFields(
  requested: readonly string[] | undefined,
  layer: LayerMetadata,
  maximum: number,
): readonly string[] {
  const available = new Set(layer.fields.map((field) => field.name));
  const fields = requested ?? layer.fields.map((field) => field.name);
  if (
    fields.length === 0 ||
    fields.length > maximum ||
    new Set(fields).size !== fields.length ||
    fields.some((field) => !available.has(field))
  ) {
    throw new AppError(
      "INVALID_REQUEST",
      `fields must contain between 1 and ${maximum} unique fields from the layer schema.`,
    );
  }
  return fields;
}

function querySelectors(
  input: QuerySelectors,
  layer: LayerMetadata,
): Record<string, string> {
  const parameters: Record<string, string> = {};
  if (input.spatial) {
    if (!layer.spatial) {
      throw new AppError("UNSUPPORTED_OPERATION", "The layer is not spatial.");
    }
    if (input.spatial.type === "point") {
      const { latitude, longitude } = input.spatial;
      if (
        !Number.isFinite(latitude) ||
        !Number.isFinite(longitude) ||
        latitude < -90 ||
        latitude > 90 ||
        longitude < -180 ||
        longitude > 180
      ) {
        throw new AppError("INVALID_REQUEST", "The spatial point is invalid.");
      }
      parameters.geometry = `${longitude},${latitude}`;
      parameters.geometryType = "esriGeometryPoint";
    } else {
      const { west, south, east, north } = input.spatial;
      if (
        ![west, south, east, north].every(Number.isFinite) ||
        west < -180 ||
        east > 180 ||
        south < -90 ||
        north > 90 ||
        west >= east ||
        south >= north
      ) {
        throw new AppError("INVALID_REQUEST", "The spatial bounding box is invalid.");
      }
      parameters.geometry = `${west},${south},${east},${north}`;
      parameters.geometryType = "esriGeometryEnvelope";
    }
    parameters.inSR = "4326";
    parameters.spatialRel = "esriSpatialRelIntersects";
  }
  if (input.time_range) {
    if (!layer.timeAware) {
      throw new AppError("UNSUPPORTED_OPERATION", "The layer is not time-aware.");
    }
    const start = utcTimestamp(input.time_range.start);
    const end = utcTimestamp(input.time_range.end);
    if (end <= start) {
      throw new AppError("INVALID_REQUEST", "The time range must be increasing.");
    }
    parameters.time = `${start},${end}`;
  }
  return parameters;
}

function arcgisQueryUrl(
  layerUrl: string,
  parameters: Readonly<Record<string, string>>,
): string {
  const url = new URL(`${layerUrl}/query`);
  for (const [name, value] of Object.entries(parameters)) {
    url.searchParams.set(name, value);
  }
  return url.toString();
}

function withJsonFormat(value: string): string {
  const url = new URL(value);
  url.searchParams.set("f", "pjson");
  return url.toString();
}

function rejectArcGisError(value: JsonRecord): void {
  if (value.error !== undefined) {
    throw new AppError("UPSTREAM_ERROR");
  }
}

function layerDescription(layer: LayerMetadata): string | undefined {
  return [layer.description, layer.copyright ? `Attribution: ${layer.copyright}` : undefined]
    .filter((value): value is string => value !== undefined)
    .join(" ") || undefined;
}

function licenceAndAttribution(properties: JsonRecord): string | undefined {
  const licence = optionalString(properties.license);
  const details = normalizedText(properties.licenseInfo);
  const attribution = normalizedText(properties.accessInformation);
  const values = [
    licence,
    details,
    attribution ? `Attribution: ${attribution}` : undefined,
  ].filter((value): value is string => value !== undefined);
  return values.length > 0 ? values.join(" ") : undefined;
}

function advertisedFormat(value: unknown): string | undefined {
  const type = normalizedType(value);
  if (type === "feature service" || type === "feature layer" || type === "map service") {
    return "json";
  }
  if (type === "wms") {
    return "wms";
  }
  return undefined;
}

function normalizedType(value: unknown): string | undefined {
  return optionalString(value)?.trim().toLowerCase();
}

function validWmsLayerName(value: string): boolean {
  return /^[a-z0-9_.:-]{1,200}$/iu.test(value);
}

function utcTimestamp(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(value)) {
    throw new AppError("INVALID_REQUEST", "Time ranges must use UTC timestamps.");
  }
  const parsed = Date.parse(value);
  if (
    !Number.isFinite(parsed) ||
    `${new Date(parsed).toISOString().slice(0, 19)}Z` !==
      `${value.slice(0, 19)}Z`
  ) {
    throw new AppError("INVALID_REQUEST", "Time ranges must use valid timestamps.");
  }
  return parsed;
}

function isTimeAware(value: unknown): boolean {
  const timeInfo = optionalRecord(value);
  return (
    timeInfo !== undefined &&
    (optionalString(timeInfo.startTimeField) !== undefined ||
      optionalString(timeInfo.endTimeField) !== undefined)
  );
}

function validateSettings(settings: GeoHiveSettings): void {
  if (settings.catalogueOrigin !== GEOHIVE_CATALOGUE_ORIGIN) {
    throw new RangeError("GeoHive catalogue origin must be the official HTTPS origin");
  }
  if (settings.portalOrigin !== ARCGIS_PORTAL_ORIGIN) {
    throw new RangeError("ArcGIS portal origin must be the official HTTPS origin");
  }
  for (const [name, value] of Object.entries({
    timeoutMs: settings.timeoutMs,
    maxInputBytes: settings.maxInputBytes,
    maxOutputBytes: settings.maxOutputBytes,
    defaultLimit: settings.defaultLimit,
    maxLimit: settings.maxLimit,
    maxLayers: settings.maxLayers,
    maxSchemaFields: settings.maxSchemaFields,
    maxSelectedFields: settings.maxSelectedFields,
  })) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new RangeError(`${name} must be a positive integer`);
    }
  }
  if (settings.maxLimit > 100 || settings.defaultLimit > settings.maxLimit) {
    throw new RangeError("GeoHive pagination limits are invalid");
  }
  if (settings.maxSelectedFields > settings.maxSchemaFields) {
    throw new RangeError("maxSelectedFields must not exceed maxSchemaFields");
  }
  normalizedHosts(settings.allowedArcgisHosts);
  normalizedHosts(settings.allowedWmsHosts);
}

function normalizedHosts(values: readonly string[]): ReadonlySet<string> {
  if (values.length === 0) {
    throw new RangeError("At least one exact host is required");
  }
  const normalized = values.map((value) => value.trim().toLowerCase());
  if (
    new Set(normalized).size !== normalized.length ||
    normalized.some(
      (value) =>
        !/^[a-z0-9.-]+$/u.test(value) ||
        value.startsWith(".") ||
        value.endsWith(".") ||
        value.includes(".."),
    )
  ) {
    throw new RangeError("Allowed hosts must be unique exact hostnames");
  }
  return new Set(normalized);
}

function recordValue(value: unknown): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AppError("UPSTREAM_ERROR");
  }
  return value as JsonRecord;
}

function optionalRecord(value: unknown): JsonRecord | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return recordValue(value);
}

function arrayField(value: JsonRecord, name: string): unknown[] {
  if (!Array.isArray(value[name])) {
    throw new AppError("UPSTREAM_ERROR");
  }
  return value[name];
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

function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new AppError("UPSTREAM_ERROR");
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new AppError("UPSTREAM_ERROR");
  }
  const normalized = value.trim();
  return normalized === "" ? undefined : normalized;
}

function normalizedText(value: unknown): string | undefined {
  const text = optionalString(value);
  if (!text) {
    return undefined;
  }
  const normalized = plainText(text);
  return normalized === "" ? undefined : normalized;
}

function stringArray(value: unknown): string[] {
  const values = optionalArray(value) ?? [];
  if (values.some((entry) => typeof entry !== "string")) {
    throw new AppError("UPSTREAM_ERROR");
  }
  return [...new Set(values.map((entry) => (entry as string).trim()).filter(Boolean))];
}

function nonnegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new AppError("UPSTREAM_ERROR");
  }
  return value as number;
}

function optionalPositiveInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) > 0
    ? (value as number)
    : undefined;
}

function optionalNonnegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function layerId(value: JsonRecord): number {
  return nonnegativeInteger(value.id);
}

function isAbortError(value: unknown): boolean {
  return value instanceof Error && value.name === "AbortError";
}
