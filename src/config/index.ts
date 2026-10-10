import csoPxStatYaml from "../../config/cso_pxstat.yml";
import dataGovIeYaml from "../../config/data_gov_ie.yml";
import eirgridYaml from "../../config/eirgrid.yml";
import epaYaml from "../../config/epa.yml";
import geohiveYaml from "../../config/geohive.yml";
import marineInstituteYaml from "../../config/marine_institute.yml";
import metEireannYaml from "../../config/met_eireann.yml";
import openDataNiYaml from "../../config/open_data_ni.yml";
import openMeteoIeYaml from "../../config/open_meteo_ie.yml";
import opwYaml from "../../config/opw.yml";
import seaiYaml from "../../config/seai.yml";
import smartDublinYaml from "../../config/smart_dublin.yml";
import tfiNtaYaml from "../../config/tfi_nta.yml";
import serverYaml from "../../config/server.yml";

import type { Source } from "../models";
import {
  loadProviderConfigs,
  type LoadedProviderConfigs,
} from "./schema";
import { parseServerConfig } from "./server";

export type {
  CkanEndpoints,
  LoadedCatalogueProviderConfig,
  LoadedForecastApiProviderConfig,
  LoadedProviderConfig,
  LoadedProviderConfigFor,
  LoadedProviderConfigs,
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
  { expectedProvider: "cso_pxstat", contents: csoPxStatYaml },
  { expectedProvider: "marine_institute", contents: marineInstituteYaml },
  { expectedProvider: "geohive", contents: geohiveYaml },
  { expectedProvider: "opw", contents: opwYaml },
  { expectedProvider: "epa", contents: epaYaml },
  { expectedProvider: "tfi_nta", contents: tfiNtaYaml },
  { expectedProvider: "seai", contents: seaiYaml },
  { expectedProvider: "eirgrid", contents: eirgridYaml },
  { expectedProvider: "open_data_ni", contents: openDataNiYaml },
]);

export const serverConfig = parseServerConfig(serverYaml);

export function getProviderConfig<S extends Source>(
  source: S,
): LoadedProviderConfigs[S] {
  return providerConfigs[source];
}
