import { AppError } from "../../errors";
import type {
  AccessPoint,
  DataDescription,
  DataLink,
  DataSearchResult,
  DataSummary,
  QueryDataResult,
  Source,
} from "../../models";
import type {
  DescribeDataInput,
  GetDataLinkInput,
  QueryDataInput,
  SearchDataInput,
} from "../provider";

export const TFI_NTA_SOURCE_ID = "tfi_nta";
export const TFI_STATIC_GTFS_URL =
  "https://www.transportforireland.ie/transitData/Data/GTFS_Realtime.zip";
export const TFI_DEVELOPER_PORTAL_URL =
  "https://developer.nationaltransport.ie/";

// Removed when the shared Source union gains TFI/NTA during integration.
const TFI_NTA_SOURCE = TFI_NTA_SOURCE_ID as Source;

export interface TfiNtaSettings {
  staticGtfsUrl: typeof TFI_STATIC_GTFS_URL;
  developerPortalUrl: typeof TFI_DEVELOPER_PORTAL_URL;
  defaultLimit: number;
  maxLimit: number;
}

export interface TfiNtaDependencies {
  fetch?: typeof fetch;
  now?: () => Date;
}

type CatalogueDataId = "gtfs_schedule" | "gtfs_realtime";

interface CatalogueEntry {
  dataId: CatalogueDataId;
  title: string;
  description: string;
  formats: readonly string[];
  upstreamUrl: string;
  accessPoints: readonly AccessPoint[];
}

const PUBLISHER = "Transport for Ireland / National Transport Authority";
const COVERAGE =
  "Irish public-transport data, including cross-border services where they are present in the published feeds.";
const ID_CAVEAT =
  "Generated identifiers may change between feed releases and must not be treated as permanent identifiers.";
const LICENCE =
  "Creative Commons Attribution 4.0 International (CC BY 4.0). Attribution: Transport for Ireland / National Transport Authority. Data is provided as is, without warranties.";
const REALTIME_LIMITATION =
  "Metadata only: the GTFS Realtime v2 feeds require an x-api-key and allow one call per API key per 60 seconds. Shared coordination, caching and payload measurement are required before proxy access can be enabled.";

export class TfiNtaAdapter {
  readonly config: TfiNtaSettings;

  private readonly now: () => Date;
  private readonly catalogue: readonly CatalogueEntry[];

  constructor(settings: TfiNtaSettings, dependencies: TfiNtaDependencies = {}) {
    validateSettings(settings);
    this.config = settings;
    this.now = dependencies.now ?? (() => new Date());
    this.catalogue = createCatalogue(settings);
  }

  async searchData(input: SearchDataInput): Promise<DataSearchResult> {
    const { limit, offset } = this.pagination(input.limit, input.offset);
    const query = input.query?.trim().toLocaleLowerCase("en-IE") ?? "";
    const matches = this.catalogue.filter((entry) => {
      if (query === "") return true;
      return [entry.dataId, entry.title, entry.description]
        .join(" ")
        .toLocaleLowerCase("en-IE")
        .includes(query);
    });
    const results = matches
      .slice(offset, offset + limit)
      .map((entry) => this.summary(entry));
    return {
      results,
      pagination: {
        limit,
        offset,
        returned: results.length,
        total: matches.length,
      },
    };
  }

  async describeData(input: DescribeDataInput): Promise<DataDescription> {
    const entry = this.requireData(input.data_id);
    return {
      ...this.summary(entry),
      licence: LICENCE,
      tags: ["public transport", "Ireland", "GTFS"],
      access_points: entry.accessPoints,
    };
  }

  async queryData(_input: QueryDataInput): Promise<QueryDataResult> {
    throw new AppError(
      "UNSUPPORTED_OPERATION",
      "TFI/NTA data is not queryable through this adapter.",
    );
  }

  async getDataLink(input: GetDataLinkInput): Promise<DataLink> {
    const entry = this.requireData(input.data_id);
    const accessPoint = entry.accessPoints.find(
      (candidate) => candidate.access_id === input.access_id,
    );
    if (!accessPoint) {
      throw new AppError("RESOURCE_NOT_FOUND");
    }
    if (
      entry.dataId !== "gtfs_schedule" ||
      accessPoint.access_id !== "schedule_archive" ||
      !accessPoint.capabilities.link
    ) {
      throw new AppError(
        "UNSUPPORTED_OPERATION",
        "TFI/NTA realtime feeds are metadata-only and cannot be linked without API-key coordination.",
      );
    }
    return {
      data_id: entry.dataId,
      access_id: accessPoint.access_id,
      url: this.config.staticGtfsUrl,
      format: accessPoint.format,
      ...(accessPoint.title ? { title: accessPoint.title } : {}),
      ...(accessPoint.description
        ? { description: accessPoint.description }
        : {}),
      provenance: {
        source: TFI_NTA_SOURCE,
        upstream_url: this.config.staticGtfsUrl,
        retrieved_at: this.now().toISOString(),
        original_format: accessPoint.format,
      },
    };
  }

  private summary(entry: CatalogueEntry): DataSummary {
    return {
      data_id: entry.dataId,
      title: entry.title,
      description: entry.description,
      publisher: PUBLISHER,
      available_formats: entry.formats,
      provenance: {
        source: TFI_NTA_SOURCE,
        upstream_url: entry.upstreamUrl,
        retrieved_at: this.now().toISOString(),
      },
    };
  }

  private requireData(dataId: string): CatalogueEntry {
    const entry = this.catalogue.find((candidate) => candidate.dataId === dataId);
    if (!entry) {
      throw new AppError("DATASET_NOT_FOUND");
    }
    return entry;
  }

  private pagination(
    requestedLimit: number | undefined,
    requestedOffset: number | undefined,
  ): { limit: number; offset: number } {
    const limit = requestedLimit ?? this.config.defaultLimit;
    const offset = requestedOffset ?? 0;
    if (
      !Number.isSafeInteger(limit) ||
      limit <= 0 ||
      limit > this.config.maxLimit ||
      !Number.isSafeInteger(offset) ||
      offset < 0
    ) {
      throw new AppError("INVALID_REQUEST");
    }
    return { limit, offset };
  }
}

function createCatalogue(settings: TfiNtaSettings): readonly CatalogueEntry[] {
  return [
    {
      dataId: "gtfs_schedule",
      title: "TFI GTFS schedule data",
      description: `${COVERAGE} Static schedule archive. ${ID_CAVEAT}`,
      formats: ["zip"],
      upstreamUrl: settings.staticGtfsUrl,
      accessPoints: [
        {
          access_id: "schedule_archive",
          title: "GTFS schedule archive",
          description: `Link-only ZIP archive; approximately 163 MB compressed and 867 MB extracted, so it is not fetched or parsed by this service. ${ID_CAVEAT}`,
          format: "zip",
          capabilities: { query: false, link: true },
          upstream_url: settings.staticGtfsUrl,
        },
      ],
    },
    {
      dataId: "gtfs_realtime",
      title: "TFI GTFS Realtime data",
      description: `${COVERAGE} ${REALTIME_LIMITATION} ${ID_CAVEAT}`,
      formats: ["gtfs-realtime"],
      upstreamUrl: settings.developerPortalUrl,
      accessPoints: [
        realtimeAccessPoint("trip_updates", "GTFS Realtime trip updates", settings),
        realtimeAccessPoint(
          "vehicle_positions",
          "GTFS Realtime vehicle positions",
          settings,
        ),
      ],
    },
  ];
}

function realtimeAccessPoint(
  accessId: "trip_updates" | "vehicle_positions",
  title: string,
  settings: TfiNtaSettings,
): AccessPoint {
  return {
    access_id: accessId,
    title,
    description: `${REALTIME_LIMITATION} ${ID_CAVEAT}`,
    format: "gtfs-realtime",
    capabilities: { query: false, link: false },
    upstream_url: settings.developerPortalUrl,
  };
}

function validateSettings(settings: TfiNtaSettings): void {
  if (
    settings.staticGtfsUrl !== TFI_STATIC_GTFS_URL ||
    settings.developerPortalUrl !== TFI_DEVELOPER_PORTAL_URL
  ) {
    throw new RangeError("TFI/NTA URLs must use the fixed official HTTPS allowlist");
  }
  for (const url of [settings.staticGtfsUrl, settings.developerPortalUrl]) {
    const parsed = new URL(url);
    if (
      parsed.protocol !== "https:" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.search !== "" ||
      parsed.hash !== ""
    ) {
      throw new RangeError("TFI/NTA URLs must not contain credentials or parameters");
    }
  }
  if (
    !Number.isSafeInteger(settings.defaultLimit) ||
    settings.defaultLimit <= 0 ||
    !Number.isSafeInteger(settings.maxLimit) ||
    settings.maxLimit <= 0 ||
    settings.maxLimit > 100 ||
    settings.defaultLimit > settings.maxLimit
  ) {
    throw new RangeError("TFI/NTA pagination limits are invalid");
  }
}
