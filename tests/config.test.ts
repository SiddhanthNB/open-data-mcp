import { describe, expect, it } from "vitest";

import {
  getProviderConfig,
  loadProviderConfigs,
  parseProviderConfig,
  providerConfigs,
  ProviderConfigError,
} from "../src/config";
import type { Source } from "../src/models";

function validConfig(provider: Source): string {
  if (provider === "open_meteo_ie") {
    return `
provider: open_meteo_ie
type: forecast_api
authoritative: false
coverage: Republic of Ireland point queries only
description: Non-authoritative model forecast.
base_url: https://api.open-meteo.com
endpoints:
  forecast: /v1/forecast
http_timeout_ms: 10000
pagination:
  default_limit: 24
  max_limit: 100
capabilities:
  search_data_by_source: true
  describe_data_by_id: true
  query_data_by_id: true
  get_data_link_by_id: false
formats:
  - json
forecast:
  data_id: weather_forecast
  access_id: hourly_forecast
  endpoint: https://api.open-meteo.com/v1/forecast
  model: ecmwf_ifs
  horizon_days: 15
  allowed_hourly_fields:
    - temperature_2m
    - precipitation
    - wind_speed_10m
    - weather_code
    - relative_humidity_2m
    - apparent_temperature
    - rain
    - showers
    - snowfall
    - pressure_msl
  max_fields: 10
  timezone: GMT
  timeformat: iso8601
  temperature_unit: celsius
  wind_speed_unit: kmh
  precipitation_unit: mm
  cell_selection: land
  attribution:
    provider: Open-Meteo
    weather_model: ECMWF IFS HRES 9 km
    licence: CC BY 4.0
    url: https://open-meteo.com/
`;
  }

  const scope =
    provider === "met_eireann"
      ? `
scope:
  organization_name: meteireann
  organization_id: met-eireann
forecast:
  endpoint: http://openaccess.pf.api.met.ie/metno-wdb2ts/locationforecast
  bounds:
    min_latitude: 51.3
    max_latitude: 55.5
    min_longitude: -11
    max_longitude: -5.2`
      : "";

  return `
provider: ${provider}
type: catalogue
authoritative: true
coverage: Republic of Ireland
description: Test catalogue.
base_url: https://example.test
endpoints:
  package_search: /api/3/action/package_search
  package_show: /api/3/action/package_show
  datastore_search: /api/3/action/datastore_search
http_timeout_ms: 10000
pagination:
  default_limit: 10
  max_limit: 100
capabilities:
  search_data_by_source: true
  describe_data_by_id: true
  query_data_by_id: true
  get_data_link_by_id: true
formats:
  - csv
  - json
  - xml${scope}
`;
}

function allDocuments() {
  return [
    {
      expectedProvider: "data_gov_ie" as const,
      contents: validConfig("data_gov_ie"),
    },
    {
      expectedProvider: "smart_dublin" as const,
      contents: validConfig("smart_dublin"),
    },
    {
      expectedProvider: "met_eireann" as const,
      contents: validConfig("met_eireann"),
    },
    {
      expectedProvider: "open_meteo_ie" as const,
      contents: validConfig("open_meteo_ie"),
    },
  ];
}

describe("provider configuration", () => {
  it("loads the four bundled provider configurations", () => {
    expect(Object.keys(providerConfigs)).toEqual([
      "data_gov_ie",
      "smart_dublin",
      "met_eireann",
      "open_meteo_ie",
    ]);
    expect(getProviderConfig("data_gov_ie")).toMatchObject({
      type: "catalogue",
      base_url: "https://data.gov.ie",
      http_timeout_ms: 10_000,
      pagination: { default_limit: 10, max_limit: 100 },
      capabilities: {
        search_data_by_source: true,
        describe_data_by_id: true,
        query_data_by_id: true,
        get_data_link_by_id: true,
      },
    });
    expect(getProviderConfig("smart_dublin").base_url).toBe(
      "https://data.smartdublin.ie",
    );
    expect(getProviderConfig("met_eireann").scope).toEqual({
      organization_name: "meteireann",
      organization_id: "met-eireann",
    });
    expect(getProviderConfig("met_eireann").forecast).toMatchObject({
      endpoint:
        "http://openaccess.pf.api.met.ie/metno-wdb2ts/locationforecast",
    });
    expect(getProviderConfig("open_meteo_ie")).toMatchObject({
      type: "forecast_api",
      authoritative: false,
      coverage: "Republic of Ireland point queries only",
      forecast: {
        endpoint: "https://api.open-meteo.com/v1/forecast",
        model: "ecmwf_ifs",
        horizon_days: 15,
        max_fields: 10,
      },
    });
  });

  it("returns deeply immutable configuration", () => {
    const config = getProviderConfig("data_gov_ie");

    expect(Object.isFrozen(providerConfigs)).toBe(true);
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.endpoints)).toBe(true);
    expect(Object.isFrozen(config.pagination)).toBe(true);
    expect(Object.isFrozen(config.capabilities)).toBe(true);
    expect(Object.isFrozen(config.formats)).toBe(true);
    expect(Object.isFrozen(getProviderConfig("open_meteo_ie").forecast)).toBe(
      true,
    );
  });

  it("rejects invalid YAML", () => {
    expect(() => parseProviderConfig("provider: [", "data_gov_ie")).toThrow(
      new ProviderConfigError("Invalid YAML for provider data_gov_ie"),
    );
  });

  it("rejects invalid or unknown schema fields", () => {
    const invalid = `${validConfig("data_gov_ie")}unknown: true\n`;

    expect(() => parseProviderConfig(invalid, "data_gov_ie")).toThrow(
      /Invalid configuration for provider data_gov_ie/,
    );
  });

  it("rejects protocol-relative endpoint paths", () => {
    const invalid = validConfig("data_gov_ie").replace(
      "/api/3/action/package_search",
      "//other-host/package_search",
    );

    expect(() => parseProviderConfig(invalid, "data_gov_ie")).toThrow(
      /endpoint paths must start with exactly one slash/,
    );
  });

  it("rejects non-HTTPS catalogue base URLs", () => {
    const invalid = validConfig("data_gov_ie").replace(
      "https://example.test",
      "http://example.test",
    );

    expect(() => parseProviderConfig(invalid, "data_gov_ie")).toThrow(
      /base_url must use HTTPS/,
    );
  });

  it("allows only the exact official HTTP Met Eireann forecast endpoint", () => {
    const invalid = validConfig("met_eireann").replace(
      "http://openaccess.pf.api.met.ie/metno-wdb2ts/locationforecast",
      "http://example.test/forecast",
    );

    expect(() => parseProviderConfig(invalid, "met_eireann")).toThrow(
      /Invalid configuration for provider met_eireann/,
    );
  });

  it("rejects Open-Meteo endpoint divergence", () => {
    const invalid = validConfig("open_meteo_ie").replace(
      "  forecast: /v1/forecast",
      "  forecast: /v1/other",
    );

    expect(() => parseProviderConfig(invalid, "open_meteo_ie")).toThrow(
      /forecast endpoint must match base_url/,
    );
  });

  it("rejects a provider that does not match its expected source", () => {
    expect(() =>
      parseProviderConfig(validConfig("smart_dublin"), "data_gov_ie"),
    ).toThrow(
      "Provider mismatch: expected data_gov_ie, received smart_dublin",
    );
  });

  it("rejects duplicate provider documents", () => {
    const documents = allDocuments();
    documents.push({
      expectedProvider: "data_gov_ie",
      contents: validConfig("data_gov_ie"),
    });

    expect(() => loadProviderConfigs(documents)).toThrow(
      "Duplicate configuration for provider data_gov_ie",
    );
  });

  it("rejects incomplete provider document sets", () => {
    expect(() => loadProviderConfigs(allDocuments().slice(0, 3))).toThrow(
      "Missing configuration for provider(s): open_meteo_ie",
    );
  });
});
