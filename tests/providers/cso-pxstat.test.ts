import { describe, expect, it } from "vitest";

import { AppError } from "../../src/errors";
import {
  CSO_DATASET_METHOD,
  CSO_JSON_RPC_ENDPOINT,
  CSO_QUERY_ACCESS_ID,
  CSO_REST_BASE,
  CSO_SEARCH_METHOD,
  CsoPxStatAdapter,
  type CsoPxStatAdapterConfig,
} from "../../src/providers/cso-pxstat";

const NOW = new Date("2026-10-10T12:00:00.000Z");

function config(
  overrides: Partial<CsoPxStatAdapterConfig> = {},
): CsoPxStatAdapterConfig {
  return {
    provider: "cso_pxstat",
    type: "statistical_cube",
    base_url: CSO_REST_BASE,
    endpoints: {
      json_rpc: CSO_JSON_RPC_ENDPOINT,
      restful: CSO_REST_BASE,
    },
    methods: {
      search: CSO_SEARCH_METHOD,
      read_dataset: CSO_DATASET_METHOD,
    },
    language: "en",
    http_timeout_ms: 1_000,
    pagination: { default_limit: 10, max_limit: 100 },
    search_result_limit: 100,
    max_dimension_values: 2,
    max_cells: 100,
    ...overrides,
  };
}

function adapter(
  fetcher: typeof fetch,
  options: {
    config?: Partial<CsoPxStatAdapterConfig>;
    maxInputBytes?: number;
    maxOutputBytes?: number;
  } = {},
): CsoPxStatAdapter {
  return new CsoPxStatAdapter(config(options.config), {
    fetch: fetcher,
    now: () => NOW,
    maxInputBytes: options.maxInputBytes ?? 1_000_000,
    maxOutputBytes: options.maxOutputBytes ?? 1_000_000,
  });
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function rpcResult(value: unknown): Response {
  return jsonResponse({ jsonrpc: "2.0", result: value, id: "1" });
}

function searchRecord(index: number): Record<string, unknown> {
  return {
    MtrCode: `TAB${String(index).padStart(3, "0")}`,
    MtrTitle: `Table ${index}`,
    MtrOfficialFlag: true,
    SbjValue: "People",
    PrcValue: "Population",
    RlsLiveDatetimeFrom: "2026-10-01T11:00:00",
    CprCode: "CSO",
    CprValue: "Central Statistics Office, Ireland",
  };
}

function metadata(
  copyright: Record<string, unknown> = {
    name: "Central Statistics Office, Ireland",
    code: "CSO",
    href: "https://www.cso.ie/",
  },
): Record<string, unknown> {
  return {
    class: "dataset",
    id: ["STATISTIC", "YEAR", "REGION"],
    size: [1, 2, 3],
    label: "Population by year and region",
    updated: "2026-10-01T11:00:00Z",
    dimension: {
      STATISTIC: {
        label: "Statistic",
        category: {
          index: ["POP"],
          label: { POP: "Population" },
        },
      },
      YEAR: {
        label: "Year",
        category: {
          index: ["2024", "2025"],
          label: { "2024": "2024", "2025": "2025" },
        },
      },
      REGION: {
        label: "Region",
        category: {
          index: { IE: 0, D: 1, C: 2 },
          label: { IE: "Ireland", D: "Dublin", C: "Cork" },
        },
      },
    },
    extension: {
      matrix: "TAB001",
      subject: { value: "People and Society" },
      product: { value: "Population Estimates" },
      official: true,
      copyright,
    },
  };
}

function selectedDataset(): Record<string, unknown> {
  return {
    class: "dataset",
    id: ["STATISTIC", "YEAR", "REGION"],
    size: [1, 2, 2],
    label: "Population by year and region",
    dimension: {
      STATISTIC: {
        label: "Statistic",
        category: {
          index: ["POP"],
          label: { POP: "Population" },
        },
      },
      YEAR: {
        label: "Year",
        category: {
          index: ["2024", "2025"],
          label: { "2024": "2024", "2025": "2025" },
        },
      },
      REGION: {
        label: "Region",
        category: {
          index: ["IE", "D"],
          label: { IE: "Ireland", D: "Dublin" },
        },
      },
    },
    extension: {
      matrix: "TAB001",
      copyright: {
        name: "Central Statistics Office, Ireland",
        code: "CSO",
        href: "https://www.cso.ie/",
      },
    },
    value: [5_400_000, 1_500_000, null, 1_550_000],
    status: { "2": "provisional" },
  };
}

function validFilters() {
  return [
    { field: "YEAR", operator: "in" as const, value: ["2024", "2025"] },
    { field: "REGION", operator: "in" as const, value: ["IE", "D"] },
  ];
}

function recordingFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): {
  fetcher: typeof fetch;
  calls: Array<{ url: string; init?: RequestInit }>;
} {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  return {
    calls,
    fetcher: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = { url: String(input), ...(init ? { init } : {}) };
      calls.push(call);
      return handler(call.url, init);
    }) as typeof fetch,
  };
}

describe("CsoPxStatAdapter", () => {
  it("rejects non-official endpoints, methods, excessive search, and excessive cell settings", () => {
    const unused = async () => jsonResponse({});
    expect(() =>
      adapter(unused, {
        config: {
          endpoints: { json_rpc: "https://example.test", restful: CSO_REST_BASE },
        },
      }),
    ).toThrow(RangeError);
    expect(() =>
      adapter(unused, {
        config: { methods: { search: "Other.Search", read_dataset: CSO_DATASET_METHOD } },
      }),
    ).toThrow(RangeError);
    expect(() =>
      adapter(unused, { config: { search_result_limit: 101 } }),
    ).toThrow(RangeError);
    expect(() => adapter(unused, { config: { max_cells: 101 } })).toThrow(
      RangeError,
    );
  });

  it("searches anonymously, maps stable matrix IDs, and paginates only over the first 100 results", async () => {
    const upstream = recordingFetch((_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual({
        jsonrpc: "2.0",
        method: CSO_SEARCH_METHOD,
        params: { Search: "population", LngIsoCode: "en" },
        id: "1",
      });
      expect(init?.headers).toMatchObject({ "content-type": "application/json" });
      return rpcResult(Array.from({ length: 110 }, (_, index) => searchRecord(index)));
    });

    const result = await adapter(upstream.fetcher).searchData({
      query: " population ",
      limit: 10,
      offset: 95,
    });

    expect(upstream.calls).toHaveLength(1);
    expect(upstream.calls[0]?.url).toBe(CSO_JSON_RPC_ENDPOINT);
    expect(result.pagination).toEqual({ limit: 10, offset: 95, returned: 5 });
    expect(result.results[0]).toMatchObject({
      data_id: "TAB095",
      title: "Table 95",
      publisher: "Central Statistics Office, Ireland",
      available_formats: ["json-stat2", "json-stat1", "csv", "px", "xlsx"],
      provenance: {
        source: "cso_pxstat",
        upstream_url:
          "https://ws.cso.ie/public/api.restful/PxStat.Data.Cube_API.ReadMetadata/TAB095/en",
      },
    });
  });

  it("requires a non-empty search query and validates local pagination before fetch", async () => {
    let calls = 0;
    const instance = adapter(async () => {
      calls += 1;
      return rpcResult([]);
    });

    await expect(instance.searchData({ query: "" })).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
    await expect(
      instance.searchData({ query: "population", limit: 101 }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(calls).toBe(0);
  });

  it("describes all five access formats with a bounded, explicitly truncated query schema", async () => {
    const result = await adapter(async () => jsonResponse(metadata())).describeData({
      data_id: "TAB001",
    });

    expect(result).toMatchObject({
      data_id: "TAB001",
      title: "Population by year and region",
      publisher: "Central Statistics Office, Ireland",
      licence:
        "Creative Commons Attribution 4.0 International (CC BY 4.0)",
      attribution: {
        name: "Central Statistics Office, Ireland",
        code: "CSO",
        url: "https://www.cso.ie/",
      },
    });
    expect(result.access_points.map((item) => item.access_id)).toEqual([
      "json_stat_2",
      "json_stat_1",
      "csv_1",
      "px_2013",
      "xlsx_2007",
    ]);
    expect(result.access_points.map((item) => item.capabilities)).toEqual([
      { query: true, link: true },
      { query: false, link: true },
      { query: false, link: true },
      { query: false, link: true },
      { query: false, link: true },
    ]);
    expect(result.access_points[0]?.query_schema).toMatchObject({
      truncated: true,
      fields: [
        {
          name: "STATISTIC",
          label: "Statistic",
          operators: ["in"],
          values: [{ value: "POP", label: "Population" }],
        },
        {
          name: "YEAR",
        },
        {
          name: "REGION",
          values: [
            { value: "IE", label: "Ireland" },
            { value: "D", label: "Dublin" },
          ],
          values_truncated: true,
        },
      ],
    });
    expect(result.access_points[4]?.upstream_url).toBe(
      "https://ws.cso.ie/public/api.restful/PxStat.Data.Cube_API.ReadDataset/TAB001/XLSX/2007/en",
    );
  });

  it("preserves non-CSO per-matrix attribution without claiming the CSO licence", async () => {
    const result = await adapter(async () =>
      jsonResponse(
        metadata({
          name: "Another Public Body",
          code: "APB",
          href: "https://public.example.ie/",
        }),
      ),
    ).describeData({ data_id: "TAB001" });

    expect(result.publisher).toBe("Another Public Body");
    expect(result.attribution).toEqual({
      name: "Another Public Body",
      code: "APB",
      url: "https://public.example.ie/",
    });
    expect(result).not.toHaveProperty("licence");
  });

  it("validates selections, sends only a fixed ReadDataset payload, normalizes JSON-stat 2, and pages locally", async () => {
    const upstream = recordingFetch((url, init) => {
      if (url.includes("ReadMetadata")) {
        expect(init?.method).toBeUndefined();
        return jsonResponse(metadata());
      }
      const body = JSON.parse(String(init?.body));
      expect(body.method).toBe(CSO_DATASET_METHOD);
      expect(body.params).toEqual({
        class: "query",
        id: ["STATISTIC", "YEAR", "REGION"],
        dimension: {
          STATISTIC: { category: { index: ["POP"] } },
          YEAR: { category: { index: ["2024", "2025"] } },
          REGION: { category: { index: ["IE", "D"] } },
        },
        extension: {
          matrix: "TAB001",
          codes: true,
          pivot: null,
          language: { code: "en" },
          format: { type: "JSON-stat", version: "2.0" },
        },
        version: "2.0",
        m2m: false,
      });
      return rpcResult(selectedDataset());
    });

    const result = await adapter(upstream.fetcher).queryData({
      data_id: "TAB001",
      access_id: CSO_QUERY_ACCESS_ID,
      filters: validFilters(),
      limit: 2,
      offset: 1,
    });

    expect(upstream.calls).toHaveLength(2);
    expect(result.pagination).toEqual({
      limit: 2,
      offset: 1,
      returned: 2,
      total: 4,
    });
    expect(result.data).toEqual({
      rows: [
        {
          dimensions: [
            { field: "STATISTIC", value: "POP", label: "Population" },
            { field: "YEAR", value: "2024", label: "2024" },
            { field: "REGION", value: "D", label: "Dublin" },
          ],
          value: 1_500_000,
        },
        {
          dimensions: [
            { field: "STATISTIC", value: "POP", label: "Population" },
            { field: "YEAR", value: "2025", label: "2025" },
            { field: "REGION", value: "IE", label: "Ireland" },
          ],
          value: null,
          status: "provisional",
        },
      ],
      attribution: {
        name: "Central Statistics Office, Ireland",
        code: "CSO",
        url: "https://www.cso.ie/",
      },
    });
    expect(result.provenance).toMatchObject({
      source: "cso_pxstat",
      upstream_url: CSO_JSON_RPC_ENDPOINT,
      original_format: "json-stat2",
    });
  });

  it.each([
    {
      name: "missing a multi-value dimension",
      filters: [
        { field: "YEAR", operator: "in" as const, value: ["2024"] },
      ],
    },
    {
      name: "using a non-in operator",
      filters: [
        { field: "YEAR", operator: "eq" as const, value: "2024" },
        { field: "REGION", operator: "in" as const, value: ["IE"] },
      ],
    },
    {
      name: "using an unknown dimension",
      filters: [
        { field: "YEAR", operator: "in" as const, value: ["2024"] },
        { field: "REGION", operator: "in" as const, value: ["IE"] },
        { field: "UNKNOWN", operator: "in" as const, value: ["x"] },
      ],
    },
    {
      name: "using an unknown value code",
      filters: [
        { field: "YEAR", operator: "in" as const, value: ["2030"] },
        { field: "REGION", operator: "in" as const, value: ["IE"] },
      ],
    },
    {
      name: "using a non-string value code",
      filters: [
        { field: "YEAR", operator: "in" as const, value: [2024] },
        { field: "REGION", operator: "in" as const, value: ["IE"] },
      ],
    },
  ])("rejects $name after metadata and before a data fetch", async ({ filters }) => {
    let calls = 0;
    const instance = adapter(async () => {
      calls += 1;
      return jsonResponse(metadata());
    });

    await expect(
      instance.queryData({
        data_id: "TAB001",
        access_id: CSO_QUERY_ACCESS_ID,
        filters,
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(calls).toBe(1);
  });

  it("rejects Cartesian selections above 100 cells before the data fetch", async () => {
    const large = metadata();
    const dimension = large.dimension as Record<string, Record<string, unknown>>;
    const values = Array.from({ length: 11 }, (_, index) => `V${index}`);
    dimension.YEAR = {
      label: "Year",
      category: {
        index: values,
        label: Object.fromEntries(values.map((value) => [value, value])),
      },
    };
    dimension.REGION = {
      label: "Region",
      category: {
        index: values,
        label: Object.fromEntries(values.map((value) => [value, value])),
      },
    };
    large.size = [1, 11, 11];
    let calls = 0;
    const instance = adapter(async () => {
      calls += 1;
      return jsonResponse(large);
    });

    await expect(
      instance.queryData({
        data_id: "TAB001",
        access_id: CSO_QUERY_ACCESS_ID,
        filters: [
          { field: "YEAR", operator: "in", value: values },
          { field: "REGION", operator: "in", value: values },
        ],
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(calls).toBe(1);
  });

  it("rejects a dataset response that does not match the validated selection", async () => {
    let calls = 0;
    const instance = adapter(async (input) => {
      calls += 1;
      if (String(input).includes("ReadMetadata")) {
        return jsonResponse(metadata());
      }
      const invalid = selectedDataset();
      invalid.size = [1, 1, 1];
      invalid.value = [1];
      const dimensions = invalid.dimension as Record<
        string,
        Record<string, unknown>
      >;
      dimensions.YEAR = {
        label: "Year",
        category: { index: ["2024"], label: { "2024": "2024" } },
      };
      dimensions.REGION = {
        label: "Region",
        category: { index: ["IE"], label: { IE: "Ireland" } },
      };
      return rpcResult(invalid);
    });

    await expect(
      instance.queryData({
        data_id: "TAB001",
        access_id: CSO_QUERY_ACCESS_ID,
        filters: validFilters(),
      }),
    ).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
    expect(calls).toBe(2);
  });

  it("constructs only allowlisted official download links", async () => {
    const upstream = recordingFetch(() => jsonResponse(metadata()));
    const instance = adapter(upstream.fetcher);
    const result = await instance.getDataLink({
      data_id: "TAB001",
      access_id: "csv_1",
    });

    expect(result).toMatchObject({
      data_id: "TAB001",
      access_id: "csv_1",
      format: "csv",
      url: "https://ws.cso.ie/public/api.restful/PxStat.Data.Cube_API.ReadDataset/TAB001/CSV/1.0/en",
      description: "Published by Central Statistics Office, Ireland.",
      provenance: {
        source: "cso_pxstat",
        original_format: "csv",
      },
    });
    expect(upstream.calls).toHaveLength(1);
    await expect(
      instance.getDataLink({ data_id: "TAB001", access_id: "arbitrary" }),
    ).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    expect(upstream.calls).toHaveLength(1);
  });

  it("rejects query attempts through download-only and unknown access IDs", async () => {
    const instance = adapter(async () => {
      throw new Error("not called");
    });
    await expect(
      instance.queryData({ data_id: "TAB001", access_id: "xlsx_2007" }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_OPERATION" });
    await expect(
      instance.queryData({ data_id: "TAB001", access_id: "unknown" }),
    ).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
  });

  it.each([
    { status: 404, code: "DATASET_NOT_FOUND" },
    { status: 429, code: "RATE_LIMITED" },
    { status: 500, code: "UPSTREAM_ERROR" },
  ])("maps REST HTTP $status to $code", async ({ status, code }) => {
    await expect(
      adapter(async () => jsonResponse({}, status)).describeData({
        data_id: "TAB001",
      }),
    ).rejects.toMatchObject({ code });
  });

  it("maps JSON-RPC errors and malformed JSON to upstream errors", async () => {
    await expect(
      adapter(async () =>
        jsonResponse({
          jsonrpc: "2.0",
          error: { code: -32099, message: "Application error" },
          id: "1",
        }),
      ).searchData({ query: "population" }),
    ).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
    await expect(
      adapter(async () => new Response("not-json")).searchData({
        query: "population",
      }),
    ).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
  });

  it("enforces upstream input and normalized output byte limits", async () => {
    await expect(
      adapter(async () => jsonResponse(metadata()), {
        maxInputBytes: 10,
      }).describeData({ data_id: "TAB001" }),
    ).rejects.toMatchObject({ code: "RESOURCE_TOO_LARGE" });

    await expect(
      adapter(async () => rpcResult([searchRecord(1)]), {
        maxOutputBytes: 10,
      }).searchData({ query: "population" }),
    ).rejects.toMatchObject({ code: "RESOURCE_TOO_LARGE" });
  });

  it("maps an aborted upstream request to a timeout", async () => {
    const fetcher = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      })) as typeof fetch;

    await expect(
      adapter(fetcher, { config: { http_timeout_ms: 1 } }).searchData({
        query: "population",
      }),
    ).rejects.toMatchObject({ code: "UPSTREAM_TIMEOUT" });
  });

  it("rejects malformed matrix IDs before making a metadata request", async () => {
    let calls = 0;
    await expect(
      adapter(async () => {
        calls += 1;
        return jsonResponse(metadata());
      }).describeData({ data_id: "../../private" }),
    ).rejects.toBeInstanceOf(AppError);
    expect(calls).toBe(0);
  });
});
