export const SOURCES = [
  "data_gov_ie",
  "smart_dublin",
  "met_eireann",
  "open_meteo_ie",
  "cso_pxstat",
  "marine_institute",
  "geohive",
  "opw",
  "epa",
  "tfi_nta",
  "seai",
  "eirgrid",
  "open_data_ni",
] as const;

export type Source = (typeof SOURCES)[number];

export const PROVIDER_OPERATIONS = [
  "search_data_by_source",
  "describe_data_by_id",
  "query_data_by_id",
  "get_data_link_by_id",
] as const;

export type ProviderOperation = (typeof PROVIDER_OPERATIONS)[number];

export type ResourceFormat = "csv" | "json" | "xml";

export const PROVIDER_TYPES = [
  "catalogue",
  "forecast_api",
  "statistical_cube",
  "erddap",
  "geospatial_catalogue",
  "station_timeseries",
  "domain_api",
  "transport_feeds",
  "energy_api",
] as const;

export type ProviderType = (typeof PROVIDER_TYPES)[number];

export const OPEN_METEO_HOURLY_FIELDS = [
  "temperature_2m",
  "relative_humidity_2m",
  "apparent_temperature",
  "precipitation",
  "rain",
  "showers",
  "snowfall",
  "weather_code",
  "pressure_msl",
  "cloud_cover",
  "visibility",
  "wind_speed_10m",
  "wind_direction_10m",
  "wind_gusts_10m",
] as const;

export type OpenMeteoHourlyField =
  (typeof OPEN_METEO_HOURLY_FIELDS)[number];

export interface ProviderCapabilities {
  search_data_by_source: boolean;
  describe_data_by_id: boolean;
  query_data_by_id: boolean;
  get_data_link_by_id: boolean;
}

export interface BaseProviderConfig {
  provider: Source;
  type: ProviderType;
  enabled?: boolean;
  base_url: string;
  endpoints: Readonly<Record<string, string>>;
  http_timeout_ms: number;
  pagination: {
    default_limit: number;
    max_limit: number;
  };
  capabilities: ProviderCapabilities;
  formats: readonly string[];
  authoritative?: boolean;
  coverage?: string;
  description?: string;
  scope?: {
    organization_name: string;
    organization_id: string;
  };
  forecast?: unknown;
}

export interface MetEireannPointForecastConfig {
  endpoint: string;
  bounds: {
    min_latitude: number;
    max_latitude: number;
    min_longitude: number;
    max_longitude: number;
  };
}

export interface CatalogueProviderConfig extends BaseProviderConfig {
  type: "catalogue";
  scope?: {
    organization_name: string;
    organization_id: string;
  };
  forecast?: MetEireannPointForecastConfig;
}

export interface ForecastApiProviderConfig extends BaseProviderConfig {
  provider: "open_meteo_ie";
  type: "forecast_api";
  endpoints: Readonly<Record<string, string> & { forecast: string }>;
  forecast: {
    data_id: string;
    access_id: string;
    endpoint: string;
    model: "ecmwf_ifs";
    horizon_days: number;
    allowed_hourly_fields: readonly OpenMeteoHourlyField[];
    max_fields: number;
    timezone: "GMT";
    timeformat: "iso8601";
    temperature_unit: "celsius";
    wind_speed_unit: "kmh";
    precipitation_unit: "mm";
    cell_selection: "land";
    attribution: {
      provider: string;
      weather_model: string;
      licence: string;
      url: string;
    };
  };
  scope?: never;
}

export interface GenericProviderConfig extends BaseProviderConfig {
  type: Exclude<ProviderType, "catalogue" | "forecast_api">;
}

export type ProviderConfig =
  | CatalogueProviderConfig
  | ForecastApiProviderConfig
  | GenericProviderConfig;

export interface Provenance {
  source: Source;
  upstream_url: string;
  retrieved_at: string;
  original_format?: string;
}

export interface Pagination {
  limit: number;
  offset: number;
  returned: number;
  total?: number;
}

export interface DataSummary {
  data_id: string;
  title: string;
  description?: string;
  publisher?: string;
  available_formats?: readonly string[];
  provenance: Provenance;
}

export interface AccessPoint {
  access_id: string;
  title?: string;
  description?: string;
  format: string;
  capabilities: {
    query: boolean;
    link: boolean;
  };
  query_schema?: QuerySchema;
  size?: number;
  last_modified?: string;
  upstream_url: string;
}

export interface DataDescription extends DataSummary {
  licence?: string;
  tags?: readonly string[];
  access_points: readonly AccessPoint[];
}

export interface QueryDataResult {
  data_id: string;
  access_id: string;
  data: unknown;
  provenance: Provenance & { original_format: string };
  pagination_supported: boolean;
  pagination?: Pagination;
  truncated?: boolean;
}

export interface SpatialPoint {
  type: "point";
  latitude: number;
  longitude: number;
}

export interface SpatialBoundingBox {
  type: "bbox";
  west: number;
  south: number;
  east: number;
  north: number;
}

export type SpatialQuery = SpatialPoint | SpatialBoundingBox;

export const QUERY_FILTER_OPERATORS = [
  "eq",
  "in",
  "lt",
  "lte",
  "gt",
  "gte",
] as const;

export type QueryFilterOperator = (typeof QUERY_FILTER_OPERATORS)[number];
export type QueryFilterScalar = string | number | boolean;

export type QueryFilter =
  | {
      field: string;
      operator: "in";
      value: readonly QueryFilterScalar[];
    }
  | {
      field: string;
      operator: Exclude<QueryFilterOperator, "in">;
      value: QueryFilterScalar;
    };

export interface QueryValueOption {
  value: QueryFilterScalar;
  label?: string;
}

export interface QueryFieldDescription {
  name: string;
  label?: string;
  type: "string" | "number" | "boolean" | "datetime";
  operators: readonly QueryFilterOperator[];
  values?: readonly QueryValueOption[];
  values_truncated?: boolean;
}

export const QUERY_SELECTORS = [
  "fields",
  "filters",
  "spatial",
  "time_range",
] as const;

export type QuerySelector = (typeof QUERY_SELECTORS)[number];

export interface QuerySchema {
  fields: readonly QueryFieldDescription[];
  truncated: boolean;
  spatial?: readonly SpatialQuery["type"][];
  supported_selectors?: readonly QuerySelector[];
  required_selectors?: readonly QuerySelector[];
}

export interface TimeRange {
  start: string;
  end: string;
}

export interface QuerySelectors {
  fields?: readonly string[];
  filters?: readonly QueryFilter[];
  spatial?: SpatialQuery;
  time_range?: TimeRange;
}

export interface DataSearchResult {
  results: readonly DataSummary[];
  pagination: Pagination;
}

export interface DataLink {
  data_id: string;
  access_id: string;
  url: string;
  format: string;
  title?: string;
  description?: string;
  size?: number;
  last_modified?: string;
  provenance: Provenance & { original_format: string };
}

export interface SourceDescription {
  source: Source;
  type: ProviderConfig["type"];
  authoritative: boolean;
  coverage: string;
  description: string;
  capabilities: ProviderCapabilities;
  formats: readonly string[];
  limits: {
    default: number;
    maximum: number;
  };
}

export function isSource(value: string): value is Source {
  return SOURCES.some((source) => source === value);
}
