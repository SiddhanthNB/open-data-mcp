import { describe, expect, it } from "vitest";

import { AppError } from "../../src/errors";
import type { ProviderConfig, ResourceFormat, Source } from "../../src/models";
import { DataGovAdapter } from "../../src/providers/data-gov-ie";
import {
  type CkanAdapterDependencies,
  type ResourceLoadRequest,
  type ResourceLoadResult,
  type ResourceLoader,
} from "../../src/providers/ckan/index";
import { MetEireannAdapter } from "../../src/providers/met-eireann";
import { SmartDublinAdapter } from "../../src/providers/smart-dublin";

const NOW = new Date("2026-10-04T12:00:00.000Z");
const DEFAULT_RESOURCE_LIMITS = {
  maxInputBytes: 1_000_000,
  maxOutputBytes: 1_000_000,
};

function config(
  provider: Source = "data_gov_ie",
  scope?: ProviderConfig["scope"],
): ProviderConfig {
  return {
    provider,
    type: "catalogue",
    base_url: "https://catalogue.example.test",
    endpoints: {
      package_search: "/api/3/action/package_search",
      package_show: "/api/3/action/package_show",
      datastore_search: "/api/3/action/datastore_search",
    },
    http_timeout_ms: 1_000,
    pagination: { default_limit: 10, max_limit: 100 },
    capabilities: {
      search_data_by_source: true,
      describe_data_by_id: true,
      query_data_by_id: true,
      get_data_link_by_id: true,
    },
    formats: ["csv", "json", "xml"],
    ...(scope ? { scope } : {}),
  };
}

function packageRecord(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "dataset-1",
    name: "dataset-one",
    title: "Dataset One",
    notes: "Original description",
    owner_org: "publisher-id",
    organization: { name: "publisher-id", title: "Publisher" },
    license_title: "CC BY 4.0",
    tags: [{ name: "transport" }, { name: "traffic" }],
    resources: [
      {
        id: "resource-csv",
        name: "CSV rows",
        description: "Raw rows",
        format: "CSV",
        url: "https://files.example.test/rows.csv",
        size: 1_234,
        last_modified: "2026-10-01T10:30:00",
        datastore_active: true,
      },
      {
        id: "resource-json",
        format: "application/json",
        url: "https://files.example.test/rows.json",
        datastore_active: false,
      },
      {
        id: "resource-xml",
        format: "application/xml",
        url: "https://files.example.test/rows.xml",
        datastore_active: false,
      },
      {
        id: "resource-pdf",
        format: "PDF",
        url: "https://files.example.test/rows.pdf",
        datastore_active: false,
      },
    ],
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function success(result: unknown): Response {
  return jsonResponse({ help: "upstream help", success: true, result });
}

function successText(result: unknown): string {
  return JSON.stringify({ help: "upstream help", success: true, result });
}

function serializedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function queuedFetch(...responses: Response[]): {
  fetcher: typeof fetch;
  calls: Array<{ url: string; init?: RequestInit }>;
} {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let responseIndex = 0;
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), ...(init ? { init } : {}) });
    const response = responses[responseIndex++];
    if (!response) {
      throw new Error("Unexpected fetch");
    }
    return response;
  }) as typeof fetch;
  return { fetcher, calls };
}

function recordingLoader(result: ResourceLoadResult = { data: [] }): {
  loader: ResourceLoader;
  calls: ResourceLoadRequest[];
} {
  const calls: ResourceLoadRequest[] = [];
  return {
    calls,
    loader: {
      async load(input) {
        calls.push(input);
        return result;
      },
    },
  };
}

function dependencies(
  fetcher: typeof fetch,
  resourceLoader: ResourceLoader,
  limits: Partial<typeof DEFAULT_RESOURCE_LIMITS> = {},
): CkanAdapterDependencies {
  return {
    fetch: fetcher,
    resourceLoader,
    now: () => NOW,
    ...DEFAULT_RESOURCE_LIMITS,
    ...limits,
  };
}

describe("shared CKAN adapter", () => {
  it("rejects unsupported selectors before calling CKAN", async () => {
    const upstream = queuedFetch();
    const direct = recordingLoader();
    const adapter = new DataGovAdapter(
      config(),
      dependencies(upstream.fetcher, direct.loader),
    );

    for (const selectors of [
      { fields: ["value"] },
      { filters: [{ field: "value", operator: "eq" as const, value: 1 }] },
      { spatial: { type: "point" as const, latitude: 53, longitude: -6 } },
      {
        time_range: {
          start: "2026-10-10T00:00:00.000Z",
          end: "2026-10-10T01:00:00.000Z",
        },
      },
    ]) {
      await expect(
        adapter.queryData({
          data_id: "dataset-1",
          access_id: "resource-json",
          ...selectors,
        }),
      ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    }

    expect(upstream.calls).toHaveLength(0);
    expect(direct.calls).toHaveLength(0);
  });

  it("translates search pagination and maps the common dataset model", async () => {
    const upstream = queuedFetch(
      success({ count: 42, results: [packageRecord()] }),
    );
    const direct = recordingLoader();
    const adapter = new DataGovAdapter(
      config(),
      dependencies(upstream.fetcher, direct.loader),
    );

    const result = await adapter.searchData({
      query: "traffic",
      limit: 7,
      offset: 14,
    });

    const url = new URL(upstream.calls[0]!.url);
    expect(url.pathname).toBe("/api/3/action/package_search");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      rows: "7",
      start: "14",
      q: "traffic",
    });
    expect(result.pagination).toEqual({
      limit: 7,
      offset: 14,
      returned: 1,
      total: 42,
    });
    expect(result.results[0]).toEqual({
      data_id: "dataset-1",
      title: "Dataset One",
      description: "Original description",
      publisher: "Publisher",
      available_formats: ["csv", "json", "xml", "pdf"],
      provenance: {
        source: "data_gov_ie",
        upstream_url:
          "https://catalogue.example.test/api/3/action/package_show?id=dataset-1",
        retrieved_at: NOW.toISOString(),
      },
    });
  });

  it("uses configured search pagination defaults", async () => {
    const upstream = queuedFetch(success({ count: 0, results: [] }));
    const direct = recordingLoader();
    const adapter = new DataGovAdapter(
      config(),
      dependencies(upstream.fetcher, direct.loader),
    );

    const result = await adapter.searchData({});

    const url = new URL(upstream.calls[0]!.url);
    expect(url.searchParams.get("rows")).toBe("10");
    expect(url.searchParams.get("start")).toBe("0");
    expect(result.pagination).toEqual({
      limit: 10,
      offset: 0,
      returned: 0,
      total: 0,
    });
  });

  it("maps every detailed dataset resource and marks retrieval support", async () => {
    const upstream = queuedFetch(success(packageRecord()));
    const direct = recordingLoader();
    const adapter = new SmartDublinAdapter(
      config("smart_dublin"),
      dependencies(upstream.fetcher, direct.loader),
    );

    const result = await adapter.describeData({ data_id: "dataset-1" });

    expect(result).toMatchObject({
      data_id: "dataset-1",
      title: "Dataset One",
      description: "Original description",
      publisher: "Publisher",
      licence: "CC BY 4.0",
      tags: ["transport", "traffic"],
      provenance: { source: "smart_dublin" },
    });
    expect(result.access_points).toEqual([
      {
        access_id: "resource-csv",
        title: "CSV rows",
        description: "Raw rows",
        format: "csv",
        capabilities: { query: true, link: true },
        size: 1_234,
        last_modified: "2026-10-01T10:30:00",
        upstream_url: "https://files.example.test/rows.csv",
      },
      {
        access_id: "resource-json",
        format: "json",
        capabilities: { query: true, link: true },
        upstream_url: "https://files.example.test/rows.json",
      },
      {
        access_id: "resource-xml",
        format: "xml",
        capabilities: { query: true, link: true },
        upstream_url: "https://files.example.test/rows.xml",
      },
      {
        access_id: "resource-pdf",
        format: "pdf",
        capabilities: { query: false, link: true },
        upstream_url: "https://files.example.test/rows.pdf",
      },
    ]);
  });

  it("returns catalogued link metadata without loading resource bytes", async () => {
    const upstream = queuedFetch(success(packageRecord()));
    const direct = recordingLoader();
    const adapter = new DataGovAdapter(
      config(),
      dependencies(upstream.fetcher, direct.loader),
    );

    const result = await adapter.getDataLink({
      data_id: "dataset-1",
      access_id: "resource-pdf",
    });

    expect(upstream.calls).toHaveLength(1);
    expect(direct.calls).toHaveLength(0);
    expect(result).toEqual({
      data_id: "dataset-1",
      access_id: "resource-pdf",
      url: "https://files.example.test/rows.pdf",
      format: "pdf",
      provenance: {
        source: "data_gov_ie",
        upstream_url: "https://files.example.test/rows.pdf",
        retrieved_at: NOW.toISOString(),
        original_format: "pdf",
      },
    });
  });

  it("rejects catalogued links that are not browser-openable HTTP URLs", async () => {
    const upstream = queuedFetch(
      success(
        packageRecord({
          resources: [
            {
              id: "resource-private",
              format: "ZIP",
              url: "file:///private/data.zip",
            },
          ],
        }),
      ),
    );
    const direct = recordingLoader();
    const adapter = new DataGovAdapter(
      config(),
      dependencies(upstream.fetcher, direct.loader),
    );

    await expect(
      adapter.getDataLink({
        data_id: "dataset-1",
        access_id: "resource-private",
      }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_OPERATION" });
    expect(direct.calls).toHaveLength(0);
  });

  it("normalizes dataset and resource descriptions to visible plain text", async () => {
    const upstream = queuedFetch(
      success(
        packageRecord({
          notes:
            '<style>.x { color: red }</style><p>Public&nbsp;<strong>data</strong></p><script>hidden()</script>',
          resources: [
            {
              id: "resource-csv",
              description:
                '<a href="https://example.safelinks.protection.outlook.com/?url=mailto%3Ahidden%40example.ie">Contact us</a>',
              format: "CSV",
              url: "https://files.example.test/rows.csv",
            },
          ],
        }),
      ),
    );
    const direct = recordingLoader();
    const adapter = new DataGovAdapter(
      config(),
      dependencies(upstream.fetcher, direct.loader),
    );

    const result = await adapter.describeData({ data_id: "dataset-1" });

    expect(result.description).toBe("Public data");
    expect(result.access_points[0]?.description).toBe("Contact us");
  });

  it("lists normalized unsupported formats and ignores empty formats", async () => {
    const upstream = queuedFetch(
      success({
        count: 1,
        results: [
          packageRecord({
            resources: [
              {
                id: "resource-xlsx",
                format: " XLSX ",
                url: "https://files.example.test/rows.xlsx",
              },
              {
                id: "resource-zip",
                format: "ZIP",
                url: "https://files.example.test/rows.zip",
              },
              {
                id: "resource-geojson",
                format: "GeoJSON",
                url: "https://files.example.test/stations.geojson",
              },
              {
                id: "resource-empty",
                format: "   ",
                url: "https://files.example.test/empty",
              },
            ],
          }),
        ],
      }),
    );
    const direct = recordingLoader();
    const adapter = new DataGovAdapter(
      config(),
      dependencies(upstream.fetcher, direct.loader),
    );

    const result = await adapter.searchData({});

    expect(result.results[0]?.available_formats).toEqual([
      "xlsx",
      "zip",
      "geojson",
    ]);
  });

  it("keeps resources with missing formats as explicitly unsupported metadata", async () => {
    const upstream = queuedFetch(
      success(
        packageRecord({
          resources: [
            {
              id: "resource-blank",
              format: "   ",
              url: "https://files.example.test/blank",
            },
            {
              id: "resource-missing",
              url: "https://files.example.test/missing",
            },
          ],
        }),
      ),
    );
    const direct = recordingLoader();
    const adapter = new DataGovAdapter(
      config(),
      dependencies(upstream.fetcher, direct.loader),
    );

    const result = await adapter.describeData({ data_id: "dataset-1" });

    expect(result.available_formats).toBeUndefined();
    expect(result.access_points).toEqual([
      {
        access_id: "resource-blank",
        format: "unknown",
        capabilities: { query: false, link: true },
        upstream_url: "https://files.example.test/blank",
      },
      {
        access_id: "resource-missing",
        format: "unknown",
        capabilities: { query: false, link: true },
        upstream_url: "https://files.example.test/missing",
      },
    ]);
  });

  it("bases the supported flag on the provider format configuration", async () => {
    const upstream = queuedFetch(
      success(
        packageRecord({
          tags: [
            { name: " Daily " },
            { name: "Daily" },
            { name: " " },
            { name: "Meteorology" },
          ],
        }),
      ),
    );
    const direct = recordingLoader();
    const csvOnlyConfig = { ...config(), formats: ["csv"] as const };
    const adapter = new DataGovAdapter(
      csvOnlyConfig,
      dependencies(upstream.fetcher, direct.loader),
    );

    const result = await adapter.describeData({ data_id: "dataset-1" });

    expect(result.tags).toEqual(["Daily", "Meteorology"]);
    expect(result.access_points.map(({ format, capabilities }) => ({
      format,
      query: capabilities.query,
    }))).toEqual([
      { format: "csv", query: true },
      { format: "json", query: false },
      { format: "xml", query: false },
      { format: "pdf", query: false },
    ]);
  });

  it("adds the configured Met Eireann scope to search", async () => {
    const upstream = queuedFetch(success({ count: 0, results: [] }));
    const direct = recordingLoader();
    const adapter = new MetEireannAdapter(
      config("met_eireann", {
        organization_name: "meteireann",
        organization_id: "met-eireann",
      }),
      dependencies(upstream.fetcher, direct.loader),
    );

    await adapter.searchData({});

    expect(new URL(upstream.calls[0]!.url).searchParams.get("fq")).toBe(
      "organization:meteireann",
    );
  });

  it("filters search results outside the configured Met Eireann owner scope", async () => {
    const upstream = queuedFetch(
      success({
        count: 2,
        results: [
          packageRecord({
            id: "met-dataset",
            name: "met-dataset",
            owner_org: "met-eireann",
          }),
          packageRecord({
            id: "other-dataset",
            name: "other-dataset",
            owner_org: "another-publisher",
          }),
        ],
      }),
    );
    const direct = recordingLoader();
    const adapter = new MetEireannAdapter(
      config("met_eireann", {
        organization_name: "meteireann",
        organization_id: "met-eireann",
      }),
      dependencies(upstream.fetcher, direct.loader),
    );

    const result = await adapter.searchData({});

    expect(result.results.map((dataset) => dataset.data_id)).toEqual([
      "met-dataset",
    ]);
    expect(result.pagination).toEqual({
      limit: 10,
      offset: 0,
      returned: 1,
      total: 2,
    });
  });

  it("hides datasets outside the configured Met Eireann owner scope", async () => {
    const upstream = queuedFetch(
      success(packageRecord({ owner_org: "another-publisher" })),
    );
    const direct = recordingLoader();
    const adapter = new MetEireannAdapter(
      config("met_eireann", {
        organization_name: "meteireann",
        organization_id: "met-eireann",
      }),
      dependencies(upstream.fetcher, direct.loader),
    );

    await expect(
      adapter.describeData({ data_id: "dataset-1" }),
    ).rejects.toMatchObject({ code: "DATASET_NOT_FOUND" });
  });

  it("blocks resource lookup outside the configured Met Eireann owner scope", async () => {
    const upstream = queuedFetch(
      success(packageRecord({ owner_org: "another-publisher" })),
    );
    const direct = recordingLoader();
    const adapter = new MetEireannAdapter(
      config("met_eireann", {
        organization_name: "meteireann",
        organization_id: "met-eireann",
      }),
      dependencies(upstream.fetcher, direct.loader),
    );

    await expect(
      adapter.queryData({
        data_id: "dataset-1",
        access_id: "resource-json",
      }),
    ).rejects.toMatchObject({ code: "DATASET_NOT_FOUND" });
    expect(direct.calls).toHaveLength(0);
  });

  it("uses DataStore pagination without calling the direct loader", async () => {
    const dataset = packageRecord();
    const upstream = queuedFetch(
      success(dataset),
      success({ total: 21, records: [{ row: 1 }, { row: 2 }] }),
    );
    const direct = recordingLoader();
    const adapter = new DataGovAdapter(
      config(),
      dependencies(upstream.fetcher, direct.loader),
    );

    const result = await adapter.queryData({
      data_id: "dataset-1",
      access_id: "resource-csv",
      limit: 2,
      offset: 4,
    });

    const datastoreUrl = new URL(upstream.calls[1]!.url);
    expect(datastoreUrl.pathname).toBe("/api/3/action/datastore_search");
    expect(Object.fromEntries(datastoreUrl.searchParams)).toEqual({
      resource_id: "resource-csv",
      limit: "2",
      offset: "4",
    });
    expect(direct.calls).toHaveLength(0);
    expect(result).toEqual({
      data_id: "dataset-1",
      access_id: "resource-csv",
      data: [{ row: 1 }, { row: 2 }],
      provenance: {
        source: "data_gov_ie",
        upstream_url: datastoreUrl.toString(),
        retrieved_at: NOW.toISOString(),
        original_format: "csv",
      },
      pagination_supported: true,
      pagination: { limit: 2, offset: 4, returned: 2, total: 21 },
    });
  });

  it("retrieves a DataStore resource regardless of its original file format", async () => {
    const dataset = packageRecord({
      resources: [
        {
          id: "resource-xlsx",
          format: "XLSX",
          url: "https://files.example.test/rows.xlsx",
          datastore_active: true,
        },
      ],
    });
    const upstream = queuedFetch(
      success(dataset),
      success({ total: 1, records: [{ row: 1 }] }),
    );
    const direct = recordingLoader();
    const adapter = new DataGovAdapter(
      config(),
      dependencies(upstream.fetcher, direct.loader),
    );

    const result = await adapter.queryData({
      data_id: "dataset-1",
      access_id: "resource-xlsx",
    });

    expect(result.provenance.original_format).toBe("xlsx");
    expect(result.data).toEqual([{ row: 1 }]);
    expect(direct.calls).toHaveLength(0);
  });

  it("rejects an oversized DataStore response body", async () => {
    const upstream = queuedFetch(
      success(packageRecord()),
      success({
        total: 1,
        records: [{ value: "x".repeat(10_000) }],
      }),
    );
    const direct = recordingLoader();
    const adapter = new DataGovAdapter(
      config(),
      dependencies(upstream.fetcher, direct.loader, {
        maxInputBytes: 2_000,
      }),
    );

    await expect(
      adapter.queryData({
        data_id: "dataset-1",
        access_id: "resource-csv",
      }),
    ).rejects.toMatchObject({ code: "RESOURCE_TOO_LARGE" });
    expect(direct.calls).toHaveLength(0);
  });

  it("allows exact DataStore input and normalized output byte boundaries", async () => {
    const dataset = packageRecord();
    const datastore = { total: 1, records: [{ row: 1 }] };
    const parameters = new URLSearchParams({
      resource_id: "resource-csv",
      limit: "1",
      offset: "0",
    });
    const expected = {
      data_id: "dataset-1",
      access_id: "resource-csv",
      data: [{ row: 1 }],
      provenance: {
        source: "data_gov_ie",
        upstream_url: `https://catalogue.example.test/api/3/action/datastore_search?${parameters}`,
        retrieved_at: NOW.toISOString(),
        original_format: "csv",
      },
      pagination_supported: true,
      pagination: { limit: 1, offset: 0, returned: 1, total: 1 },
    };
    const maxInputBytes = Math.max(
      new TextEncoder().encode(successText(dataset)).byteLength,
      new TextEncoder().encode(successText(datastore)).byteLength,
    );
    const maxOutputBytes = serializedBytes(expected);
    const upstream = queuedFetch(
      new Response(successText(dataset), {
        headers: { "content-length": String(maxInputBytes) },
      }),
      new Response(successText(datastore), {
        headers: { "content-length": String(maxInputBytes) },
      }),
    );
    const direct = recordingLoader();
    const adapter = new DataGovAdapter(
      config(),
      dependencies(upstream.fetcher, direct.loader, {
        maxInputBytes,
        maxOutputBytes,
      }),
    );

    await expect(
      adapter.queryData({
        data_id: "dataset-1",
        access_id: "resource-csv",
        limit: 1,
      }),
    ).resolves.toEqual(expected);
  });

  it("rejects a normalized DataStore envelope above the output limit", async () => {
    const datastore = { total: 1, records: [{ row: 1 }] };
    const expected = {
      data_id: "dataset-1",
      access_id: "resource-csv",
      data: datastore.records,
      provenance: {
        source: "data_gov_ie",
        upstream_url:
          "https://catalogue.example.test/api/3/action/datastore_search?resource_id=resource-csv&limit=1&offset=0",
        retrieved_at: NOW.toISOString(),
        original_format: "csv",
      },
      pagination_supported: true,
      pagination: { limit: 1, offset: 0, returned: 1, total: 1 },
    };
    const upstream = queuedFetch(success(packageRecord()), success(datastore));
    const direct = recordingLoader();
    const adapter = new DataGovAdapter(
      config(),
      dependencies(upstream.fetcher, direct.loader, {
        maxOutputBytes: serializedBytes(expected) - 1,
      }),
    );

    await expect(
      adapter.queryData({
        data_id: "dataset-1",
        access_id: "resource-csv",
        limit: 1,
      }),
    ).rejects.toMatchObject({ code: "RESOURCE_TOO_LARGE" });
  });

  it("bounds the complete normalized direct-resource envelope", async () => {
    const upstream = queuedFetch(success(packageRecord()));
    const direct = recordingLoader({ data: [] });
    const adapter = new DataGovAdapter(
      config(),
      dependencies(upstream.fetcher, direct.loader, {
        maxOutputBytes: serializedBytes([]),
      }),
    );

    await expect(
      adapter.queryData({
        data_id: "dataset-1",
        access_id: "resource-json",
      }),
    ).rejects.toMatchObject({ code: "RESOURCE_TOO_LARGE" });
  });

  it.each([
    ["resource-json", "json"],
    ["resource-xml", "xml"],
  ] as const)(
    "delegates direct %s resources to the shared loader",
    async (resourceId, format) => {
      const upstream = queuedFetch(success(packageRecord()));
      const direct = recordingLoader({
        data: [{ untouched: true }],
        pagination: { limit: 5, offset: 1, returned: 1 },
      });
      const adapter = new DataGovAdapter(
        config(),
        dependencies(upstream.fetcher, direct.loader),
      );

      const result = await adapter.queryData({
        data_id: "dataset-1",
        access_id: resourceId,
        limit: 5,
        offset: 1,
      });

      expect(direct.calls).toEqual([
        {
          url: `https://files.example.test/rows.${format}`,
          format,
          limit: 5,
          offset: 1,
          timeout_ms: 1_000,
        },
      ]);
      expect(result.data).toEqual([{ untouched: true }]);
      expect(result.provenance.original_format).toBe(format);
      expect(result.pagination).toEqual({
        limit: 5,
        offset: 1,
        returned: 1,
      });
    },
  );

  it.each([
    ["CSV", "csv", "csv"],
    ["GeoJSON", "json", "geojson"],
    ["application/vnd.api+json", "json", "application/vnd.api+json"],
    ["XML", "xml", "xml"],
    ["application/atom+xml", "xml", "application/atom+xml"],
  ] as const)(
    "uses the exact %s label as a %s resource without losing provenance",
    async (advertisedFormat, handlerFormat, originalFormat) => {
      const dataset = packageRecord({
        resources: [
          {
            id: "resource-direct",
            format: advertisedFormat,
            url: "https://files.example.test/direct",
          },
        ],
      });
      const upstream = queuedFetch(success(dataset));
      const direct = recordingLoader({ data: { ok: true } });
      const adapter = new DataGovAdapter(
        config(),
        dependencies(upstream.fetcher, direct.loader),
      );

      const result = await adapter.queryData({
        data_id: "dataset-1",
        access_id: "resource-direct",
      });

      expect(direct.calls[0]?.format).toBe(handlerFormat);
      expect(result.provenance.original_format).toBe(originalFormat);
    },
  );

  it.each([
    "XLSX",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "JSONL",
    "JSONP",
    "JSON; profile=example",
  ])("does not infer direct support from the %s label", async (format) => {
    const dataset = packageRecord({
      resources: [
        {
          id: "resource-direct",
          format,
          url: "https://files.example.test/direct",
        },
      ],
    });
    const upstream = queuedFetch(success(dataset));
    const direct = recordingLoader();
    const adapter = new DataGovAdapter(
      config(),
      dependencies(upstream.fetcher, direct.loader),
    );

    await expect(
      adapter.queryData({
        data_id: "dataset-1",
        access_id: "resource-direct",
      }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_FORMAT" });
    expect(direct.calls).toHaveLength(0);
  });

  it("verifies resource membership before loading", async () => {
    const upstream = queuedFetch(success(packageRecord()));
    const direct = recordingLoader();
    const adapter = new DataGovAdapter(
      config(),
      dependencies(upstream.fetcher, direct.loader),
    );

    await expect(
      adapter.queryData({
        data_id: "dataset-1",
        access_id: "not-in-dataset",
      }),
    ).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    expect(direct.calls).toHaveLength(0);
  });

  it("rejects unsupported resource formats", async () => {
    const upstream = queuedFetch(success(packageRecord()));
    const direct = recordingLoader();
    const adapter = new DataGovAdapter(
      config(),
      dependencies(upstream.fetcher, direct.loader),
    );

    await expect(
      adapter.queryData({
        data_id: "dataset-1",
        access_id: "resource-pdf",
      }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_FORMAT" });
  });

  it("rejects pagination above the configured maximum", async () => {
    const upstream = queuedFetch();
    const direct = recordingLoader();
    const adapter = new DataGovAdapter(
      config(),
      dependencies(upstream.fetcher, direct.loader),
    );

    await expect(
      adapter.searchData({ limit: 101 }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(upstream.calls).toHaveLength(0);
  });
});

describe("CKAN failure mapping", () => {
  const cases: Array<{
    name: string;
    response: Response;
    code: AppError["code"];
  }> = [
    {
      name: "rate limit status",
      response: jsonResponse({}, 429),
      code: "RATE_LIMITED",
    },
    {
      name: "upstream status",
      response: jsonResponse({}, 503),
      code: "UPSTREAM_ERROR",
    },
    {
      name: "missing success envelope",
      response: jsonResponse({ result: {} }),
      code: "UPSTREAM_ERROR",
    },
    {
      name: "success envelope with an error",
      response: jsonResponse({ success: true, result: {}, error: {} }),
      code: "UPSTREAM_ERROR",
    },
    {
      name: "failure envelope",
      response: jsonResponse({ success: false, error: { message: "bad" } }),
      code: "UPSTREAM_ERROR",
    },
  ];

  it.each(cases)("maps $name", async ({ response, code }) => {
    const upstream = queuedFetch(response);
    const direct = recordingLoader();
    const adapter = new DataGovAdapter(
      config(),
      dependencies(upstream.fetcher, direct.loader),
    );

    await expect(adapter.searchData({})).rejects.toMatchObject({ code });
  });

  it.each([400, 409])(
    "maps package_search HTTP %s to a safe invalid-query error",
    async (status) => {
      const upstream = queuedFetch(
        jsonResponse(
          {
            success: false,
            error: {
              __type: "Search Error",
              message: "raw backend details must not be returned",
            },
          },
          status,
        ),
      );
      const direct = recordingLoader();
      const adapter = new DataGovAdapter(
        config(),
        dependencies(upstream.fetcher, direct.loader),
      );

      await expect(
        adapter.searchData({ query: "title:(broken" }),
      ).rejects.toMatchObject({
        code: "INVALID_REQUEST",
        message: "The search query is invalid.",
      });
    },
  );

  it("keeps unrelated package_search HTTP 409 failures as upstream errors", async () => {
    const upstream = queuedFetch(
      jsonResponse(
        {
          success: false,
          error: { __type: "Conflict Error", message: "backend conflict" },
        },
        409,
      ),
    );
    const direct = recordingLoader();
    const adapter = new DataGovAdapter(
      config(),
      dependencies(upstream.fetcher, direct.loader),
    );

    await expect(adapter.searchData({})).rejects.toMatchObject({
      code: "UPSTREAM_ERROR",
    });
  });

  it("maps CKAN Search Error envelopes to a safe invalid-query error", async () => {
    const upstream = queuedFetch(
      jsonResponse({
        success: false,
        error: {
          __type: "Search Error",
          message: "raw backend details must not be returned",
        },
      }),
    );
    const direct = recordingLoader();
    const adapter = new DataGovAdapter(
      config(),
      dependencies(upstream.fetcher, direct.loader),
    );

    await expect(
      adapter.searchData({ query: "title:(broken" }),
    ).rejects.toMatchObject({
      code: "INVALID_REQUEST",
      message: "The search query is invalid.",
    });
  });

  it("keeps network failures mapped to UPSTREAM_ERROR", async () => {
    const fetcher = (async () => {
      throw new TypeError("network unavailable");
    }) as typeof fetch;
    const direct = recordingLoader();
    const adapter = new DataGovAdapter(
      config(),
      dependencies(fetcher, direct.loader),
    );

    await expect(adapter.searchData({})).rejects.toMatchObject({
      code: "UPSTREAM_ERROR",
    });
  });

  it("maps aborted fetches to UPSTREAM_TIMEOUT", async () => {
    const fetcher = (async () => {
      throw new DOMException("aborted", "AbortError");
    }) as typeof fetch;
    const direct = recordingLoader();
    const adapter = new DataGovAdapter(
      config(),
      dependencies(fetcher, direct.loader),
    );

    await expect(adapter.searchData({})).rejects.toMatchObject({
      code: "UPSTREAM_TIMEOUT",
    });
  });

  it("keeps the timeout active while reading the response body", async () => {
    const timeoutConfig = { ...config(), http_timeout_ms: 10 };
    const fetcher = (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const signal = init?.signal;
      const body = new ReadableStream({
        start(controller) {
          signal?.addEventListener("abort", () => {
            controller.error(new DOMException("aborted", "AbortError"));
          });
        },
      });
      return new Response(body, {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const direct = recordingLoader();
    const adapter = new DataGovAdapter(
      timeoutConfig,
      dependencies(fetcher, direct.loader),
    );

    await expect(adapter.searchData({})).rejects.toMatchObject({
      code: "UPSTREAM_TIMEOUT",
    });
  });

  it("maps CKAN not-found envelopes for package_show", async () => {
    const upstream = queuedFetch(
      jsonResponse({
        success: false,
        error: { __type: "Not Found Error", message: "Not found" },
      }),
    );
    const direct = recordingLoader();
    const adapter = new DataGovAdapter(
      config(),
      dependencies(upstream.fetcher, direct.loader),
    );

    await expect(
      adapter.describeData({ data_id: "missing" }),
    ).rejects.toMatchObject({ code: "DATASET_NOT_FOUND" });
  });

  it("rejects malformed operation results", async () => {
    const upstream = queuedFetch(success({ count: "many", results: [] }));
    const direct = recordingLoader();
    const adapter = new DataGovAdapter(
      config(),
      dependencies(upstream.fetcher, direct.loader),
    );

    await expect(adapter.searchData({})).rejects.toMatchObject({
      code: "UPSTREAM_ERROR",
    });
  });
});

describe("named CKAN adapters", () => {
  it.each([
    [DataGovAdapter, "smart_dublin"],
    [SmartDublinAdapter, "data_gov_ie"],
  ] as const)("rejects a mismatched source configuration", (Adapter, source) => {
    const direct = recordingLoader();
    expect(
      () =>
        new Adapter(
          config(source),
          dependencies(fetch, direct.loader),
        ),
    ).toThrow(/requires/);
  });

  it("requires configured scope for Met Eireann", () => {
    const direct = recordingLoader();
    expect(
      () =>
        new MetEireannAdapter(
          config("met_eireann"),
          dependencies(fetch, direct.loader),
        ),
    ).toThrow("requires organization scope configuration");
  });
});
