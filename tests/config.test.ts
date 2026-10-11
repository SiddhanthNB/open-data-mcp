import { describe, expect, it } from "vitest";
import { stringify } from "yaml";

import {
  getProviderConfig,
  loadProviderConfigs,
  parseProviderConfig,
  providerConfigs,
  ProviderConfigError,
} from "../src/config";
import { SOURCES, type Source } from "../src/models";

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
  return SOURCES.map((expectedProvider) => ({
    expectedProvider,
    contents: stringify(providerConfigs[expectedProvider]),
  }));
}

describe("provider configuration", () => {
  it("loads every bundled provider configuration", () => {
    expect(Object.keys(providerConfigs)).toEqual(SOURCES);
    expect(getProviderConfig("data_gov_ie")).toMatchObject({
      enabled: true,
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
      enabled: true,
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
    expect(getProviderConfig("seai")).toMatchObject({
      type: "catalogue",
      base_url: "https://data.gov.ie",
      scope: {
        organization_name: "sustainable-energy-authority-of-ireland",
        organization_id: "sustainable-energy-authority-of-ireland",
      },
    });
    expect(getProviderConfig("open_data_ni")).toMatchObject({
      base_url: "https://admin.opendatani.gov.uk",
      coverage: "Northern Ireland, United Kingdom",
    });
    expect(getProviderConfig("tfi_nta").capabilities.query_data_by_id).toBe(
      false,
    );
    expect([
      ...getProviderConfig("geohive").allowed_arcgis_hosts,
      ...getProviderConfig("geohive").allowed_wms_hosts,
    ]).toHaveLength(10);
    expect(getProviderConfig("eirgrid")).toMatchObject({
      coverage: "Republic of Ireland, Northern Ireland, or all-island as selected",
      access_id: "quarter_hourly",
    });
  });

  it("defaults providers to enabled and preserves an explicit false value", () => {
    expect(
      parseProviderConfig(validConfig("data_gov_ie"), "data_gov_ie").enabled,
    ).toBe(true);

    const disabled = validConfig("data_gov_ie").replace(
      "type: catalogue",
      "type: catalogue\nenabled: false",
    );
    expect(parseProviderConfig(disabled, "data_gov_ie").enabled).toBe(false);
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
    expect(Object.isFrozen(getProviderConfig("eirgrid").datasets)).toBe(true);
    expect(
      Object.isFrozen(getProviderConfig("geohive").allowed_arcgis_hosts),
    ).toBe(true);
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
      /URL must use HTTPS/,
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
    expect(() => loadProviderConfigs(allDocuments().slice(0, -1))).toThrow(
      "Missing configuration for provider(s): open_data_ni",
    );
  });

  it("rejects changes to fixed Phase 2 endpoints and settings", () => {
    const marine = stringify({
      ...providerConfigs.marine_institute,
      base_url: "https://example.test/erddap",
    });
    const tfi = stringify({
      ...providerConfigs.tfi_nta,
      capabilities: {
        ...providerConfigs.tfi_nta.capabilities,
        query_data_by_id: true,
      },
    });
    const opw = stringify({
      ...providerConfigs.opw,
      sensors: providerConfigs.opw.sensors.map((sensor) =>
        sensor.access_id === "water_level"
          ? { ...sensor, code: "0002" }
          : sensor,
      ),
    });
    const eirgrid = stringify({
      ...providerConfigs.eirgrid,
      datasets: providerConfigs.eirgrid.datasets.map((dataset) =>
        dataset.data_id === "solar_generation"
          ? { ...dataset, area: "WIND" }
          : dataset,
      ),
    });

    expect(() => parseProviderConfig(marine, "marine_institute")).toThrow(
      /Invalid configuration for provider marine_institute/,
    );
    expect(() => parseProviderConfig(tfi, "tfi_nta")).toThrow(
      /TFI realtime querying must remain disabled/,
    );
    expect(() => parseProviderConfig(opw, "opw")).toThrow(
      /OPW sensors must match the documented sensor allowlist/,
    );
    expect(() => parseProviderConfig(eirgrid, "eirgrid")).toThrow(
      /EirGrid datasets must match the three configured series/,
    );
  });
});
