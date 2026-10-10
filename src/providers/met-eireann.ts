import { AppError } from "../errors";
import type {
  AccessPoint,
  DataDescription,
  DataLink,
  ProviderConfig,
  QueryDataResult,
} from "../models";
import {
  CkanAdapter,
  type CkanAdapterDependencies,
} from "./ckan/index";
import type {
  DescribeDataInput,
  GetDataLinkInput,
  QueryDataInput,
} from "./provider";
import {
  defaultForecastSettings,
  MET_EIREANN_FORECAST_ACCESS_ID,
  MET_EIREANN_FORECAST_DATA_ID,
  MET_EIREANN_FORECAST_FIELDS,
  MET_EIREANN_FORECAST_LICENCE_NOTICE,
  MetEireannForecastClient,
  type MetEireannForecastOverrides,
} from "./met-eireann/forecast";

export interface MetEireannAdapterDependencies extends CkanAdapterDependencies {
  forecast?: MetEireannForecastOverrides;
}

export class MetEireannAdapter extends CkanAdapter {
  private readonly forecast: MetEireannForecastClient;

  constructor(
    config: ProviderConfig,
    dependencies: MetEireannAdapterDependencies,
  ) {
    if (config.provider !== "met_eireann") {
      throw new Error(
        "MetEireannAdapter requires the met_eireann configuration",
      );
    }
    if (!config.scope?.organization_name || !config.scope.organization_id) {
      throw new Error(
        "MetEireannAdapter requires organization scope configuration",
      );
    }
    super(config, dependencies);
    const defaults = defaultForecastSettings({
      timeoutMs: config.http_timeout_ms,
      maxInputBytes: dependencies.maxInputBytes,
      maxOutputBytes: dependencies.maxOutputBytes,
      defaultLimit: config.pagination.default_limit,
      maxLimit: config.pagination.max_limit,
    });
    this.forecast = new MetEireannForecastClient(
      {
        ...defaults,
        ...dependencies.forecast,
        bounds: {
          ...defaults.bounds,
          ...dependencies.forecast?.bounds,
        },
      },
      {
        fetcher: dependencies.fetch ?? fetch,
        now: dependencies.now ?? (() => new Date()),
      },
    );
  }

  override async describeData(
    input: DescribeDataInput,
  ): Promise<DataDescription> {
    const description = await super.describeData(input);
    if (input.data_id !== MET_EIREANN_FORECAST_DATA_ID) {
      return description;
    }
    if (
      description.access_points.some(
        (access) => access.access_id === MET_EIREANN_FORECAST_ACCESS_ID,
      )
    ) {
      return description;
    }
    const accessPoint: AccessPoint = {
      access_id: MET_EIREANN_FORECAST_ACCESS_ID,
      title: "Point forecast query",
      description: `Dynamic XML point forecast. ${MET_EIREANN_FORECAST_LICENCE_NOTICE}`,
      format: "xml",
      capabilities: { query: true, link: false },
      query_schema: {
        fields: MET_EIREANN_FORECAST_FIELDS.map((name) => ({
          name,
          type: "string" as const,
          operators: [],
        })),
        truncated: false,
        spatial: ["point"],
        supported_selectors: ["fields", "spatial", "time_range"],
        required_selectors: ["spatial"],
      },
      upstream_url: this.forecast.endpoint,
    };
    return {
      ...description,
      access_points: [...description.access_points, accessPoint],
    };
  }

  override queryData(input: QueryDataInput): Promise<QueryDataResult> {
    if (
      input.data_id === MET_EIREANN_FORECAST_DATA_ID &&
      input.access_id === MET_EIREANN_FORECAST_ACCESS_ID
    ) {
      return this.forecast.query(input);
    }
    return super.queryData(input);
  }

  override getDataLink(input: GetDataLinkInput): Promise<DataLink> {
    if (
      input.data_id === MET_EIREANN_FORECAST_DATA_ID &&
      input.access_id === MET_EIREANN_FORECAST_ACCESS_ID
    ) {
      return Promise.reject(
        new AppError(
          "UNSUPPORTED_OPERATION",
          "Dynamic point forecasts do not provide a fixed browser-openable link.",
        ),
      );
    }
    return super.getDataLink(input);
  }
}
