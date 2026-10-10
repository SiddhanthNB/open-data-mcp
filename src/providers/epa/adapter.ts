import { AppError } from "../../errors";
import type {
  AccessPoint,
  DataDescription,
  DataLink,
  DataSearchResult,
  DataSummary,
  QueryDataResult,
  QueryFieldDescription,
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

export const EPA_SOURCE_ID = "epa";
export const EPA_LOCATIONS_ENDPOINT =
  "https://data.epa.ie/bw/api/v1/locations" as const;
export const EPA_MEASUREMENTS_ENDPOINT =
  "https://data.epa.ie/bw/api/v1/measurements" as const;
export const EPA_ALERTS_ENDPOINT =
  "https://data.epa.ie/bw/api/v1/alerts" as const;

// Removed when the shared Source union gains EPA during integration.
const EPA_SOURCE = EPA_SOURCE_ID as Source;
const UPSTREAM_PAGE_SIZE = 100;
const LICENCE =
  "Creative Commons Attribution 4.0 International (CC BY 4.0)";
const ATTRIBUTION =
  "Contains Irish Public Sector Information provided by the Environmental Protection Agency (EPA), Ireland.";

export type EpaDataId =
  | "bathing_water_locations"
  | "bathing_water_measurements"
  | "bathing_water_alerts";

export type EpaAccessId = "locations" | "measurements" | "alerts";

export interface EpaSettings {
  endpoints: {
    locations: typeof EPA_LOCATIONS_ENDPOINT;
    measurements: typeof EPA_MEASUREMENTS_ENDPOINT;
    alerts: typeof EPA_ALERTS_ENDPOINT;
  };
  timeoutMs: number;
  maxInputBytes: number;
  maxOutputBytes: number;
  defaultLimit: number;
  maxLimit: number;
}

export interface EpaDependencies {
  fetch?: typeof fetch;
  now?: () => Date;
}

interface EpaDataset {
  dataId: EpaDataId;
  accessId: EpaAccessId;
  endpoint: string;
  title: string;
  description: string;
  caveat: string;
  tags: readonly string[];
  fields: readonly QueryFieldDescription[];
}

interface UpstreamPage {
  count: number;
  list: readonly Readonly<Record<string, unknown>>[];
}

const LOCATION_FIELDS = fields([
  ["location_id", "number"],
  ["beach_id", "string"],
  ["beach_name", "string"],
  ["hashtag", "string"],
  ["county_name", "string"],
  ["local_authority_name", "string"],
  ["easting", "number"],
  ["northing", "number"],
  ["beach_type", "string"],
  ["beach_description", "string"],
  ["annual_water_quality_assessment", "string"],
  ["next_monitoring_date", "datetime"],
  ["beach_profile_url", "string"],
  ["profile_url_description", "string"],
  ["profile_last_updated_on", "number"],
  ["current_annual_water_quality_classification", "string"],
  ["current_annual_classification_year", "number"],
  ["year1_annual_water_quality_classification", "string"],
  ["year1_annual_classification_year", "number"],
  ["year2_annual_water_quality_classification", "string"],
  ["year2_annual_classification_year", "number"],
  ["year3_annual_water_quality_classification", "string"],
  ["year3_annual_classification_year", "number"],
  ["has_all_season_bathing_restriction_in_place", "string"],
  ["reason_for_all_season_bathing_restriction", "string"],
  ["previous_year_stp_closure_days", "number"],
  ["short_term_pollution_risk", "string"],
  ["is_blue_flag", "string"],
  ["is_green_coast", "string"],
  ["has_toilets", "string"],
  ["toilet_details", "string"],
  ["is_disability_accessible", "string"],
  ["disability_accessible_details", "string"],
  ["has_beach_wheelchair", "string"],
  ["beach_wheelchair_availability", "string"],
  ["has_first_aid", "string"],
  ["first_aid_availability_details", "string"],
  ["has_lifebuoy", "string"],
  ["lifebuoy_details", "string"],
  ["has_lifeguard", "string"],
  ["lifeguard_availability", "string"],
  ["has_parking", "string"],
  ["parking_details", "string"],
  ["is_public_transport_available", "string"],
  ["public_transport_details", "string"],
  ["is_natural_sensitive_area", "string"],
  ["natural_sensitive_area_details", "string"],
  ["has_beach_activity_zones", "string"],
  ["beach_activity_zones_details", "string"],
  ["has_beach_information_board", "string"],
  ["beach_information_board_details", "string"],
  ["are_dogs_allowed_on_lead", "string"],
  ["dogs_allowed_on_lead_details", "string"],
  ["dogs_not_allowed", "string"],
  ["dogs_not_allowed_details", "string"],
  ["cars_not_allowed_on_beach", "string"],
  ["cars_not_allowed_on_beach_details", "string"],
  ["cars_allowed_on_beach", "string"],
  ["cars_allowed_on_beach_details", "string"],
  ["has_car_free_zone", "string"],
  ["car_free_zone_details", "string"],
  ["has_litter_bin", "string"],
  ["litter_bin_details", "string"],
  ["has_recycling_facility", "string"],
  ["recycling_facility_details", "string"],
  ["last_updated", "datetime"],
]);

const MEASUREMENT_FIELDS: readonly QueryFieldDescription[] = [
  ...fields([
    ["monitoring_result_id", "number"],
    ["beach_id", "string"],
    ["beach_name", "string"],
    ["county_name", "string"],
    ["local_authority_name", "string"],
    ["sample_code", "string"],
    ["result_date", "datetime"],
    ["e_coli_result", "string"],
    ["intestinal_enterococci_result", "string"],
    ["sample_water_quality_status", "string"],
  ]),
  {
    name: "in_season",
    label: "Filter only; not returned as a result field",
    type: "boolean",
    operators: ["eq"],
  },
];

const ALERT_FIELDS = fields([
  ["incident_id", "number"],
  ["bathing_water_incident_id", "string"],
  ["beach_id", "string"],
  ["beach_name", "string"],
  ["county_name", "string"],
  ["local_authority_name", "string"],
  ["has_bathing_restriction_in_place", "string"],
  ["incident_start_date", "datetime"],
  ["incident_expected_duration", "number"],
  ["bathing_restriction_type", "string"],
  ["incident_description", "string"],
  ["bathing_notice_pdf", "string"],
  ["incident_end_date", "datetime"],
  ["last_updated", "datetime"],
]);

export class EpaBathingWaterAdapter {
  readonly config: EpaSettings;

  private readonly fetcher: typeof fetch;
  private readonly now: () => Date;
  private readonly datasets: readonly EpaDataset[];

  constructor(settings: EpaSettings, dependencies: EpaDependencies = {}) {
    validateSettings(settings);
    this.config = settings;
    this.fetcher = dependencies.fetch ?? fetch;
    this.now = dependencies.now ?? (() => new Date());
    this.datasets = catalogue(settings);
  }

  async searchData(input: SearchDataInput): Promise<DataSearchResult> {
    const { limit, offset } = this.pagination(input.limit, input.offset);
    const query = input.query?.trim().toLocaleLowerCase("en-IE") ?? "";
    const matches = this.datasets.filter((dataset) =>
      [dataset.dataId, dataset.title, dataset.description, ...dataset.tags]
        .join(" ")
        .toLocaleLowerCase("en-IE")
        .includes(query),
    );
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
    const accessPoint: AccessPoint = {
      access_id: dataset.accessId,
      title: dataset.title,
      description: `${dataset.caveat} ${ATTRIBUTION}`,
      format: "json",
      capabilities: { query: true, link: true },
      query_schema: {
        fields: dataset.fields,
        truncated: false,
      },
      upstream_url: dataset.endpoint,
    };
    return this.bounded({
      ...this.summary(dataset),
      description: `${dataset.description} ${dataset.caveat}`,
      licence: `${LICENCE}. ${ATTRIBUTION}`,
      tags: dataset.tags,
      access_points: [accessPoint],
    });
  }

  async queryData(input: QueryDataInput): Promise<QueryDataResult> {
    const dataset = this.requireDataset(input.data_id);
    this.requireAccessId(dataset, input.access_id);
    const { limit, offset } = this.pagination(input.limit, input.offset);
    const selected = selectedFields(input.fields, dataset);
    const inSeason = validateSelectors(input, dataset);
    const firstPageNumber = Math.floor(offset / UPSTREAM_PAGE_SIZE) + 1;
    const withinFirstPage = offset % UPSTREAM_PAGE_SIZE;
    const firstUrl = pageUrl(dataset.endpoint, firstPageNumber, inSeason);
    const first = await this.requestPage(firstUrl);
    const rawRows = [...first.list.slice(withinFirstPage, withinFirstPage + limit)];

    if (
      rawRows.length < limit &&
      firstPageNumber * UPSTREAM_PAGE_SIZE < first.count
    ) {
      const secondUrl = pageUrl(dataset.endpoint, firstPageNumber + 1, inSeason);
      const second = await this.requestPage(secondUrl);
      rawRows.push(...second.list.slice(0, limit - rawRows.length));
    }

    const rows = rawRows.map((row) => project(row, selected));
    return this.bounded({
      data_id: dataset.dataId,
      access_id: dataset.accessId,
      data: { rows },
      provenance: {
        source: EPA_SOURCE,
        upstream_url: firstUrl,
        retrieved_at: this.now().toISOString(),
        original_format: "json",
      },
      pagination_supported: true,
      pagination: {
        limit,
        offset,
        returned: rows.length,
        total: first.count,
      },
    });
  }

  async getDataLink(input: GetDataLinkInput): Promise<DataLink> {
    const dataset = this.requireDataset(input.data_id);
    this.requireAccessId(dataset, input.access_id);
    return this.bounded({
      data_id: dataset.dataId,
      access_id: dataset.accessId,
      url: dataset.endpoint,
      format: "json",
      title: dataset.title,
      description: `${dataset.caveat} ${ATTRIBUTION}`,
      provenance: {
        source: EPA_SOURCE,
        upstream_url: dataset.endpoint,
        retrieved_at: this.now().toISOString(),
        original_format: "json",
      },
    });
  }

  private summary(dataset: EpaDataset): DataSummary {
    return {
      data_id: dataset.dataId,
      title: dataset.title,
      description: dataset.description,
      publisher: "Environmental Protection Agency (EPA), Ireland",
      available_formats: ["json"],
      provenance: {
        source: EPA_SOURCE,
        upstream_url: dataset.endpoint,
        retrieved_at: this.now().toISOString(),
      },
    };
  }

  private requireDataset(dataId: string): EpaDataset {
    const dataset = this.datasets.find((candidate) => candidate.dataId === dataId);
    if (!dataset) {
      throw new AppError("DATASET_NOT_FOUND");
    }
    return dataset;
  }

  private requireAccessId(dataset: EpaDataset, accessId: string): void {
    if (accessId !== dataset.accessId) {
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
      limit > UPSTREAM_PAGE_SIZE ||
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

  private async requestPage(url: string): Promise<UpstreamPage> {
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
      const body = await readBoundedJsonResponse(
        response,
        this.config.maxInputBytes,
        controller.signal,
      );
      return parsePage(body);
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

function catalogue(settings: EpaSettings): readonly EpaDataset[] {
  return [
    {
      dataId: "bathing_water_locations",
      accessId: "locations",
      endpoint: settings.endpoints.locations,
      title: "EPA bathing water locations",
      description:
        "Locations, amenities and annual quality information for Irish bathing waters.",
      caveat:
        "Easting and northing are Irish Grid coordinates, not WGS84. Most fields update annually; next_monitoring_date updates separately.",
      tags: ["bathing water", "locations", "water quality"],
      fields: LOCATION_FIELDS,
    },
    {
      dataId: "bathing_water_measurements",
      accessId: "measurements",
      endpoint: settings.endpoints.measurements,
      title: "EPA bathing water measurements",
      description:
        "Reported E. coli and intestinal enterococci results for Irish bathing waters.",
      caveat:
        "In-season and out-of-season measurements have different regulatory use. Use the filter-only in_season field to select either collection.",
      tags: ["bathing water", "measurements", "water quality"],
      fields: MEASUREMENT_FIELDS,
    },
    {
      dataId: "bathing_water_alerts",
      accessId: "alerts",
      endpoint: settings.endpoints.alerts,
      title: "EPA bathing water alerts",
      description:
        "Current reported bathing-water incidents and restrictions for identified bathing waters.",
      caveat:
        "The endpoint contains current alerts only and is not a historical incident archive.",
      tags: ["bathing water", "alerts", "restrictions"],
      fields: ALERT_FIELDS,
    },
  ];
}

function fields(
  definitions: readonly (readonly [
    string,
    QueryFieldDescription["type"],
  ])[],
): readonly QueryFieldDescription[] {
  return definitions.map(([name, type]) => ({ name, type, operators: [] }));
}

function selectedFields(
  requested: readonly string[] | undefined,
  dataset: EpaDataset,
): readonly string[] {
  const selectable = dataset.fields
    .filter((field) => field.name !== "in_season")
    .map((field) => field.name);
  if (requested === undefined) {
    return selectable;
  }
  if (requested.length === 0 || new Set(requested).size !== requested.length) {
    throw new AppError(
      "INVALID_REQUEST",
      "fields must be a non-empty list without duplicates.",
    );
  }
  const allowed = new Set(selectable);
  for (const field of requested) {
    if (!allowed.has(field)) {
      throw new AppError("INVALID_REQUEST", `Unknown or non-selectable field: ${field}.`);
    }
  }
  return requested;
}

function validateSelectors(
  input: QueryDataInput,
  dataset: EpaDataset,
): boolean | undefined {
  if (input.spatial !== undefined || input.time_range !== undefined) {
    throw new AppError(
      "UNSUPPORTED_OPERATION",
      "EPA Bathing Water does not support spatial or time-range selectors.",
    );
  }
  const filters = input.filters ?? [];
  if (filters.length === 0) {
    return undefined;
  }
  if (dataset.dataId !== "bathing_water_measurements" || filters.length !== 1) {
    throw new AppError(
      "INVALID_REQUEST",
      "Only one measurements filter is supported: in_season eq <boolean>.",
    );
  }
  const filter = filters[0];
  if (
    filter === undefined ||
    filter.field !== "in_season" ||
    filter.operator !== "eq" ||
    typeof filter.value !== "boolean"
  ) {
    throw new AppError(
      "INVALID_REQUEST",
      "Only in_season eq <boolean> is supported for measurements.",
    );
  }
  return filter.value;
}

function pageUrl(
  endpoint: string,
  page: number,
  inSeason: boolean | undefined,
): string {
  const url = new URL(endpoint);
  url.searchParams.set("page", String(page));
  url.searchParams.set("per_page", String(UPSTREAM_PAGE_SIZE));
  if (inSeason !== undefined) {
    url.searchParams.set("in_season", String(inSeason));
  }
  return url.toString();
}

function project(
  row: Readonly<Record<string, unknown>>,
  selected: readonly string[],
): Readonly<Record<string, unknown>> {
  const projected: Record<string, unknown> = {};
  for (const field of selected) {
    if (Object.hasOwn(row, field)) {
      projected[field] = row[field];
    }
  }
  return projected;
}

function parsePage(value: unknown): UpstreamPage {
  if (!isRecord(value) || !Number.isInteger(value.count) || (value.count as number) < 0) {
    throw new AppError("UPSTREAM_ERROR");
  }
  if (!Array.isArray(value.list) || value.list.length > UPSTREAM_PAGE_SIZE) {
    throw new AppError("UPSTREAM_ERROR");
  }
  const list: Readonly<Record<string, unknown>>[] = [];
  for (const item of value.list) {
    if (!isRecord(item)) {
      throw new AppError("UPSTREAM_ERROR");
    }
    list.push(item);
  }
  return { count: value.count as number, list };
}

function validateSettings(settings: EpaSettings): void {
  if (
    settings.endpoints.locations !== EPA_LOCATIONS_ENDPOINT ||
    settings.endpoints.measurements !== EPA_MEASUREMENTS_ENDPOINT ||
    settings.endpoints.alerts !== EPA_ALERTS_ENDPOINT
  ) {
    throw new RangeError("EPA endpoints must be the official stable HTTPS collection URLs.");
  }
  requirePositiveInteger(settings.timeoutMs, "timeoutMs");
  requirePositiveInteger(settings.maxInputBytes, "maxInputBytes");
  requirePositiveInteger(settings.maxOutputBytes, "maxOutputBytes");
  requirePositiveInteger(settings.defaultLimit, "defaultLimit");
  requirePositiveInteger(settings.maxLimit, "maxLimit");
  if (
    settings.defaultLimit > settings.maxLimit ||
    settings.maxLimit > UPSTREAM_PAGE_SIZE
  ) {
    throw new RangeError("EPA pagination limits must satisfy defaultLimit <= maxLimit <= 100.");
  }
}

function requirePositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
