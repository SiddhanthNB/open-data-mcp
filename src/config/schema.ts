import { parse } from "yaml";
import { z } from "zod";

import {
  OPEN_METEO_HOURLY_FIELDS,
  PROVIDER_OPERATIONS,
  SOURCES,
  type CatalogueProviderConfig,
  type ForecastApiProviderConfig,
  type Source,
} from "../models";

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

const endpointsSchema = z
  .object({
    package_search: endpointPathSchema,
    package_show: endpointPathSchema,
    datastore_search: endpointPathSchema,
  })
  .strict();

const paginationSchema = z
  .object({
    default_limit: z.number().int().positive(),
    max_limit: z.number().int().positive(),
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

const formatsSchema = z
  .array(z.enum(["csv", "json", "xml"]))
  .min(1)
  .refine((formats) => new Set(formats).size === formats.length, {
    message: "formats must not contain duplicates",
  });

const scopeSchema = z
  .object({
    organization_name: z.string().min(1),
    organization_id: z.string().min(1),
  })
  .strict();

const commonProviderFields = {
  authoritative: z.boolean(),
  coverage: z.string().trim().min(1),
  description: z.string().trim().min(1),
  base_url: z
    .string()
    .url()
    .refine((value) => new URL(value).protocol === "https:", {
      message: "base_url must use HTTPS",
    })
    .refine((value) => !value.endsWith("/"), {
      message: "base_url must not end with a slash",
    }),
  http_timeout_ms: z.number().int().positive(),
  pagination: paginationSchema,
  capabilities: capabilitiesSchema,
  formats: formatsSchema,
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
      .refine((value) => {
        const url = new URL(value);
        return (
          url.username === "" &&
          url.password === "" &&
          url.search === "" &&
          url.hash === "" &&
          (url.protocol === "https:" ||
            value ===
              "http://openaccess.pf.api.met.ie/metno-wdb2ts/locationforecast")
        );
      }, {
        message:
          "forecast endpoint must use HTTPS or the official Met Eireann HTTP endpoint",
      }),
    bounds: forecastBoundsSchema,
  })
  .strict();

const catalogueProviderConfigSchema = z
  .object({
    provider: z.enum(["data_gov_ie", "smart_dublin", "met_eireann"]),
    type: z.literal("catalogue"),
    ...commonProviderFields,
    endpoints: endpointsSchema,
    scope: scopeSchema.optional(),
    forecast: metForecastSchema.optional(),
  })
  .strict()
  .superRefine((config, context) => {
    if (config.provider === "met_eireann" && config.scope === undefined) {
      context.addIssue({
        code: "custom",
        message: "met_eireann requires an organization scope",
        path: ["scope"],
      });
    }

    if (config.provider === "met_eireann" && config.forecast === undefined) {
      context.addIssue({
        code: "custom",
        message: "met_eireann requires forecast settings",
        path: ["forecast"],
      });
    }

    if (config.provider !== "met_eireann" && config.scope !== undefined) {
      context.addIssue({
        code: "custom",
        message: "organization scope is only supported for met_eireann",
        path: ["scope"],
      });
    }

    if (config.provider !== "met_eireann" && config.forecast !== undefined) {
      context.addIssue({
        code: "custom",
        message: "forecast settings are only supported for met_eireann",
        path: ["forecast"],
      });
    }
  });

const openMeteoForecastSchema = z
  .object({
    data_id: z.literal("weather_forecast"),
    access_id: z.literal("hourly_forecast"),
    endpoint: z.literal("https://api.open-meteo.com/v1/forecast"),
    model: z.literal("ecmwf_ifs"),
    horizon_days: z.number().int().positive().max(15),
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
        url: z
          .string()
          .url()
          .refine((value) => new URL(value).protocol === "https:", {
            message: "attribution URL must use HTTPS",
          }),
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
    endpoints: z.object({ forecast: endpointPathSchema }).strict(),
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

const providerConfigSchema = z.discriminatedUnion("type", [
  catalogueProviderConfigSchema,
  forecastApiProviderConfigSchema,
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

export type LoadedCatalogueProviderConfig = Readonly<
  CatalogueProviderConfig &
    Required<
      Pick<
        CatalogueProviderConfig,
        "authoritative" | "coverage" | "description"
      >
    > &
    { readonly endpoints: CkanEndpoints }
>;

export type LoadedForecastApiProviderConfig = Readonly<
  ForecastApiProviderConfig &
    Required<
      Pick<
        ForecastApiProviderConfig,
        "authoritative" | "coverage" | "description"
      >
    >
>;

export type LoadedProviderConfig =
  | LoadedCatalogueProviderConfig
  | LoadedForecastApiProviderConfig;

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
): Readonly<Record<Source, LoadedProviderConfig>> {
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
    Object.fromEntries(configs) as Record<Source, LoadedProviderConfig>,
  );
}
