import dataGovIeYaml from "../../config/data_gov_ie.yml";
import metEireannYaml from "../../config/met_eireann.yml";
import openMeteoIeYaml from "../../config/open_meteo_ie.yml";
import smartDublinYaml from "../../config/smart_dublin.yml";
import serverYaml from "../../config/server.yml";

import type { Source } from "../models";
import {
  loadProviderConfigs,
  type LoadedProviderConfig,
} from "./schema";
import { parseServerConfig } from "./server";

export type {
  CkanEndpoints,
  LoadedCatalogueProviderConfig,
  LoadedForecastApiProviderConfig,
  LoadedProviderConfig,
  ProviderConfigDocument,
  ProviderScope,
} from "./schema";
export {
  loadProviderConfigs,
  parseProviderConfig,
  ProviderConfigError,
} from "./schema";
export type { AuthConfig, OAuthConfig, ServerConfig } from "./server";
export { parseServerConfig, ServerConfigError } from "./server";

export const providerConfigs = loadProviderConfigs([
  { expectedProvider: "data_gov_ie", contents: dataGovIeYaml },
  { expectedProvider: "smart_dublin", contents: smartDublinYaml },
  { expectedProvider: "met_eireann", contents: metEireannYaml },
  { expectedProvider: "open_meteo_ie", contents: openMeteoIeYaml },
]);

export const serverConfig = parseServerConfig(serverYaml);

export function getProviderConfig(source: Source): LoadedProviderConfig {
  return providerConfigs[source];
}
