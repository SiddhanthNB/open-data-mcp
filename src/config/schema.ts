import { parse } from "yaml";
import { z } from "zod";

import {
  OPEN_METEO_HOURLY_FIELDS,
  PROVIDER_OPERATIONS,
  SOURCES,
  type Source,
} from "../models";

const positiveInteger = z.number().int().positive();
const httpsUrl = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.hash === ""
    );
  }, "URL must use HTTPS without credentials or a fragment");
const exactStringArray = <T extends readonly [string, ...string[]]>(
  values: T,
) => z.tuple(values.map((value) => z.literal(value)) as {
  [K in keyof T]: z.ZodLiteral<T[K]>;
});

const endpointPathSchema = z
  .string()
  .min(1)
  .startsWith("/")
  .refine((value) => !value.startsWith("//"), {
    message: "endpoint paths must start with exactly one slash",
  })
  .refine((value) => !value.includes("?"), {
    message: "endpoint paths must not contain query parameters",
  });

const ckanEndpointsSchema = z
  .object({
    package_search: endpointPathSchema,
    package_show: endpointPathSchema,
    datastore_search: endpointPathSchema,
  })
  .strict();

const paginationSchema = z
  .object({
    default_limit: positiveInteger,
    max_limit: positiveInteger.max(100),
  })
  .strict()
  .refine((value) => value.default_limit <= value.max_limit, {
    message: "default_limit must not exceed max_limit",
    path: ["default_limit"],
  });

const capabilitiesSchema = z
  .object(
    Object.fromEntries(
      PROVIDER_OPERATIONS.map((operation) => [operation, z.boolean()]),
    ) as Record<(typeof PROVIDER_OPERATIONS)[number], z.ZodBoolean>,
  )
  .strict();

const scopeSchema = z
  .object({
    organization_name: z.string().min(1),
    organization_id: z.string().min(1),
  })
  .strict();

const commonProviderFields = {
  enabled: z.boolean().default(true),
  authoritative: z.boolean(),
  coverage: z.string().trim().min(1),
  description: z.string().trim().min(1),
  http_timeout_ms: positiveInteger,
  pagination: paginationSchema,
  capabilities: capabilitiesSchema,
} as const;

const forecastBoundsSchema = z
  .object({
    min_latitude: z.number().finite().min(-90).max(90),
    max_latitude: z.number().finite().min(-90).max(90),
    min_longitude: z.number().finite().min(-180).max(180),
    max_longitude: z.number().finite().min(-180).max(180),
  })
  .strict()
  .refine((bounds) => bounds.min_latitude < bounds.max_latitude, {
    message: "min_latitude must be less than max_latitude",
    path: ["min_latitude"],
  })
  .refine((bounds) => bounds.min_longitude < bounds.max_longitude, {
    message: "min_longitude must be less than max_longitude",
    path: ["min_longitude"],
  });

const metForecastSchema = z
  .object({
    endpoint: z
      .string()
      .url()
      .refine(
        (value) =>
          value ===
          "http://openaccess.pf.api.met.ie/metno-wdb2ts/locationforecast",
        "forecast endpoint must be the official Met Eireann endpoint",
      ),
    bounds: forecastBoundsSchema,
  })
  .strict();

const catalogueProviderConfigSchema = z
  .object({
    provider: z.enum([
      "data_gov_ie",
      "smart_dublin",
      "met_eireann",
      "seai",
      "open_data_ni",
    ]),
    type: z.literal("catalogue"),
    ...commonProviderFields,
    base_url: httpsUrl.refine((value) => !value.endsWith("/"), {
      message: "base_url must not end with a slash",
    }),
    endpoints: ckanEndpointsSchema,
    formats: exactStringArray(["csv", "json", "xml"]),
    scope: scopeSchema.optional(),
    forecast: metForecastSchema.optional(),
  })
  .strict()
  .superRefine((config, context) => {
    const endpointsAreStandard =
      config.endpoints.package_search === "/api/3/action/package_search" &&
      config.endpoints.package_show === "/api/3/action/package_show" &&
      config.endpoints.datastore_search ===
        "/api/3/action/datastore_search";
    if (config.provider === "met_eireann") {
      if (config.scope === undefined) {
        context.addIssue({
          code: "custom",
          message: "met_eireann requires an organization scope",
          path: ["scope"],
        });
      }
      if (config.forecast === undefined) {
        context.addIssue({
          code: "custom",
          message: "met_eireann requires forecast settings",
          path: ["forecast"],
        });
      }
    } else if (config.forecast !== undefined) {
      context.addIssue({
        code: "custom",
        message: "forecast settings are only supported for met_eireann",
        path: ["forecast"],
      });
    }

    if (config.provider === "seai") {
      if (
        config.base_url !== "https://data.gov.ie" ||
        !endpointsAreStandard ||
        config.scope?.organization_name !==
          "sustainable-energy-authority-of-ireland" ||
        config.scope.organization_id !==
          "sustainable-energy-authority-of-ireland"
      ) {
        context.addIssue({
          code: "custom",
          message: "seai must use its exact data.gov.ie organization scope",
          path: ["scope"],
        });
      }
    } else if (
      config.provider !== "met_eireann" &&
      config.scope !== undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "organization scope is only supported for met_eireann and seai",
        path: ["scope"],
      });
    }

    if (
      config.provider === "open_data_ni" &&
      (config.base_url !== "https://admin.opendatani.gov.uk" ||
        !endpointsAreStandard)
    ) {
      context.addIssue({
        code: "custom",
        message: "open_data_ni must use the official OpenDataNI CKAN origin",
        path: ["base_url"],
      });
    }
  });

const openMeteoForecastSchema = z
  .object({
    data_id: z.literal("weather_forecast"),
    access_id: z.literal("hourly_forecast"),
    endpoint: z.literal("https://api.open-meteo.com/v1/forecast"),
    model: z.literal("ecmwf_ifs"),
    horizon_days: positiveInteger.max(15),
    allowed_hourly_fields: z
      .array(z.enum(OPEN_METEO_HOURLY_FIELDS))
      .min(1)
      .refine((fields) => new Set(fields).size === fields.length, {
        message: "allowed_hourly_fields must not contain duplicates",
      }),
    max_fields: z.literal(10),
    timezone: z.literal("GMT"),
    timeformat: z.literal("iso8601"),
    temperature_unit: z.literal("celsius"),
    wind_speed_unit: z.literal("kmh"),
    precipitation_unit: z.literal("mm"),
    cell_selection: z.literal("land"),
    attribution: z
      .object({
        provider: z.string().trim().min(1),
        weather_model: z.string().trim().min(1),
        licence: z.string().trim().min(1),
        url: httpsUrl,
      })
      .strict(),
  })
  .strict()
  .refine(
    (forecast) =>
      forecast.max_fields <= forecast.allowed_hourly_fields.length,
    {
      message: "max_fields must not exceed the allowlisted field count",
      path: ["max_fields"],
    },
  );

const forecastApiProviderConfigSchema = z
  .object({
    provider: z.literal("open_meteo_ie"),
    type: z.literal("forecast_api"),
    ...commonProviderFields,
    base_url: z.literal("https://api.open-meteo.com"),
    endpoints: z.object({ forecast: endpointPathSchema }).strict(),
    formats: exactStringArray(["json"]),
    forecast: openMeteoForecastSchema,
  })
  .strict()
  .superRefine((config, context) => {
    const resolved = new URL(
      config.endpoints.forecast,
      config.base_url,
    ).toString();
    if (resolved !== config.forecast.endpoint) {
      context.addIssue({
        code: "custom",
        message: "forecast endpoint must match base_url and endpoints.forecast",
        path: ["forecast", "endpoint"],
      });
    }
  });

const csoPxStatConfigSchema = z
  .object({
    provider: z.literal("cso_pxstat"),
    type: z.literal("statistical_cube"),
    ...commonProviderFields,
    base_url: z.literal("https://ws.cso.ie/public/api.restful"),
    endpoints: z
      .object({
        json_rpc: z.literal("https://ws.cso.ie/public/api.jsonrpc"),
        restful: z.literal("https://ws.cso.ie/public/api.restful"),
      })
      .strict(),
    formats: exactStringArray(["json-stat2", "json-stat1", "csv", "px", "xlsx"]),
    methods: z
      .object({
        search: z.literal("PxStat.System.Navigation.Navigation_API.Search"),
        read_dataset: z.literal("PxStat.Data.Cube_API.ReadDataset"),
      })
      .strict(),
    language: z.literal("en"),
    search_result_limit: positiveInteger.max(100),
    max_dimension_values: positiveInteger,
    max_cells: positiveInteger.max(100),
  })
  .strict();

const marineConfigSchema = z
  .object({
    provider: z.literal("marine_institute"),
    type: z.literal("erddap"),
    ...commonProviderFields,
    base_url: z.literal("https://erddap.marine.ie/erddap"),
    endpoints: z
      .object({
        search: z.literal("/search/index.json"),
        info: z.literal("/info"),
        tabledap: z.literal("/tabledap"),
        griddap: z.literal("/griddap"),
        files: z.literal("/files"),
      })
      .strict(),
    formats: exactStringArray(["json", "netcdf", "csv"]),
    max_schema_fields: positiveInteger,
    max_selected_fields: positiveInteger,
  })
  .strict()
  .refine(
    (config) => config.max_selected_fields <= config.max_schema_fields,
    {
      message: "max_selected_fields must not exceed max_schema_fields",
      path: ["max_selected_fields"],
    },
  );

const exactHost = z
  .string()
  .regex(/^[a-z0-9.-]+$/u)
  .refine(
    (value) =>
      !value.startsWith(".") && !value.endsWith(".") && !value.includes(".."),
    "host must be an exact hostname",
  );
const exactHostList = z
  .array(exactHost)
  .min(1)
  .refine((values) => new Set(values).size === values.length, {
    message: "hosts must be unique",
  });

const geohiveConfigSchema = z
  .object({
    provider: z.literal("geohive"),
    type: z.literal("geospatial_catalogue"),
    ...commonProviderFields,
    base_url: z.literal("https://ga.geohive.ie"),
    endpoints: z
      .object({
        catalogue_origin: z.literal("https://ga.geohive.ie"),
        portal_origin: z.literal("https://www.arcgis.com"),
      })
      .strict(),
    formats: exactStringArray(["json", "wms"]),
    allowed_arcgis_hosts: exactHostList,
    allowed_wms_hosts: exactHostList,
    max_layers: positiveInteger,
    max_schema_fields: positiveInteger,
    max_selected_fields: positiveInteger,
  })
  .strict()
  .superRefine((config, context) => {
    const allowed = [
      ...config.allowed_arcgis_hosts,
      ...config.allowed_wms_hosts,
    ];
    const expected = [
      "atlas.marine.ie",
      "gis.epa.ie",
      "gsi.geodata.gov.ie",
      "services-eu1.arcgis.com",
      "services.arcgis.com",
      "services1.arcgis.com",
      "services3.arcgis.com",
      "services7.arcgis.com",
      "utility.arcgis.com",
      "www.floodinfo.ie",
    ];
    if (
      config.max_selected_fields > config.max_schema_fields ||
      new Set(allowed).size !== expected.length ||
      expected.some((host) => !allowed.includes(host))
    ) {
      context.addIssue({
        code: "custom",
        message: "GeoHive limits or exact upstream host allowlist are invalid",
      });
    }
  });

const opwSensorSchema = z
  .object({
    access_id: z.enum([
      "water_level",
      "ordnance_datum",
      "temperature",
      "battery_voltage",
      "backup_water_level",
    ]),
    code: z.enum(["0001", "OD", "0002", "0003", "0011"]),
    title: z.string().min(1),
    unit: z.enum(["m", "°C", "V"]),
    value_column: z.enum(["value", "backup_value"]),
    caveat: z.string().min(1),
  })
  .strict();

const opwConfigSchema = z
  .object({
    provider: z.literal("opw"),
    type: z.literal("station_timeseries"),
    ...commonProviderFields,
    base_url: z.literal("https://waterlevel.ie"),
    endpoints: z
      .object({
        stations: z.literal("https://waterlevel.ie/geojson/"),
        latest: z.literal("https://waterlevel.ie/geojson/latest/"),
        data_base: z.literal("https://waterlevel.ie/data/"),
      })
      .strict(),
    formats: exactStringArray(["csv", "geojson"]),
    sensors: z.array(opwSensorSchema).length(5),
    rolling_window_days: z.literal(35),
    cache_ttl_seconds: z.literal(900),
  })
  .strict()
  .superRefine((config, context) => {
    const expected = {
      water_level: ["0001", "m", "value"],
      ordnance_datum: ["OD", "m", "value"],
      temperature: ["0002", "°C", "value"],
      battery_voltage: ["0003", "V", "value"],
      backup_water_level: ["0011", "m", "backup_value"],
    } as const;
    if (
      new Set(config.sensors.map((sensor) => sensor.access_id)).size !== 5 ||
      config.sensors.some((sensor) => {
        const setting = expected[sensor.access_id];
        return (
          sensor.code !== setting[0] ||
          sensor.unit !== setting[1] ||
          sensor.value_column !== setting[2]
        );
      })
    ) {
      context.addIssue({
        code: "custom",
        message: "OPW sensors must match the documented sensor allowlist",
        path: ["sensors"],
      });
    }
  });

const epaConfigSchema = z
  .object({
    provider: z.literal("epa"),
    type: z.literal("domain_api"),
    ...commonProviderFields,
    base_url: z.literal("https://data.epa.ie"),
    endpoints: z
      .object({
        locations: z.literal("https://data.epa.ie/bw/api/v1/locations"),
        measurements: z.literal(
          "https://data.epa.ie/bw/api/v1/measurements",
        ),
        alerts: z.literal("https://data.epa.ie/bw/api/v1/alerts"),
      })
      .strict(),
    formats: exactStringArray(["json"]),
  })
  .strict();

const tfiConfigSchema = z
  .object({
    provider: z.literal("tfi_nta"),
    type: z.literal("transport_feeds"),
    ...commonProviderFields,
    base_url: z.literal("https://www.transportforireland.ie"),
    endpoints: z
      .object({
        static_gtfs: z.literal(
          "https://www.transportforireland.ie/transitData/Data/GTFS_Realtime.zip",
        ),
        developer_portal: z.literal(
          "https://developer.nationaltransport.ie/",
        ),
      })
      .strict(),
    formats: exactStringArray(["zip", "gtfs-realtime"]),
  })
  .strict()
  .refine((config) => !config.capabilities.query_data_by_id, {
    message: "TFI realtime querying must remain disabled",
    path: ["capabilities", "query_data_by_id"],
  });

const eirgridDatasetSchema = z.discriminatedUnion("kind", [
  z
    .object({
      data_id: z.enum(["wind_generation", "solar_generation"]),
      title: z.string().min(1),
      description: z.string().min(1),
      kind: z.literal("variable_generation"),
      area: z.enum(["WIND", "SOLAR"]),
      endpoint_template: z.literal(
        "https://www.vargen.smartgriddashboard.com/api/export/{start}/{end}/{region}/{area}?FORMAT=JSON",
      ),
    })
    .strict(),
  z
    .object({
      data_id: z.literal("interconnector_flows"),
      title: z.string().min(1),
      description: z.string().min(1),
      kind: z.literal("interconnector"),
      endpoint_template: z.literal(
        "https://www.interconn.smartgriddashboard.com/api/Interconnector/{start}/{end}/ALL?format=json",
      ),
      allowed_field_names: z.tuple([
        z.literal("INTER_EWIC"),
        z.literal("INTER_GRNLK"),
        z.literal("INTER_MOYLE"),
        z.literal("INTER_NET"),
      ]),
    })
    .strict(),
]);

const eirgridConfigSchema = z
  .object({
    provider: z.literal("eirgrid"),
    type: z.literal("energy_api"),
    ...commonProviderFields,
    base_url: z.literal("https://www.smartgriddashboard.com"),
    endpoints: z
      .object({
        variable_generation: z.literal(
          "https://www.vargen.smartgriddashboard.com/api/export/{start}/{end}/{region}/{area}?FORMAT=JSON",
        ),
        interconnector: z.literal(
          "https://www.interconn.smartgriddashboard.com/api/Interconnector/{start}/{end}/ALL?format=json",
        ),
      })
      .strict(),
    formats: exactStringArray(["json"]),
    access_id: z.literal("quarter_hourly"),
    attribution: z.literal("Supported by EirGrid Group Data"),
    datasets: z.array(eirgridDatasetSchema).length(3),
  })
  .strict()
  .superRefine((config, context) => {
    const ids = config.datasets.map((dataset) => dataset.data_id);
    const wind = config.datasets.find(
      (dataset) => dataset.data_id === "wind_generation",
    );
    const solar = config.datasets.find(
      (dataset) => dataset.data_id === "solar_generation",
    );
    if (
      new Set(ids).size !== 3 ||
      !ids.includes("interconnector_flows") ||
      wind?.kind !== "variable_generation" ||
      wind.area !== "WIND" ||
      solar?.kind !== "variable_generation" ||
      solar.area !== "SOLAR"
    ) {
      context.addIssue({
        code: "custom",
        message: "EirGrid datasets must match the three configured series",
        path: ["datasets"],
      });
    }
  });

const providerConfigSchema = z.discriminatedUnion("type", [
  catalogueProviderConfigSchema,
  forecastApiProviderConfigSchema,
  csoPxStatConfigSchema,
  marineConfigSchema,
  geohiveConfigSchema,
  opwConfigSchema,
  epaConfigSchema,
  tfiConfigSchema,
  eirgridConfigSchema,
]);

export interface CkanEndpoints {
  readonly [endpoint: string]: string;
  readonly package_search: string;
  readonly package_show: string;
  readonly datastore_search: string;
}

export interface ProviderScope {
  readonly organization_name: string;
  readonly organization_id: string;
}

export type LoadedProviderConfig = Readonly<
  z.infer<typeof providerConfigSchema>
>;
type CatalogueSource =
  | "data_gov_ie"
  | "smart_dublin"
  | "met_eireann"
  | "seai"
  | "open_data_ni";
export type LoadedProviderConfigFor<S extends Source> =
  S extends CatalogueSource
    ? LoadedCatalogueProviderConfig & { readonly provider: S }
    : Extract<LoadedProviderConfig, { provider: S }>;
export type LoadedProviderConfigs = {
  readonly [S in Source]: LoadedProviderConfigFor<S>;
};
export type LoadedCatalogueProviderConfig = Extract<
  LoadedProviderConfig,
  { type: "catalogue" }
>;
export type LoadedForecastApiProviderConfig = Extract<
  LoadedProviderConfig,
  { type: "forecast_api" }
>;

export interface ProviderConfigDocument {
  readonly expectedProvider: Source;
  readonly contents: string;
}

export class ProviderConfigError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProviderConfigError";
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }

  return value;
}

export function parseProviderConfig(
  contents: string,
  expectedProvider: Source,
): LoadedProviderConfig {
  let document: unknown;

  try {
    document = parse(contents);
  } catch (cause) {
    throw new ProviderConfigError(
      `Invalid YAML for provider ${expectedProvider}`,
      { cause },
    );
  }

  const result = providerConfigSchema.safeParse(document);
  if (!result.success) {
    throw new ProviderConfigError(
      `Invalid configuration for provider ${expectedProvider}: ${z.prettifyError(result.error)}`,
      { cause: result.error },
    );
  }

  if (result.data.provider !== expectedProvider) {
    throw new ProviderConfigError(
      `Provider mismatch: expected ${expectedProvider}, received ${result.data.provider}`,
    );
  }

  return deepFreeze(result.data);
}

export function loadProviderConfigs(
  documents: readonly ProviderConfigDocument[],
): LoadedProviderConfigs {
  const configs = new Map<Source, LoadedProviderConfig>();

  for (const document of documents) {
    if (configs.has(document.expectedProvider)) {
      throw new ProviderConfigError(
        `Duplicate configuration for provider ${document.expectedProvider}`,
      );
    }

    configs.set(
      document.expectedProvider,
      parseProviderConfig(document.contents, document.expectedProvider),
    );
  }

  const missingProviders = SOURCES.filter((source) => !configs.has(source));
  if (missingProviders.length > 0) {
    throw new ProviderConfigError(
      `Missing configuration for provider(s): ${missingProviders.join(", ")}`,
    );
  }

  return deepFreeze(
    Object.fromEntries(configs) as LoadedProviderConfigs,
  );
}
