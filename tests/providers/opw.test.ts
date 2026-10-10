import { describe, expect, it } from "vitest";

import {
  OPW_DATA_BASE_URL,
  OPW_LATEST_ENDPOINT,
  OPW_ORIGIN,
  OPW_SENSORS,
  OPW_STATIONS_ENDPOINT,
  OpwAdapter,
  type OpwSettings,
} from "../../src/providers/opw";

const NOW = new Date("2026-10-10T12:00:00.000Z");

function settings(overrides: Partial<OpwSettings> = {}): OpwSettings {
  return {
    stationsEndpoint: OPW_STATIONS_ENDPOINT,
    latestEndpoint: OPW_LATEST_ENDPOINT,
    dataBaseUrl: OPW_DATA_BASE_URL,
    stationBaseUrl: OPW_ORIGIN,
    sensors: OPW_SENSORS,
    rollingWindowDays: 35,
    cacheTtlSeconds: 900,
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
  overrides: Partial<OpwSettings> = {},
): OpwAdapter {
  return new OpwAdapter(settings(overrides), {
    fetch: fetcher,
    now: () => NOW,
  });
}

function stationFeature(
  reference: string,
  name: string,
  coordinates: [number, number] = [-7.1, 53.2],
): Record<string, unknown> {
  return {
    type: "Feature",
    properties: { ref: reference, name },
    geometry: { type: "Point", coordinates },
  };
}

function stationsBody(): Record<string, unknown> {
  return {
    type: "FeatureCollection",
    features: [
      stationFeature("0000025017", "River Station"),
      stationFeature("0000041000", "Boundary Station"),
      stationFeature("0000041001", "Restricted Station"),
      stationFeature("0000000000", "Zero Station"),
      stationFeature("not-a-reference", "Malformed Station"),
    ],
  };
}

function latestFeature(
  stationReference: string,
  sensorReference: string,
  name = "River Station",
): Record<string, unknown> {
  return {
    type: "Feature",
    properties: {
      station_ref: stationReference,
      station_name: name,
      sensor_ref: sensorReference,
      datetime: "2026-10-10T11:45:00Z",
      value: "1.25",
    },
    geometry: { type: "Point", coordinates: [-7.1, 53.2] },
  };
}

function latestBody(codes = ["0001", "OD", "0002", "0003", "0011"]): Record<string, unknown> {
  return {
    type: "FeatureCollection",
    features: [
      ...codes.map((code) => latestFeature("0000025017", code)),
      latestFeature("0000025017", "9999"),
      latestFeature("0000041001", "0001", "Restricted Station"),
    ],
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/geo+json" },
  });
}

function csvResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/csv; charset=utf-8" },
  });
}

function standardFetch(csv = "datetime,value\n2026-10-09 13:00,1.2\n"): ReturnType<typeof routedFetch> {
  return routedFetch((url) => {
    if (url === OPW_STATIONS_ENDPOINT) return jsonResponse(stationsBody());
    if (url === OPW_LATEST_ENDPOINT) return jsonResponse(latestBody());
    if (url.startsWith(OPW_DATA_BASE_URL)) return csvResponse(csv);
    throw new Error(`Unexpected URL: ${url}`);
  });
}

describe("OpwAdapter", () => {
  it("requires official endpoints, the fixed 35-day window, shared cache and documented sensors", () => {
    const unused = async () => jsonResponse({});
    expect(() =>
      adapter(unused, { stationsEndpoint: "https://example.test/" as typeof OPW_STATIONS_ENDPOINT }),
    ).toThrow(RangeError);
    expect(() => adapter(unused, { rollingWindowDays: 30 as 35 })).toThrow(RangeError);
    expect(() => adapter(unused, { cacheTtlSeconds: 60 as 900 })).toThrow(RangeError);
    expect(() => adapter(unused, { sensors: OPW_SENSORS.slice(0, 4) })).toThrow(
      RangeError,
    );
    expect(() => adapter(unused, { maxLimit: 101 })).toThrow(RangeError);
  });

  it("searches the bounded station feed, normalizes five-digit IDs and excludes restricted stations", async () => {
    const upstream = standardFetch();
    const result = await adapter(upstream.fetcher).searchData({
      query: "station",
      limit: 1,
      offset: 1,
    });

    expect(result.pagination).toEqual({ limit: 1, offset: 1, returned: 1, total: 2 });
    expect(result.results).toEqual([
      {
        data_id: "41000",
        title: "Boundary Station",
        description: "Realtime OPW monitoring station at 53.2, -7.1.",
        publisher: "Office of Public Works",
        available_formats: ["csv"],
        provenance: {
          source: "opw",
          upstream_url: "https://waterlevel.ie/0000041000/",
          retrieved_at: NOW.toISOString(),
        },
      },
    ]);
    expect(upstream.calls).toHaveLength(1);
    expect(upstream.calls[0]?.init).toMatchObject({
      redirect: "error",
      cf: { cacheEverything: true, cacheTtl: 900 },
    });
  });

  it("describes only current allowlisted sensors with stable IDs, units and caveats", async () => {
    const upstream = standardFetch();
    const result = await adapter(upstream.fetcher).describeData({ data_id: "25017" });

    expect(result).toMatchObject({
      data_id: "25017",
      title: "River Station",
      publisher: "Office of Public Works",
      licence: expect.stringContaining("CC BY 4.0"),
    });
    expect(result.licence).toContain("provisional, unchecked and unvalidated");
    expect(result.access_points.map((point) => point.access_id)).toEqual([
      "water_level",
      "ordnance_datum",
      "temperature",
      "battery_voltage",
      "backup_water_level",
    ]);
    expect(result.access_points[1]).toMatchObject({
      access_id: "ordnance_datum",
      format: "csv",
      capabilities: { query: true, link: true },
      description: expect.stringContaining("Poolbeg or Malin"),
      query_schema: {
        fields: [
          { name: "datetime", type: "datetime", operators: [] },
          { name: "value", type: "number", operators: [] },
        ],
        truncated: false,
      },
      upstream_url: "https://waterlevel.ie/data/month/25017_OD.csv",
    });
    expect(result.access_points[2]?.description).toContain("not represent waterbody");
  });

  it("selects the smallest covering feed, filters UTC rows and paginates projected values", async () => {
    const upstream = standardFetch(
      [
        "datetime,value,backup_value",
        "2026-10-09 12:15,0.9,0.8",
        "2026-10-09 13:00,1.1,1.0",
        "2026-10-09 13:15,1.2,1.1",
        "2026-10-09 13:30,1.3,1.2",
        "2026-10-09 14:00,1.4,1.3",
      ].join("\n"),
    );
    const result = await adapter(upstream.fetcher).queryData({
      data_id: "25017",
      access_id: "water_level",
      fields: ["datetime", "value"],
      time_range: {
        start: "2026-10-09T13:00:00Z",
        end: "2026-10-09T14:00:00Z",
      },
      limit: 2,
      offset: 1,
    });

    expect(upstream.calls.at(-1)?.url).toBe(
      "https://waterlevel.ie/data/day/25017_0001.csv",
    );
    expect(result.data).toEqual({
      rows: [
        { datetime: "2026-10-09T13:15:00.000Z", value: 1.2 },
        { datetime: "2026-10-09T13:30:00.000Z", value: 1.3 },
      ],
    });
    expect(result.pagination).toEqual({ limit: 2, offset: 1, returned: 2, total: 4 });
  });

  it("uses week/month feeds and maps the backup stream to one neutral value", async () => {
    const week = standardFetch("datetime,value\n2026-10-04 12:00,2.0\n");
    await adapter(week.fetcher).queryData({
      data_id: "25017",
      access_id: "water_level",
      time_range: {
        start: "2026-10-04T11:00:00Z",
        end: "2026-10-04T13:00:00Z",
      },
    });
    expect(week.calls.at(-1)?.url).toContain("/data/week/");

    const month = standardFetch(
      "datetime,backup_value,main_value\n2026-09-10 12:00,0.4,0.5\n",
    );
    const result = await adapter(month.fetcher).queryData({
      data_id: "25017",
      access_id: "backup_water_level",
      time_range: {
        start: "2026-09-10T11:00:00Z",
        end: "2026-09-10T13:00:00Z",
      },
    });
    expect(month.calls.at(-1)?.url).toBe(
      "https://waterlevel.ie/data/month/25017_0011.csv",
    );
    expect(result.data).toEqual({
      rows: [{ datetime: "2026-09-10T12:00:00.000Z", value: 0.4 }],
    });
  });

  it("requires an available access ID and a valid UTC range inside the rolling window", async () => {
    const upstream = standardFetch();
    const instance = adapter(upstream.fetcher);
    await expect(
      instance.queryData({ data_id: "25017", access_id: "water_level" }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(
      instance.queryData({
        data_id: "25017",
        access_id: "water_level",
        time_range: {
          start: "2026-09-05T11:59:59Z",
          end: "2026-09-06T00:00:00Z",
        },
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(
      instance.queryData({
        data_id: "25017",
        access_id: "rainfall",
        time_range: {
          start: "2026-10-09T13:00:00Z",
          end: "2026-10-09T14:00:00Z",
        },
      }),
    ).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    await expect(
      instance.queryData({
        data_id: "25017",
        access_id: "water_level",
        spatial: { type: "point", latitude: 53, longitude: -7 },
        time_range: {
          start: "2026-10-09T13:00:00Z",
          end: "2026-10-09T14:00:00Z",
        },
      }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_OPERATION" });
  });

  it("rejects station IDs outside 00001-41000 before fetching", async () => {
    let calls = 0;
    const instance = adapter(async () => {
      calls += 1;
      return jsonResponse(stationsBody());
    });
    for (const dataId of ["00000", "41001", "25017x", "25017/../"]) {
      await expect(instance.describeData({ data_id: dataId })).rejects.toMatchObject({
        code: "DATASET_NOT_FOUND",
      });
    }
    expect(calls).toBe(0);
  });

  it("returns only an exact allowlisted monthly CSV link for an existing sensor", async () => {
    const upstream = standardFetch();
    const result = await adapter(upstream.fetcher).getDataLink({
      data_id: "25017",
      access_id: "temperature",
    });

    expect(result).toEqual({
      data_id: "25017",
      access_id: "temperature",
      url: "https://waterlevel.ie/data/month/25017_0002.csv",
      format: "csv",
      title: "River Station — Temperature",
      description: expect.stringContaining("provisional, unchecked and unvalidated"),
      provenance: {
        source: "opw",
        upstream_url: "https://waterlevel.ie/data/month/25017_0002.csv",
        retrieved_at: NOW.toISOString(),
        original_format: "csv",
      },
    });
  });

  it("maps 404, HTML, malformed CSV, 429 and byte/output limits to stable errors", async () => {
    const notFound = routedFetch((url) => {
      if (url === OPW_STATIONS_ENDPOINT) return jsonResponse(stationsBody());
      if (url === OPW_LATEST_ENDPOINT) return jsonResponse(latestBody());
      return new Response("missing", { status: 404 });
    });
    await expect(
      adapter(notFound.fetcher).queryData({
        data_id: "25017",
        access_id: "water_level",
        time_range: {
          start: "2026-10-09T13:00:00Z",
          end: "2026-10-09T14:00:00Z",
        },
      }),
    ).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });

    const html = routedFetch(() =>
      new Response("<html>error</html>", {
        headers: { "content-type": "text/html" },
      }),
    );
    await expect(adapter(html.fetcher).searchData({})).rejects.toMatchObject({
      code: "UPSTREAM_ERROR",
    });

    const malformed = standardFetch("datetime,value\nnot-a-date,1.0\n");
    await expect(
      adapter(malformed.fetcher).queryData({
        data_id: "25017",
        access_id: "water_level",
        time_range: {
          start: "2026-10-09T13:00:00Z",
          end: "2026-10-09T14:00:00Z",
        },
      }),
    ).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });

    const rateLimited = routedFetch(() => jsonResponse({}, 429));
    await expect(adapter(rateLimited.fetcher).searchData({})).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });

    const tooLarge = routedFetch(() =>
      new Response(JSON.stringify(stationsBody()), {
        headers: {
          "content-type": "application/json",
          "content-length": "1000000",
        },
      }),
    );
    await expect(
      adapter(tooLarge.fetcher, { maxInputBytes: 100 }).searchData({}),
    ).rejects.toMatchObject({ code: "RESOURCE_TOO_LARGE" });

    const normal = standardFetch();
    await expect(
      adapter(normal.fetcher, { maxOutputBytes: 100 }).searchData({}),
    ).rejects.toMatchObject({ code: "RESOURCE_TOO_LARGE" });
  });

  it("times out stalled upstream requests", async () => {
    const stalled = (() => new Promise<Response>(() => undefined)) as typeof fetch;
    await expect(
      adapter(stalled, { timeoutMs: 1 }).searchData({}),
    ).rejects.toMatchObject({ code: "UPSTREAM_TIMEOUT" });
  });
});
