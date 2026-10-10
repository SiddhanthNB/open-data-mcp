import { describe, expect, it } from "vitest";

import {
  EIRGRID_ACCESS_ID,
  EIRGRID_ATTRIBUTION,
  EIRGRID_DATASETS,
  EIRGRID_INTERCONNECTOR_TEMPLATE,
  EIRGRID_SOURCE_ID,
  EIRGRID_VARGEN_TEMPLATE,
  EirGridAdapter,
  dublinRequestTimestamp,
  type EirGridSettings,
} from "../../src/providers/eirgrid";

const NOW = new Date("2026-10-10T12:00:00.000Z");

function settings(overrides: Partial<EirGridSettings> = {}): EirGridSettings {
  return {
    sourceId: EIRGRID_SOURCE_ID,
    accessId: EIRGRID_ACCESS_ID,
    attribution: EIRGRID_ATTRIBUTION,
    datasets: EIRGRID_DATASETS,
    timeoutMs: 1_000,
    maxInputBytes: 100_000,
    maxOutputBytes: 100_000,
    defaultLimit: 10,
    maxLimit: 100,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface RecordedCall {
  url: string;
  init?: RequestInit;
}

function recordingFetch(response: Response): {
  fetcher: typeof fetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  return {
    calls,
    fetcher: (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), ...(init ? { init } : {}) });
      return response;
    }) as typeof fetch,
  };
}

function adapter(
  fetcher: typeof fetch,
  overrides: Partial<EirGridSettings> = {},
): EirGridAdapter {
  return new EirGridAdapter(settings(overrides), {
    fetch: fetcher,
    now: () => NOW,
  });
}

function windBody(region = "ROI"): Record<string, unknown> {
  return {
    LastModified: null,
    Status: "Success",
    ErrorMessage: "",
    Rows: [
      {
        Effective_Date: "01-07-2026 01:00:00",
        MW_ACTUAL: "1200",
        MW_FORECAST: "1300",
        Region: region,
      },
      {
        Effective_Date: "01-07-2026 01:15:00",
        MW_ACTUAL: "1210",
        MW_FORECAST: "1310",
        Region: region,
      },
      {
        Effective_Date: "01-07-2026 01:30:00",
        MW_ACTUAL: "1220",
        MW_FORECAST: "1320",
        Region: region,
      },
    ],
  };
}

function interconnectorBody(): Record<string, unknown> {
  return {
    Status: "Success",
    Rows: [
      {
        Effective_Date: "01-01-2026 00:00:00",
        Field_Name: "INTER_EWIC",
        Region: "ROI",
        Value: -200,
      },
      {
        Effective_Date: "01-01-2026 00:00:00",
        Field_Name: "INTER_MOYLE",
        Region: "NI",
        Value: 50,
      },
      {
        Effective_Date: "01-01-2026 00:00:00",
        Field_Name: "INTER_NET",
        Region: "ALL",
        Value: -150,
      },
    ],
  };
}

function windQuery() {
  return {
    data_id: "wind_generation",
    access_id: EIRGRID_ACCESS_ID,
    fields: ["Effective_Date", "MW_ACTUAL"],
    filters: [{ field: "Region", operator: "eq" as const, value: "ROI" }],
    time_range: {
      start: "2026-07-01T00:00:00Z",
      end: "2026-07-01T01:00:00Z",
    },
    limit: 1,
    offset: 1,
  };
}

describe("EirGridAdapter", () => {
  it("requires the exact official catalogue, templates, attribution and safe limits", () => {
    const unused = async () => jsonResponse({ Rows: [] });
    const windDataset = EIRGRID_DATASETS.find(
      (dataset) => dataset.dataId === "wind_generation",
    );
    if (!windDataset || windDataset.kind !== "variable_generation") {
      throw new Error("Missing wind fixture");
    }
    expect(
      () =>
        adapter(unused, {
          attribution: "EirGrid" as typeof EIRGRID_ATTRIBUTION,
        }),
    ).toThrow(RangeError);
    expect(
      () =>
        adapter(unused, {
          datasets: [
            {
              ...windDataset,
              endpointTemplate:
                "https://example.test/{start}/{end}/{region}/{area}" as typeof EIRGRID_VARGEN_TEMPLATE,
            },
            EIRGRID_DATASETS[1]!,
            EIRGRID_DATASETS[2]!,
          ],
        }),
    ).toThrow(RangeError);
    expect(() => adapter(unused, { datasets: EIRGRID_DATASETS.slice(0, 2) })).toThrow(
      RangeError,
    );
    expect(() => adapter(unused, { maxLimit: 101 })).toThrow(RangeError);
  });

  it("exposes a three-item local catalogue with clear geography and query contracts", async () => {
    const instance = adapter(async () => {
      throw new Error("not called");
    });
    const search = await instance.searchData({ query: "generation", limit: 10 });
    expect(search.results.map((item) => item.data_id)).toEqual([
      "wind_generation",
      "solar_generation",
    ]);
    expect(search.results[0]?.description).toContain(EIRGRID_ATTRIBUTION);
    expect(search.results[0]?.description).toContain("ROI, NI or ALL");

    const wind = await instance.describeData({ data_id: "wind_generation" });
    expect(wind).toMatchObject({
      publisher: "EirGrid Group",
      licence: EIRGRID_ATTRIBUTION,
      access_points: [
        {
          access_id: EIRGRID_ACCESS_ID,
          format: "json",
          capabilities: { query: true, link: false },
          upstream_url: EIRGRID_VARGEN_TEMPLATE,
          query_schema: {
            fields: [
              { name: "Effective_Date", type: "datetime", operators: [] },
              { name: "MW_ACTUAL", type: "number", operators: [] },
              { name: "MW_FORECAST", type: "number", operators: [] },
              {
                name: "Region",
                type: "string",
                operators: ["eq"],
                values: [{ value: "ROI" }, { value: "NI" }, { value: "ALL" }],
              },
            ],
            truncated: false,
          },
        },
      ],
    });
    expect(wind.access_points[0]?.description).toContain("Europe/Dublin local wall-clock");
    expect(wind.access_points[0]?.description).toContain(
      "Exactly one Region eq ROI|NI|ALL filter is required",
    );

    const interconnector = await instance.describeData({
      data_id: "interconnector_flows",
    });
    expect(interconnector.description).toContain("EWIC and Greenlink (ROI)");
    expect(interconnector.description).toContain("Moyle (NI)");
    expect(interconnector.description).toContain("net all-island (ALL)");
    expect(interconnector.access_points[0]).toMatchObject({
      upstream_url: EIRGRID_INTERCONNECTOR_TEMPLATE,
      query_schema: {
        fields: expect.arrayContaining([
          {
            name: "Field_Name",
            type: "string",
            operators: ["eq", "in"],
            values: [
              { value: "INTER_EWIC" },
              { value: "INTER_GRNLK" },
              { value: "INTER_MOYLE" },
              { value: "INTER_NET" },
            ],
          },
        ]),
      },
    });
    expect(interconnector.access_points[0]?.description).toContain(
      "One optional Field_Name eq|in filter",
    );
  });

  it("builds only the official wind URL, preserves values, projects fields and paginates locally", async () => {
    const upstream = recordingFetch(jsonResponse(windBody()));
    const result = await adapter(upstream.fetcher).queryData(windQuery());

    expect(upstream.calls).toHaveLength(1);
    expect(upstream.calls[0]?.url).toBe(
      "https://www.vargen.smartgriddashboard.com/api/export/202607010100/202607010200/ROI/WIND?FORMAT=JSON",
    );
    expect(upstream.calls[0]?.init).toMatchObject({
      headers: { accept: "application/json" },
      redirect: "error",
    });
    expect(result.data).toEqual({
      rows: [
        {
          Effective_Date: "01-07-2026 01:15:00",
          MW_ACTUAL: "1210",
        },
      ],
    });
    expect(result.pagination).toEqual({ limit: 1, offset: 1, returned: 1, total: 3 });
    expect(result.provenance).toMatchObject({
      source: "eirgrid",
      upstream_url: upstream.calls[0]?.url,
      original_format: "json",
    });
  });

  it("formats request instants using Ireland local wall-clock time across DST", () => {
    expect(dublinRequestTimestamp(new Date("2026-01-01T00:30:00Z"))).toBe(
      "202601010030",
    );
    expect(dublinRequestTimestamp(new Date("2026-07-01T00:30:00Z"))).toBe(
      "202607010130",
    );
    expect(dublinRequestTimestamp(new Date("2026-03-29T00:30:00Z"))).toBe(
      "202603290030",
    );
    expect(dublinRequestTimestamp(new Date("2026-03-29T01:30:00Z"))).toBe(
      "202603290230",
    );
  });

  it("keeps solar geographic modes separate and rejects an upstream region mismatch", async () => {
    const valid = recordingFetch(jsonResponse(windBody("NI")));
    const result = await adapter(valid.fetcher).queryData({
      ...windQuery(),
      data_id: "solar_generation",
      filters: [{ field: "Region", operator: "eq", value: "NI" }],
      fields: undefined,
    });
    expect(valid.calls[0]?.url).toContain("/NI/SOLAR?FORMAT=JSON");
    expect((result.data as { rows: Array<{ Region: string }> }).rows[0]?.Region).toBe(
      "NI",
    );

    const mismatch = recordingFetch(jsonResponse(windBody("ALL")));
    await expect(
      adapter(mismatch.fetcher).queryData(windQuery()),
    ).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
  });

  it("requires exactly one allowlisted Region eq filter for wind and solar", async () => {
    let calls = 0;
    const instance = adapter(async () => {
      calls += 1;
      return jsonResponse(windBody());
    });
    const invalidFilters = [
      undefined,
      [],
      [{ field: "Region", operator: "eq" as const, value: "GB" }],
      [{ field: "Region", operator: "in" as const, value: ["ROI"] }],
      [{ field: "Field_Name", operator: "eq" as const, value: "ROI" }],
      [
        { field: "Region", operator: "eq" as const, value: "ROI" },
        { field: "Region", operator: "eq" as const, value: "NI" },
      ],
    ];
    for (const filters of invalidFilters) {
      await expect(
        instance.queryData({ ...windQuery(), filters }),
      ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    }
    expect(calls).toBe(0);
  });

  it("uses the fixed ALL interconnector endpoint and applies only Field_Name eq|in locally", async () => {
    const upstream = recordingFetch(jsonResponse(interconnectorBody()));
    const result = await adapter(upstream.fetcher).queryData({
      data_id: "interconnector_flows",
      access_id: EIRGRID_ACCESS_ID,
      fields: ["Field_Name", "Region", "Value"],
      filters: [
        {
          field: "Field_Name",
          operator: "in",
          value: ["INTER_EWIC", "INTER_MOYLE"],
        },
      ],
      time_range: {
        start: "2026-01-01T00:00:00Z",
        end: "2026-01-01T01:00:00Z",
      },
    });

    expect(upstream.calls[0]?.url).toBe(
      "https://www.interconn.smartgriddashboard.com/api/Interconnector/202601010000/202601010100/ALL?format=json",
    );
    expect(result.data).toEqual({
      rows: [
        { Field_Name: "INTER_EWIC", Region: "ROI", Value: -200 },
        { Field_Name: "INTER_MOYLE", Region: "NI", Value: 50 },
      ],
    });
    expect(result.pagination?.total).toBe(2);
  });

  it("returns every explicit interconnector geography when no field filter is supplied", async () => {
    const upstream = recordingFetch(jsonResponse(interconnectorBody()));
    const result = await adapter(upstream.fetcher).queryData({
      data_id: "interconnector_flows",
      access_id: EIRGRID_ACCESS_ID,
      time_range: {
        start: "2026-01-01T00:00:00+00:00",
        end: "2026-01-01T00:30:00+00:00",
      },
    });
    expect(
      (result.data as { rows: Array<{ Region: string }> }).rows.map(
        (row) => row.Region,
      ),
    ).toEqual(["ROI", "NI", "ALL"]);
  });

  it("rejects unsupported interconnector filters and projections before fetching", async () => {
    let calls = 0;
    const instance = adapter(async () => {
      calls += 1;
      return jsonResponse(interconnectorBody());
    });
    const base = {
      data_id: "interconnector_flows",
      access_id: EIRGRID_ACCESS_ID,
      time_range: {
        start: "2026-01-01T00:00:00Z",
        end: "2026-01-01T01:00:00Z",
      },
    };
    for (const filters of [
      [{ field: "Region", operator: "eq" as const, value: "ROI" }],
      [{ field: "Field_Name", operator: "gt" as const, value: "INTER_EWIC" }],
      [{ field: "Field_Name", operator: "eq" as const, value: "INTER_UNKNOWN" }],
      [
        {
          field: "Field_Name",
          operator: "in" as const,
          value: ["INTER_EWIC", "INTER_EWIC"],
        },
      ],
    ]) {
      await expect(instance.queryData({ ...base, filters })).rejects.toMatchObject({
        code: "INVALID_REQUEST",
      });
    }
    for (const fields of [[], ["Unknown"], ["Value", "Value"]]) {
      await expect(instance.queryData({ ...base, fields })).rejects.toMatchObject({
        code: "INVALID_REQUEST",
      });
    }
    await expect(
      instance.queryData({
        ...base,
        spatial: { type: "point", latitude: 53, longitude: -7 },
      }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_OPERATION" });
    expect(calls).toBe(0);
  });

  it("requires valid whole-minute RFC3339 ranges of at most 24 hours", async () => {
    let calls = 0;
    const instance = adapter(async () => {
      calls += 1;
      return jsonResponse(windBody());
    });
    const invalidRanges = [
      undefined,
      { start: "2026-01-01", end: "2026-01-01T01:00:00Z" },
      { start: "2026-02-30T00:00:00Z", end: "2026-03-01T01:00:00Z" },
      { start: "2026-01-01T00:00:01Z", end: "2026-01-01T01:00:00Z" },
      { start: "2026-01-01T01:00:00Z", end: "2026-01-01T00:00:00Z" },
      { start: "2026-01-01T00:00:00Z", end: "2026-01-02T00:01:00Z" },
    ];
    for (const time_range of invalidRanges) {
      await expect(
        instance.queryData({ ...windQuery(), time_range }),
      ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    }
    expect(calls).toBe(0);
  });

  it("validates IDs, paging and dynamic-link behavior", async () => {
    const instance = adapter(async () => jsonResponse(windBody()));
    await expect(instance.describeData({ data_id: "unknown" })).rejects.toMatchObject({
      code: "DATASET_NOT_FOUND",
    });
    await expect(
      instance.queryData({ ...windQuery(), access_id: "download" }),
    ).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    await expect(
      instance.queryData({ ...windQuery(), limit: 101 }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(
      instance.getDataLink({
        data_id: "wind_generation",
        access_id: EIRGRID_ACCESS_ID,
      }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_OPERATION" });
  });

  it("maps 429, 5xx, malformed payloads and upstream failure status to stable errors", async () => {
    const cases: Array<{ response: Response; code: string }> = [
      { response: jsonResponse({}, 429), code: "RATE_LIMITED" },
      { response: jsonResponse({}, 503), code: "UPSTREAM_ERROR" },
      { response: jsonResponse({ data: [] }), code: "UPSTREAM_ERROR" },
      {
        response: jsonResponse({ Status: "Failure", Rows: [] }),
        code: "UPSTREAM_ERROR",
      },
      {
        response: new Response("<html></html>", {
          headers: { "content-type": "text/html" },
        }),
        code: "UPSTREAM_ERROR",
      },
      {
        response: jsonResponse({ Rows: [{ Value: { nested: true } }] }),
        code: "UPSTREAM_ERROR",
      },
    ];
    for (const item of cases) {
      await expect(
        adapter(async () => item.response).queryData(windQuery()),
      ).rejects.toMatchObject({ code: item.code });
    }
  });

  it("enforces input and output byte limits", async () => {
    await expect(
      adapter(async () => jsonResponse(windBody()), {
        maxInputBytes: 20,
      }).queryData(windQuery()),
    ).rejects.toMatchObject({ code: "RESOURCE_TOO_LARGE" });

    await expect(
      adapter(async () => jsonResponse(windBody()), {
        maxOutputBytes: 200,
      }).queryData(windQuery()),
    ).rejects.toMatchObject({ code: "RESOURCE_TOO_LARGE" });
  });

  it("maps an aborted request to UPSTREAM_TIMEOUT", async () => {
    const hangingFetch = (() => new Promise<Response>(() => undefined)) as typeof fetch;
    await expect(
      adapter(hangingFetch, { timeoutMs: 5 }).queryData(windQuery()),
    ).rejects.toMatchObject({ code: "UPSTREAM_TIMEOUT" });
  });
});
