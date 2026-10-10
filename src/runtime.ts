import { providerConfigs } from "./config/index";
import { SOURCES, type ProviderConfig } from "./models";
import { ConfiguredAdapter } from "./providers/configured";
import { CsoPxStatAdapter } from "./providers/cso-pxstat";
import { DataGovAdapter } from "./providers/data-gov-ie";
import { EirGridAdapter } from "./providers/eirgrid";
import { EpaBathingWaterAdapter } from "./providers/epa";
import { GeoHiveAdapter } from "./providers/geohive";
import { MarineErddapAdapter } from "./providers/marine-erddap";
import {
  CkanAdapter,
  type CkanAdapterDependencies,
  type ResourceLoader,
} from "./providers/ckan/index";
import { MetEireannAdapter } from "./providers/met-eireann";
import { OpenMeteoAdapter } from "./providers/open-meteo";
import { OpwAdapter } from "./providers/opw";
import type { ProviderAdapter } from "./providers/provider";
import { SmartDublinAdapter } from "./providers/smart-dublin";
import { TfiNtaAdapter } from "./providers/tfi-nta";
import { SourceRouter } from "./router";

export interface RuntimeDependencies {
  resourceLoader: ResourceLoader;
  maxInputBytes: number;
  maxOutputBytes: number;
  fetch?: typeof fetch;
  now?: () => Date;
}

export function createSourceRouter(
  dependencies: RuntimeDependencies,
): SourceRouter {
  if (typeof dependencies?.resourceLoader?.load !== "function") {
    throw new Error("A resource loader is required");
  }

  const adapterDependencies: CkanAdapterDependencies = {
    resourceLoader: dependencies.resourceLoader,
    maxInputBytes: dependencies.maxInputBytes,
    maxOutputBytes: dependencies.maxOutputBytes,
    ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
    ...(dependencies.now ? { now: dependencies.now } : {}),
  };

  const metConfig = providerConfigs.met_eireann;
  if (metConfig.type !== "catalogue" || metConfig.forecast === undefined) {
    throw new Error("Met Eireann forecast configuration is required");
  }
  const metForecastConfig = metConfig.forecast;
  const openMeteoConfig = providerConfigs.open_meteo_ie;
  if (openMeteoConfig.type !== "forecast_api") {
    throw new Error("Open-Meteo forecast API configuration is required");
  }

  const commonDependencies = {
    maxInputBytes: dependencies.maxInputBytes,
    maxOutputBytes: dependencies.maxOutputBytes,
    ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
    ...(dependencies.now ? { now: dependencies.now } : {}),
  };
  const configured = (
    config: ProviderConfig,
    adapter: Omit<ProviderAdapter, "config">,
  ) => new ConfiguredAdapter(config, adapter);

  const cso = providerConfigs.cso_pxstat;
  const marine = providerConfigs.marine_institute;
  const geohive = providerConfigs.geohive;
  const opw = providerConfigs.opw;
  const epa = providerConfigs.epa;
  const tfi = providerConfigs.tfi_nta;
  const eirgrid = providerConfigs.eirgrid;

  const adapters: ProviderAdapter[] = [];
  const register = (
    config: ProviderConfig,
    create: () => ProviderAdapter,
  ): void => {
    if (config.enabled !== false) {
      adapters.push(create());
    }
  };

  register(
    providerConfigs.data_gov_ie,
    () => new DataGovAdapter(providerConfigs.data_gov_ie, adapterDependencies),
  );
  register(
    providerConfigs.smart_dublin,
    () =>
      new SmartDublinAdapter(
        providerConfigs.smart_dublin,
        adapterDependencies,
      ),
  );
  register(metConfig, () =>
    new MetEireannAdapter(metConfig, {
      ...adapterDependencies,
      forecast: {
        endpoint: metForecastConfig.endpoint,
        bounds: {
          minLatitude: metForecastConfig.bounds.min_latitude,
          maxLatitude: metForecastConfig.bounds.max_latitude,
          minLongitude: metForecastConfig.bounds.min_longitude,
          maxLongitude: metForecastConfig.bounds.max_longitude,
        },
      },
    }),
  );
  register(
    openMeteoConfig,
    () =>
      new OpenMeteoAdapter(openMeteoConfig, {
        maxInputBytes: dependencies.maxInputBytes,
        maxOutputBytes: dependencies.maxOutputBytes,
        ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
        ...(dependencies.now ? { now: dependencies.now } : {}),
      }),
  );
  register(cso, () =>
    configured(cso, new CsoPxStatAdapter(cso, commonDependencies)),
  );
  register(marine, () =>
    configured(
      marine,
      new MarineErddapAdapter(
        {
          baseUrl: marine.base_url,
          timeoutMs: marine.http_timeout_ms,
          maxInputBytes: dependencies.maxInputBytes,
          maxOutputBytes: dependencies.maxOutputBytes,
          defaultLimit: marine.pagination.default_limit,
          maxLimit: marine.pagination.max_limit,
          maxSchemaFields: marine.max_schema_fields,
          maxSelectedFields: marine.max_selected_fields,
        },
        commonDependencies,
      ),
    ),
  );
  register(geohive, () =>
    configured(
      geohive,
      new GeoHiveAdapter(
        {
          catalogueOrigin: geohive.endpoints.catalogue_origin,
          portalOrigin: geohive.endpoints.portal_origin,
          allowedArcgisHosts: geohive.allowed_arcgis_hosts,
          allowedWmsHosts: geohive.allowed_wms_hosts,
          timeoutMs: geohive.http_timeout_ms,
          maxInputBytes: dependencies.maxInputBytes,
          maxOutputBytes: dependencies.maxOutputBytes,
          defaultLimit: geohive.pagination.default_limit,
          maxLimit: geohive.pagination.max_limit,
          maxLayers: geohive.max_layers,
          maxSchemaFields: geohive.max_schema_fields,
          maxSelectedFields: geohive.max_selected_fields,
        },
        commonDependencies,
      ),
    ),
  );
  register(opw, () =>
    configured(
      opw,
      new OpwAdapter(
        {
          stationsEndpoint: opw.endpoints.stations,
          latestEndpoint: opw.endpoints.latest,
          dataBaseUrl: opw.endpoints.data_base,
          stationBaseUrl: opw.base_url,
          sensors: opw.sensors.map((sensor) => ({
            accessId: sensor.access_id,
            code: sensor.code,
            title: sensor.title,
            unit: sensor.unit,
            valueColumn: sensor.value_column,
            caveat: sensor.caveat,
          })),
          rollingWindowDays: opw.rolling_window_days,
          cacheTtlSeconds: opw.cache_ttl_seconds,
          timeoutMs: opw.http_timeout_ms,
          maxInputBytes: dependencies.maxInputBytes,
          maxOutputBytes: dependencies.maxOutputBytes,
          defaultLimit: opw.pagination.default_limit,
          maxLimit: opw.pagination.max_limit,
        },
        commonDependencies,
      ),
    ),
  );
  register(epa, () =>
    configured(
      epa,
      new EpaBathingWaterAdapter(
        {
          endpoints: epa.endpoints,
          timeoutMs: epa.http_timeout_ms,
          maxInputBytes: dependencies.maxInputBytes,
          maxOutputBytes: dependencies.maxOutputBytes,
          defaultLimit: epa.pagination.default_limit,
          maxLimit: epa.pagination.max_limit,
        },
        commonDependencies,
      ),
    ),
  );
  register(tfi, () =>
    configured(
      tfi,
      new TfiNtaAdapter(
        {
          staticGtfsUrl: tfi.endpoints.static_gtfs,
          developerPortalUrl: tfi.endpoints.developer_portal,
          defaultLimit: tfi.pagination.default_limit,
          maxLimit: tfi.pagination.max_limit,
        },
        commonDependencies,
      ),
    ),
  );
  register(
    providerConfigs.seai,
    () => new CkanAdapter(providerConfigs.seai, adapterDependencies),
  );
  register(eirgrid, () =>
    configured(
      eirgrid,
      new EirGridAdapter(
        {
          sourceId: eirgrid.provider,
          accessId: eirgrid.access_id,
          attribution: eirgrid.attribution,
          datasets: eirgrid.datasets.map((dataset) =>
            dataset.kind === "variable_generation"
              ? {
                  dataId: dataset.data_id,
                  title: dataset.title,
                  description: dataset.description,
                  kind: dataset.kind,
                  area: dataset.area,
                  endpointTemplate: dataset.endpoint_template,
                }
              : {
                  dataId: dataset.data_id,
                  title: dataset.title,
                  description: dataset.description,
                  kind: dataset.kind,
                  endpointTemplate: dataset.endpoint_template,
                  allowedFieldNames: dataset.allowed_field_names,
                },
          ),
          timeoutMs: eirgrid.http_timeout_ms,
          maxInputBytes: dependencies.maxInputBytes,
          maxOutputBytes: dependencies.maxOutputBytes,
          defaultLimit: eirgrid.pagination.default_limit,
          maxLimit: eirgrid.pagination.max_limit,
        },
        commonDependencies,
      ),
    ),
  );
  register(
    providerConfigs.open_data_ni,
    () => new CkanAdapter(providerConfigs.open_data_ni, adapterDependencies),
  );

  const disabledSources = SOURCES.filter(
    (source) => providerConfigs[source].enabled === false,
  );
  return new SourceRouter(adapters, disabledSources);
}
