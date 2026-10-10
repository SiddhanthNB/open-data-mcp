import { describe, expect, it } from "vitest";

import {
  EPA_ALERTS_ENDPOINT,
  EPA_LOCATIONS_ENDPOINT,
  EPA_MEASUREMENTS_ENDPOINT,
  EpaBathingWaterAdapter,
  type EpaSettings,
} from "../../src/providers/epa";

const NOW = new Date("2026-10-10T12:00:00.000Z");

function settings(overrides: Partial<EpaSettings> = {}): EpaSettings {
  return {
    endpoints: {
      locations: EPA_LOCATIONS_ENDPOINT,
      measurements: EPA_MEASUREMENTS_ENDPOINT,
      alerts: EPA_ALERTS_ENDPOINT,
    },
    timeoutMs: 1_000,
    maxInputBytes: 1_000_000,
    maxOutputBytes: 1_000_000,
    defaultLimit: 10,
    maxLimit: 100,
    ...overrides,
  };
}

interface RecordedCall {
  url: string;
  init?: RequestInit;
}

function routedFetch(
  route: (url: string, init?: RequestInit) => Response | Promise<Response>,
): { fetcher: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  return {
    calls,
    fetcher: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = { url: String(input), ...(init ? { init } : {}) };
      calls.push(call);
      return route(call.url, init);
    }) as typeof fetch,
  };
}

function adapter(
  fetcher: typeof fetch,
  overrides: Partial<EpaSettings> = {},
): EpaBathingWaterAdapter {
  return new EpaBathingWaterAdapter(settings(overrides), {
    fetch: fetcher,
    now: () => NOW,
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function page(
  list: readonly Record<string, unknown>[],
  count = list.length,
  pageNumber = 1,
): Record<string, unknown> {
  return {
    count,
    length: list.length,
    page: pageNumber,
    list,
    _links: { self: { href: `collection?page=${pageNumber}&per_page=100` } },
  };
}

const unusedFetch = (async () => {
  throw new Error("fetch should not be called");
}) as typeof fetch;

describe("EpaBathingWaterAdapter", () => {
  it("requires exact official endpoints and bounded pagination settings", () => {
    expect(
      () =>
        adapter(unusedFetch, {
          endpoints: {
            locations: "https://example.test/locations" as typeof EPA_LOCATIONS_ENDPOINT,
            measurements: EPA_MEASUREMENTS_ENDPOINT,
            alerts: EPA_ALERTS_ENDPOINT,
          },
        }),
    ).toThrow(RangeError);
    expect(() => adapter(unusedFetch, { maxLimit: 101 })).toThrow(RangeError);
    expect(() => adapter(unusedFetch, { defaultLimit: 11, maxLimit: 10 })).toThrow(
      RangeError,
    );
  });

  it("searches and pages the deterministic three-item local catalogue", async () => {
    const instance = adapter(unusedFetch);
    const all = await instance.searchData({ limit: 2, offset: 1 });

    expect(all.pagination).toEqual({ limit: 2, offset: 1, returned: 2, total: 3 });
    expect(all.results.map((result) => result.data_id)).toEqual([
      "bathing_water_measurements",
      "bathing_water_alerts",
    ]);
    expect(all.results[0]?.provenance).toEqual({
      source: "epa",
      upstream_url: EPA_MEASUREMENTS_ENDPOINT,
      retrieved_at: NOW.toISOString(),
    });

    const filtered = await instance.searchData({ query: "restrictions" });
    expect(filtered.results.map((result) => result.data_id)).toEqual([
      "bathing_water_alerts",
    ]);
  });

  it("describes stable access IDs, fields, licence, attribution and dataset caveats", async () => {
    const instance = adapter(unusedFetch);
    const locations = await instance.describeData({
      data_id: "bathing_water_locations",
    });
    expect(locations).toMatchObject({
      licence: expect.stringContaining("CC BY 4.0"),
      publisher: "Environmental Protection Agency (EPA), Ireland",
      access_points: [
        {
          access_id: "locations",
          format: "json",
          capabilities: { query: true, link: true },
          upstream_url: EPA_LOCATIONS_ENDPOINT,
          query_schema: { truncated: false },
        },
      ],
    });
    expect(locations.licence).toContain("Irish Public Sector Information");
    expect(locations.description).toContain("Irish Grid coordinates, not WGS84");
    expect(
      locations.access_points[0]?.query_schema?.fields.find(
        (field) => field.name === "beach_id",
      ),
    ).toEqual({ name: "beach_id", type: "string", operators: [] });

    const measurements = await instance.describeData({
      data_id: "bathing_water_measurements",
    });
    expect(
      measurements.access_points[0]?.query_schema?.fields.find(
        (field) => field.name === "in_season",
      ),
    ).toEqual({
      name: "in_season",
      label: "Filter only; not returned as a result field",
      type: "boolean",
      operators: ["eq"],
    });

    const alerts = await instance.describeData({
      data_id: "bathing_water_alerts",
    });
    expect(alerts.description).toContain("current alerts only");
  });

  it("maps arbitrary offsets across at most two fixed 100-row pages", async () => {
    const firstRows = Array.from({ length: 100 }, (_, index) => ({
      location_id: index + 1,
      beach_id: `BEACH-${index + 1}`,
      beach_name: `Beach ${index + 1}`,
    }));
    const upstream = routedFetch((url) => {
      const parsed = new URL(url);
      expect(parsed.searchParams.get("per_page")).toBe("100");
      if (parsed.searchParams.get("page") === "1") {
        return jsonResponse(page(firstRows, 150, 1));
      }
      return jsonResponse(
        page(
          [
            { location_id: 101, beach_id: " BEACH-101 ", beach_name: null },
            { location_id: 102, beach_id: "BEACH-102", beach_name: "Beach 102" },
          ],
          150,
          2,
        ),
      );
    });

    const result = await adapter(upstream.fetcher).queryData({
      data_id: "bathing_water_locations",
      access_id: "locations",
      fields: ["beach_id", "beach_name"],
      limit: 4,
      offset: 99,
    });

    expect(upstream.calls.map((call) => call.url)).toEqual([
      `${EPA_LOCATIONS_ENDPOINT}?page=1&per_page=100`,
      `${EPA_LOCATIONS_ENDPOINT}?page=2&per_page=100`,
    ]);
    expect(result.data).toEqual({
      rows: [
        { beach_id: "BEACH-100", beach_name: "Beach 100" },
        { beach_id: " BEACH-101 ", beach_name: null },
        { beach_id: "BEACH-102", beach_name: "Beach 102" },
      ],
    });
    expect(result.pagination).toEqual({
      limit: 4,
      offset: 99,
      returned: 3,
      total: 150,
    });
    expect(upstream.calls).toHaveLength(2);
  });

  it("passes only the typed in_season filter and preserves raw strings and nulls", async () => {
    const upstream = routedFetch((url) => {
      expect(url).toBe(
        `${EPA_MEASUREMENTS_ENDPOINT}?page=1&per_page=100&in_season=false`,
      );
      return jsonResponse(
        page([
          {
            monitoring_result_id: 3168,
            sample_code: "1450ard2205         ",
            e_coli_result: null,
            ignored: "not projected",
          },
        ]),
      );
    });

    const result = await adapter(upstream.fetcher).queryData({
      data_id: "bathing_water_measurements",
      access_id: "measurements",
      fields: ["sample_code", "e_coli_result"],
      filters: [{ field: "in_season", operator: "eq", value: false }],
    });

    expect(result.data).toEqual({
      rows: [{ sample_code: "1450ard2205         ", e_coli_result: null }],
    });
    expect(result.pagination?.returned).toBe(1);
  });

  it("rejects unknown fields and every unsupported selector or filter", async () => {
    const instance = adapter(unusedFetch);
    await expect(
      instance.queryData({
        data_id: "bathing_water_measurements",
        access_id: "measurements",
        fields: ["in_season"],
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(
      instance.queryData({
        data_id: "bathing_water_measurements",
        access_id: "measurements",
        filters: [{ field: "in_season", operator: "eq", value: "true" }],
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(
      instance.queryData({
        data_id: "bathing_water_locations",
        access_id: "locations",
        filters: [{ field: "beach_id", operator: "eq", value: "ABC" }],
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(
      instance.queryData({
        data_id: "bathing_water_alerts",
        access_id: "alerts",
        spatial: { type: "point", latitude: 53, longitude: -7 },
      }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_OPERATION" });
    await expect(
      instance.queryData({
        data_id: "bathing_water_alerts",
        access_id: "alerts",
        time_range: {
          start: "2026-01-01T00:00:00Z",
          end: "2026-01-02T00:00:00Z",
        },
      }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_OPERATION" });
  });

  it("returns only exact stable collection links", async () => {
    const instance = adapter(unusedFetch);
    await expect(
      instance.getDataLink({
        data_id: "bathing_water_alerts",
        access_id: "measurements",
      }),
    ).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });

    const link = await instance.getDataLink({
      data_id: "bathing_water_alerts",
      access_id: "alerts",
    });
    expect(link).toEqual({
      data_id: "bathing_water_alerts",
      access_id: "alerts",
      url: EPA_ALERTS_ENDPOINT,
      format: "json",
      title: "EPA bathing water alerts",
      description: expect.stringContaining("current alerts only"),
      provenance: {
        source: "epa",
        upstream_url: EPA_ALERTS_ENDPOINT,
        retrieved_at: NOW.toISOString(),
        original_format: "json",
      },
    });
  });

  it("maps rate limits, upstream failures, malformed envelopes and input size", async () => {
    const cases: readonly [Response, string][] = [
      [jsonResponse({}, 429), "RATE_LIMITED"],
      [jsonResponse({}, 500), "UPSTREAM_ERROR"],
      [jsonResponse({ count: "1", list: [] }), "UPSTREAM_ERROR"],
      [
        new Response("{}", {
          headers: {
            "content-type": "application/json",
            "content-length": "1000001",
          },
        }),
        "RESOURCE_TOO_LARGE",
      ],
    ];

    for (const [response, code] of cases) {
      const instance = adapter((async () => response) as typeof fetch);
      await expect(
        instance.queryData({
          data_id: "bathing_water_alerts",
          access_id: "alerts",
        }),
      ).rejects.toMatchObject({ code });
    }
  });

  it("maps aborts to upstream timeouts and bounds serialized output", async () => {
    const never = (() => new Promise<Response>(() => undefined)) as typeof fetch;
    await expect(
      adapter(never, { timeoutMs: 1 }).queryData({
        data_id: "bathing_water_alerts",
        access_id: "alerts",
      }),
    ).rejects.toMatchObject({ code: "UPSTREAM_TIMEOUT" });

    await expect(
      adapter(unusedFetch, { maxOutputBytes: 50 }).searchData({}),
    ).rejects.toMatchObject({ code: "RESOURCE_TOO_LARGE" });
  });

  it("rejects unknown data/access IDs and invalid paging before fetch", async () => {
    const instance = adapter(unusedFetch);
    await expect(
      instance.describeData({ data_id: "unknown" }),
    ).rejects.toMatchObject({ code: "DATASET_NOT_FOUND" });
    await expect(
      instance.queryData({
        data_id: "bathing_water_locations",
        access_id: "wrong",
      }),
    ).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    await expect(
      instance.queryData({
        data_id: "bathing_water_locations",
        access_id: "locations",
        limit: 101,
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(
      instance.queryData({
        data_id: "bathing_water_locations",
        access_id: "locations",
        offset: -1,
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });
});
