import { providerConfigs } from "./config/index";
import { DataGovAdapter } from "./providers/data-gov-ie";
import {
  type CkanAdapterDependencies,
  type ResourceLoader,
} from "./providers/ckan/index";
import { MetEireannAdapter } from "./providers/met-eireann";
import { OpenMeteoAdapter } from "./providers/open-meteo";
import { SmartDublinAdapter } from "./providers/smart-dublin";
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
  const openMeteoConfig = providerConfigs.open_meteo_ie;
  if (openMeteoConfig.type !== "forecast_api") {
    throw new Error("Open-Meteo forecast API configuration is required");
  }

  return new SourceRouter([
    new DataGovAdapter(providerConfigs.data_gov_ie, adapterDependencies),
    new SmartDublinAdapter(providerConfigs.smart_dublin, adapterDependencies),
    new MetEireannAdapter(metConfig, {
      ...adapterDependencies,
      forecast: {
        endpoint: metConfig.forecast.endpoint,
        bounds: {
          minLatitude: metConfig.forecast.bounds.min_latitude,
          maxLatitude: metConfig.forecast.bounds.max_latitude,
          minLongitude: metConfig.forecast.bounds.min_longitude,
          maxLongitude: metConfig.forecast.bounds.max_longitude,
        },
      },
    }),
    new OpenMeteoAdapter(openMeteoConfig, {
      maxInputBytes: dependencies.maxInputBytes,
      maxOutputBytes: dependencies.maxOutputBytes,
      ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
      ...(dependencies.now ? { now: dependencies.now } : {}),
    }),
  ]);
}
