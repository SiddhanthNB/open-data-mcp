import { describe, expect, it, vi } from "vitest";

import {
  TFI_DEVELOPER_PORTAL_URL,
  TFI_STATIC_GTFS_URL,
  TfiNtaAdapter,
  type TfiNtaSettings,
} from "../../src/providers/tfi-nta";

const NOW = new Date("2026-10-10T16:00:00.000Z");

function settings(overrides: Partial<TfiNtaSettings> = {}): TfiNtaSettings {
  return {
    staticGtfsUrl: TFI_STATIC_GTFS_URL,
    developerPortalUrl: TFI_DEVELOPER_PORTAL_URL,
    defaultLimit: 10,
    maxLimit: 100,
    ...overrides,
  };
}

function adapter(overrides: Partial<TfiNtaSettings> = {}) {
  const fetcher = vi.fn(() => {
    throw new Error("TFI/NTA adapter must never fetch upstream data");
  }) as unknown as typeof fetch;
  return {
    fetcher,
    instance: new TfiNtaAdapter(settings(overrides), {
      fetch: fetcher,
      now: () => NOW,
    }),
  };
}

describe("TfiNtaAdapter", () => {
  it("searches and pages the two deterministic local catalogue records", async () => {
    const { instance, fetcher } = adapter();
    const first = await instance.searchData({ limit: 1, offset: 0 });
    const realtime = await instance.searchData({
      query: "realtime",
      limit: 10,
      offset: 0,
    });

    expect(first.pagination).toEqual({ limit: 1, offset: 0, returned: 1, total: 2 });
    expect(first.results[0]).toMatchObject({
      data_id: "gtfs_schedule",
      publisher: "Transport for Ireland / National Transport Authority",
      available_formats: ["zip"],
      provenance: {
        source: "tfi_nta",
        upstream_url: TFI_STATIC_GTFS_URL,
        retrieved_at: NOW.toISOString(),
      },
    });
    expect(realtime.results.map((result) => result.data_id)).toEqual([
      "gtfs_realtime",
    ]);
    expect(realtime.results[0]?.description).toContain("cross-border");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("describes the static archive as link-only with licence and ID caveats", async () => {
    const { instance, fetcher } = adapter();
    const result = await instance.describeData({ data_id: "gtfs_schedule" });

    expect(result.licence).toContain("CC BY 4.0");
    expect(result.licence).toContain("Attribution: Transport for Ireland");
    expect(result.licence).toContain("as is");
    expect(result.description).toContain("cross-border");
    expect(result.description).toContain("may change between feed releases");
    expect(result.access_points).toEqual([
      expect.objectContaining({
        access_id: "schedule_archive",
        format: "zip",
        capabilities: { query: false, link: true },
        upstream_url: TFI_STATIC_GTFS_URL,
        description: expect.stringContaining("163 MB compressed"),
      }),
    ]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("keeps both realtime feeds metadata-only and documents operational limits", async () => {
    const { instance, fetcher } = adapter();
    const result = await instance.describeData({ data_id: "gtfs_realtime" });

    expect(result.access_points.map((point) => point.access_id)).toEqual([
      "trip_updates",
      "vehicle_positions",
    ]);
    for (const point of result.access_points) {
      expect(point.capabilities).toEqual({ query: false, link: false });
      expect(point.upstream_url).toBe(TFI_DEVELOPER_PORTAL_URL);
      expect(point.description).toContain("x-api-key");
      expect(point.description).toContain("one call per API key per 60 seconds");
      expect(point.description).toContain("Shared coordination, caching");
      expect(point.description).toContain("payload measurement");
      expect(point.description).toContain("may change between feed releases");
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("returns only the allowlisted anonymous schedule URL", async () => {
    const { instance, fetcher } = adapter();
    const result = await instance.getDataLink({
      data_id: "gtfs_schedule",
      access_id: "schedule_archive",
    });

    expect(result).toMatchObject({
      data_id: "gtfs_schedule",
      access_id: "schedule_archive",
      url: TFI_STATIC_GTFS_URL,
      format: "zip",
      provenance: {
        source: "tfi_nta",
        upstream_url: TFI_STATIC_GTFS_URL,
        retrieved_at: NOW.toISOString(),
        original_format: "zip",
      },
    });
    expect(new URL(result.url).search).toBe("");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects querying, realtime links, unknown data and unknown access IDs", async () => {
    const { instance, fetcher } = adapter();

    await expect(
      instance.queryData({
        data_id: "gtfs_schedule",
        access_id: "schedule_archive",
      }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_OPERATION" });
    await expect(
      instance.getDataLink({
        data_id: "gtfs_realtime",
        access_id: "trip_updates",
      }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_OPERATION" });
    await expect(
      instance.describeData({ data_id: "unknown" }),
    ).rejects.toMatchObject({ code: "DATASET_NOT_FOUND" });
    await expect(
      instance.getDataLink({
        data_id: "gtfs_schedule",
        access_id: "trip_updates",
      }),
    ).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects arbitrary, credential-bearing and unsafe configuration", () => {
    expect(
      () =>
        adapter({
          staticGtfsUrl:
            "https://attacker.example/archive.zip" as typeof TFI_STATIC_GTFS_URL,
        }),
    ).toThrow(RangeError);
    expect(
      () =>
        adapter({
          developerPortalUrl:
            "https://secret@example.test/?api_key=leaked" as typeof TFI_DEVELOPER_PORTAL_URL,
        }),
    ).toThrow(RangeError);
    expect(() => adapter({ defaultLimit: 101, maxLimit: 100 })).toThrow(
      RangeError,
    );
  });

  it("validates local search pagination without fetching", async () => {
    const { instance, fetcher } = adapter();
    await expect(instance.searchData({ limit: 101 })).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
    await expect(instance.searchData({ offset: -1 })).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
