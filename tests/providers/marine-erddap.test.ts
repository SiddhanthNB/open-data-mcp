import { describe, expect, it } from "vitest";

import {
  MARINE_ERDDAP_BASE_URL,
  MarineErddapAdapter,
  type MarineErddapSettings,
} from "../../src/providers/marine-erddap";

const NOW = new Date("2026-10-10T18:00:00.000Z");
const TABLE_ID = "IWBNetwork";
const GRID_ID = "IMI_NEATL";

function settings(
  overrides: Partial<MarineErddapSettings> = {},
): MarineErddapSettings {
  return {
    baseUrl: MARINE_ERDDAP_BASE_URL,
    timeoutMs: 1_000,
    maxInputBytes: 100_000,
    maxOutputBytes: 100_000,
    defaultLimit: 10,
    maxLimit: 100,
    maxSchemaFields: 50,
    maxSelectedFields: 10,
    ...overrides,
  };
}

function adapter(
  fetcher: typeof fetch,
  overrides: Partial<MarineErddapSettings> = {},
): MarineErddapAdapter {
  return new MarineErddapAdapter(settings(overrides), {
    fetch: fetcher,
    now: () => NOW,
  });
}

function tableResponse(
  columnNames: readonly string[],
  rows: readonly (readonly unknown[])[],
  options: {
    status?: number;
    columnTypes?: readonly string[];
    columnUnits?: readonly (string | null)[] | false;
    headers?: Record<string, string>;
  } = {},
): Response {
  return new Response(
    JSON.stringify({
      table: {
        columnNames,
        columnTypes: options.columnTypes ?? columnNames.map(() => "String"),
        ...(options.columnUnits === false
          ? {}
          : { columnUnits: options.columnUnits ?? columnNames.map(() => null) }),
        rows,
      },
    }),
    {
      status: options.status ?? 200,
      headers: { "content-type": "application/json", ...options.headers },
    },
  );
}

const SEARCH_COLUMNS = [
  "griddap",
  "tabledap",
  "files",
  "Accessible",
  "Title",
  "Summary",
  "Institution",
  "License",
  "Dataset ID",
] as const;

function searchRow(
  dataId = TABLE_ID,
  overrides: Partial<Record<(typeof SEARCH_COLUMNS)[number], string>> = {},
): string[] {
  const values: Record<(typeof SEARCH_COLUMNS)[number], string> = {
    griddap: "",
    tabledap: `${MARINE_ERDDAP_BASE_URL}/tabledap/${dataId}.html`,
    files: `${MARINE_ERDDAP_BASE_URL}/files/${dataId}/`,
    Accessible: "public",
    Title: "Irish Weather Buoy Network",
    Summary: "Realtime observations around Ireland.",
    Institution: "Marine Institute",
    License: "CC BY 4.0",
    "Dataset ID": dataId,
    ...overrides,
  };
  return SEARCH_COLUMNS.map((column) => values[column]);
}

const INFO_COLUMNS = [
  "Row Type",
  "Variable Name",
  "Attribute Name",
  "Data Type",
  "Value",
] as const;

function tableInfoRows(): string[][] {
  return [
    ["attribute", "NC_GLOBAL", "title", "String", "Irish Weather Buoy Network"],
    ["attribute", "NC_GLOBAL", "summary", "String", "Marine observations."],
    ["attribute", "NC_GLOBAL", "institution", "String", "Marine Institute"],
    ["attribute", "NC_GLOBAL", "license", "String", "CC BY 4.0"],
    ["attribute", "NC_GLOBAL", "keywords", "String", "ocean, weather, ocean"],
    ["variable", "station_id", "", "String", ""],
    ["attribute", "station_id", "long_name", "String", "Station"],
    ["variable", "time", "", "double", ""],
    ["attribute", "time", "_CoordinateAxisType", "String", "Time"],
    ["attribute", "time", "units", "String", "seconds since 1970-01-01T00:00:00Z"],
    ["variable", "latitude", "", "double", ""],
    ["attribute", "latitude", "_CoordinateAxisType", "String", "Lat"],
    ["attribute", "latitude", "units", "String", "degrees_north"],
    ["variable", "longitude", "", "double", ""],
    ["attribute", "longitude", "_CoordinateAxisType", "String", "Lon"],
    ["attribute", "longitude", "units", "String", "degrees_east"],
    ["variable", "temperature", "", "float", ""],
    ["attribute", "temperature", "long_name", "String", "Sea temperature"],
    ["attribute", "temperature", "units", "String", "degree_C"],
  ];
}

function gridInfoRows(): string[][] {
  return [
    ["attribute", "NC_GLOBAL", "title", "String", "Northeast Atlantic Model"],
    ["attribute", "NC_GLOBAL", "institution", "String", "Marine Institute"],
    ["attribute", "NC_GLOBAL", "license", "String", "CC BY 4.0"],
    ["dimension", "time", "", "double", "nValues=5, evenlySpaced=true"],
    ["attribute", "time", "_CoordinateAxisType", "String", "Time"],
    ["attribute", "time", "actual_range", "double", "2026-01-01T00:00:00Z, 2026-01-05T00:00:00Z"],
    ["dimension", "latitude", "", "double", "nValues=100"],
    ["attribute", "latitude", "_CoordinateAxisType", "String", "Lat"],
    ["attribute", "latitude", "actual_range", "double", "45, 60"],
    ["dimension", "longitude", "", "double", "nValues=120"],
    ["attribute", "longitude", "_CoordinateAxisType", "String", "Lon"],
    ["attribute", "longitude", "actual_range", "double", "-20, 5"],
    ["variable", "sea_surface_temperature", "", "float", ""],
    ["attribute", "sea_surface_temperature", "long_name", "String", "Sea surface temperature"],
    ["attribute", "sea_surface_temperature", "units", "String", "degree_C"],
  ];
}

interface Call {
  url: string;
  init?: RequestInit;
}

function recordingFetch(
  route: (url: URL, init?: RequestInit) => Response | Promise<Response>,
): { fetcher: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    fetcher: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = { url: String(input), ...(init ? { init } : {}) };
      calls.push(call);
      return route(new URL(call.url), init);
    }) as typeof fetch,
  };
}

function tableDatasetFetch(
  queryResponse?: Response,
  rowOverrides: Partial<Record<(typeof SEARCH_COLUMNS)[number], string>> = {},
) {
  return recordingFetch((url) => {
    if (url.pathname.endsWith("/search/index.json")) {
      return tableResponse(SEARCH_COLUMNS, [searchRow(TABLE_ID, rowOverrides)]);
    }
    if (url.pathname.endsWith(`/info/${TABLE_ID}/index.json`)) {
      return tableResponse(INFO_COLUMNS, tableInfoRows(), { columnUnits: false });
    }
    if (url.pathname.endsWith(`/tabledap/${TABLE_ID}.json`)) {
      return (
        queryResponse ??
        tableResponse(
          ["station_id", "time", "temperature"],
          [
            ["M2", "2026-01-01T00:00:00Z", 11.2],
            ["M2", "2026-01-01T01:00:00Z", "11.4"],
            ["M2", "2026-01-01T02:00:00Z", 11.5],
          ],
          {
            columnTypes: ["String", "String", "float"],
            columnUnits: [null, "UTC", "degree_C"],
          },
        )
      );
    }
    throw new Error(`Unexpected URL: ${url}`);
  });
}

function gridDatasetFetch() {
  return recordingFetch((url) => {
    if (url.pathname.endsWith("/search/index.json")) {
      return tableResponse(SEARCH_COLUMNS, [
        searchRow(GRID_ID, {
          griddap: `${MARINE_ERDDAP_BASE_URL}/griddap/${GRID_ID}.html`,
          tabledap: "",
          files: "",
          Title: "Northeast Atlantic Model",
          "Dataset ID": GRID_ID,
        }),
      ]);
    }
    if (url.pathname.endsWith(`/info/${GRID_ID}/index.json`)) {
      return tableResponse(INFO_COLUMNS, gridInfoRows(), { columnUnits: false });
    }
    if (url.pathname.endsWith(`/griddap/${GRID_ID}.json`)) {
      return tableResponse(
        ["time", "latitude", "longitude", "sea_surface_temperature"],
        [
          ["2026-01-02T00:00:00Z", 53.3, -9, 10.1],
          ["2026-01-03T00:00:00Z", 53.3, -9, 10.2],
          ["2026-01-04T00:00:00Z", 53.3, -9, 10.3],
        ],
        {
          columnTypes: ["String", "double", "double", "float"],
          columnUnits: ["UTC", "degrees_north", "degrees_east", "degree_C"],
        },
      );
    }
    throw new Error(`Unexpected URL: ${url}`);
  });
}

describe("MarineErddapAdapter", () => {
  it("accepts only the official endpoint and caps all pages at 100", () => {
    const unused = async () => tableResponse(["a"], [["b"]]);
    expect(() =>
      adapter(unused as typeof fetch, {
        baseUrl: "https://example.test/erddap" as typeof MARINE_ERDDAP_BASE_URL,
      }),
    ).toThrow(RangeError);
    expect(() => adapter(unused as typeof fetch, { maxLimit: 101 })).toThrow(
      RangeError,
    );
  });

  it("searches with official paging and carries stable dataset IDs across a page boundary", async () => {
    const upstream = recordingFetch((url) => {
      expect(url.searchParams.get("itemsPerPage")).toBe("100");
      const page = Number(url.searchParams.get("page"));
      expect(url.searchParams.get("searchFor")).toBe("temperature");
      const start = (page - 1) * 100;
      return tableResponse(
        SEARCH_COLUMNS,
        Array.from({ length: page === 1 ? 100 : 5 }, (_, index) => {
          const id = `dataset_${start + index}`;
          return searchRow(id, { Title: `Dataset ${start + index}` });
        }),
      );
    });

    const result = await adapter(upstream.fetcher).searchData({
      query: " temperature ",
      limit: 10,
      offset: 95,
    });

    expect(upstream.calls).toHaveLength(2);
    expect(result.results.map((item) => item.data_id)).toEqual(
      Array.from({ length: 10 }, (_, index) => `dataset_${95 + index}`),
    );
    expect(result.pagination).toEqual({ limit: 10, offset: 95, returned: 10 });
  });

  it("accepts the live ERDDAP search shape without units or link extensions", async () => {
    const upstream = recordingFetch(() =>
      tableResponse(
        SEARCH_COLUMNS,
        [
          searchRow(TABLE_ID, {
            tabledap: `${MARINE_ERDDAP_BASE_URL}/tabledap/${TABLE_ID}`,
          }),
        ],
        { columnUnits: false },
      ),
    );

    await expect(adapter(upstream.fetcher).searchData({})).resolves.toMatchObject({
      results: [{ data_id: TABLE_ID, available_formats: ["json", "files"] }],
    });
  });

  it("describes tabledap and files access using bounded neutral metadata", async () => {
    const upstream = tableDatasetFetch();
    const result = await adapter(upstream.fetcher).describeData({ data_id: TABLE_ID });

    expect(result).toMatchObject({
      data_id: TABLE_ID,
      title: "Irish Weather Buoy Network",
      description: "Marine observations.",
      publisher: "Marine Institute",
      licence: "CC BY 4.0",
      tags: ["ocean", "weather"],
    });
    expect(result.access_points.map((point) => point.access_id)).toEqual([
      "tabledap",
      "files",
    ]);
    expect(result.access_points[0]).toMatchObject({
      format: "json",
      capabilities: { query: true, link: true },
      upstream_url: `${MARINE_ERDDAP_BASE_URL}/tabledap/${TABLE_ID}.html`,
      query_schema: {
        truncated: false,
        spatial: ["point", "bbox"],
        fields: expect.arrayContaining([
          {
            name: "temperature",
            label: "Sea temperature",
            type: "number",
            operators: ["eq", "lt", "lte", "gt", "gte"],
            units: "degree_C",
          },
        ]),
      },
    });
    expect(result.access_points[1]).toMatchObject({
      format: "files",
      capabilities: { query: false, link: true },
      upstream_url: `${MARINE_ERDDAP_BASE_URL}/files/${TABLE_ID}/`,
    });
  });

  it("builds allowlisted tabledap constraints, normalizes types, and signals truncation", async () => {
    const upstream = tableDatasetFetch();
    const result = await adapter(upstream.fetcher).queryData({
      data_id: TABLE_ID,
      access_id: "tabledap",
      fields: ["station_id", "time", "temperature"],
      filters: [{ field: "station_id", operator: "eq", value: "M2" }],
      spatial: { type: "point", latitude: 53.3, longitude: -9 },
      time_range: {
        start: "2026-01-01T00:00:00Z",
        end: "2026-01-02T00:00:00Z",
      },
      limit: 2,
    });

    const queryUrl = new URL(upstream.calls.at(-1)!.url);
    expect(decodeURIComponent(queryUrl.search.slice(1))).toBe(
      'station_id,time,temperature&station_id="M2"&latitude=53.3&longitude=-9&time>="2026-01-01T00:00:00Z"&time<="2026-01-02T00:00:00Z"&orderByLimit("3")',
    );
    expect(result.data).toMatchObject({
      rows: [
        { station_id: "M2", time: "2026-01-01T00:00:00Z", temperature: 11.2 },
        { station_id: "M2", time: "2026-01-01T01:00:00Z", temperature: 11.4 },
      ],
    });
    expect(result.pagination_supported).toBe(false);
    expect(result.truncated).toBe(true);
  });

  it("rejects raw-like selectors, unsupported operators, unknown fields, and table offsets", async () => {
    const upstream = tableDatasetFetch();
    const instance = adapter(upstream.fetcher);
    await expect(
      instance.queryData({
        data_id: TABLE_ID,
        access_id: "tabledap",
        fields: ["temperature&orderByMax()"],
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(
      instance.queryData({
        data_id: TABLE_ID,
        access_id: "tabledap",
        filters: [{ field: "station_id", operator: "in", value: ["M2"] }],
      }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_OPERATION" });
    await expect(
      instance.queryData({
        data_id: TABLE_ID,
        access_id: "tabledap",
        offset: 1,
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("queries griddap using described variables and deterministic first-dimension paging", async () => {
    const upstream = gridDatasetFetch();
    const result = await adapter(upstream.fetcher).queryData({
      data_id: GRID_ID,
      access_id: "griddap",
      fields: ["sea_surface_temperature"],
      spatial: { type: "point", latitude: 53.3, longitude: -9 },
      limit: 2,
      offset: 1,
    });

    const queryUrl = new URL(upstream.calls.at(-1)!.url);
    expect(decodeURIComponent(queryUrl.search.slice(1))).toBe(
      "sea_surface_temperature[1:1:3][(53.3)][(-9)]",
    );
    expect(result.data).toMatchObject({
      rows: [
        { time: "2026-01-02T00:00:00Z", latitude: 53.3, longitude: -9, sea_surface_temperature: 10.1 },
        { time: "2026-01-03T00:00:00Z", latitude: 53.3, longitude: -9, sea_surface_temperature: 10.2 },
      ],
    });
    expect(result.pagination_supported).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.pagination).toEqual({ limit: 2, offset: 1, returned: 2, total: 5 });
  });

  it("rejects multi-dimensional griddap ranges instead of returning unsafe pages", async () => {
    const upstream = gridDatasetFetch();
    await expect(
      adapter(upstream.fetcher).queryData({
        data_id: GRID_ID,
        access_id: "griddap",
        fields: ["sea_surface_temperature"],
        spatial: { type: "bbox", west: -10, south: 52, east: -8, north: 54 },
        limit: 2,
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });

    await expect(
      adapter(upstream.fetcher).queryData({
        data_id: GRID_ID,
        access_id: "griddap",
        fields: ["sea_surface_temperature"],
        spatial: { type: "point", latitude: 53.3, longitude: -9 },
        time_range: {
          start: "2026-01-02T00:00:00Z",
          end: "2026-01-03T00:00:00Z",
        },
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("returns only validated browser links", async () => {
    const upstream = tableDatasetFetch();
    const instance = adapter(upstream.fetcher);
    await expect(
      instance.getDataLink({ data_id: TABLE_ID, access_id: "tabledap" }),
    ).resolves.toMatchObject({
      url: `${MARINE_ERDDAP_BASE_URL}/tabledap/${TABLE_ID}.html`,
      format: "html",
    });
    await expect(
      instance.getDataLink({ data_id: TABLE_ID, access_id: "files" }),
    ).resolves.toMatchObject({
      url: `${MARINE_ERDDAP_BASE_URL}/files/${TABLE_ID}/`,
      format: "html",
    });

    const hostile = tableDatasetFetch(undefined, {
      files: "https://evil.example/files/IWBNetwork/",
    });
    await expect(
      adapter(hostile.fetcher).describeData({ data_id: TABLE_ID }),
    ).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });

    const credentialed = tableDatasetFetch(undefined, {
      files: `https://user:password@erddap.marine.ie/erddap/files/${TABLE_ID}/`,
    });
    await expect(
      adapter(credentialed.fetcher).describeData({ data_id: TABLE_ID }),
    ).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
  });

  it("hides private datasets before requesting metadata", async () => {
    const upstream = recordingFetch(() =>
      tableResponse(SEARCH_COLUMNS, [searchRow(TABLE_ID, { Accessible: "log in" })]),
    );
    await expect(
      adapter(upstream.fetcher).describeData({ data_id: TABLE_ID }),
    ).rejects.toMatchObject({ code: "DATASET_NOT_FOUND" });
    expect(upstream.calls).toHaveLength(1);
  });

  it("turns ERDDAP's plain-text zero-row 404 into an empty result", async () => {
    const empty = new Response("Error { code=404; message=Your query produced no matching results. }", {
      status: 404,
      headers: { "content-type": "text/plain" },
    });
    const upstream = tableDatasetFetch(empty);
    const result = await adapter(upstream.fetcher).queryData({
      data_id: TABLE_ID,
      access_id: "tabledap",
      fields: ["temperature"],
    });
    expect(result.data).toEqual({ columns: [], rows: [] });
    expect(result.truncated).toBe(false);
  });

  it("maps plain errors and timeouts and rejects oversized or malformed payloads", async () => {
    await expect(
      adapter(async () => new Response("Error { code=500; message=broken; }", { status: 500 })).searchData({}),
    ).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });

    const abort = new Error("aborted");
    abort.name = "AbortError";
    await expect(
      adapter(async () => Promise.reject(abort)).searchData({}),
    ).rejects.toMatchObject({ code: "UPSTREAM_TIMEOUT" });

    await expect(
      adapter(
        async () =>
          new Response("{}", {
            headers: { "content-length": "100001" },
          }),
      ).searchData({}),
    ).rejects.toMatchObject({ code: "RESOURCE_TOO_LARGE" });

    await expect(
      adapter(async () => new Response("not json")).searchData({}),
    ).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });

    await expect(
      adapter(async () =>
        new Response(JSON.stringify({ table: { columnNames: [], rows: "bad" } })),
      ).searchData({}),
    ).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
  });

  it.each([502, 503, 504])("retries HTTP %s once", async (status) => {
    let calls = 0;
    const result = await adapter(async () => {
      calls += 1;
      return calls === 1
        ? new Response("temporary upstream failure", { status })
        : tableResponse(SEARCH_COLUMNS, [searchRow()]);
    }).searchData({});

    expect(calls).toBe(2);
    expect(result.results).toHaveLength(1);
  });

  it("retries an upstream timeout once", async () => {
    let calls = 0;
    const result = await adapter(async () => {
      calls += 1;
      if (calls === 1) {
        const abort = new Error("aborted");
        abort.name = "AbortError";
        throw abort;
      }
      return tableResponse(SEARCH_COLUMNS, [searchRow()]);
    }).searchData({});

    expect(calls).toBe(2);
    expect(result.results).toHaveLength(1);
  });
});
