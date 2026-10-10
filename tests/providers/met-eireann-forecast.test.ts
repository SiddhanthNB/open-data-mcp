import { describe, expect, it } from "vitest";

import type { ProviderConfig } from "../../src/models";
import type { ResourceLoader } from "../../src/providers/ckan";
import {
  MetEireannAdapter,
  type MetEireannAdapterDependencies,
} from "../../src/providers/met-eireann";
import {
  MET_EIREANN_FORECAST_ACCESS_ID,
  MET_EIREANN_FORECAST_DATA_ID,
  MET_EIREANN_FORECAST_LICENCE_NOTICE,
} from "../../src/providers/met-eireann/forecast";

const NOW = new Date("2026-10-10T14:30:00.000Z");
const ENDPOINT = "https://forecast.example.test/locationforecast";

const FORECAST_XML = `<?xml version="1.0" encoding="UTF-8"?>
<weatherdata xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="https://www.met.ie/Open_Data/weatherapi-0.4.xsd" created="2026-10-10T14:25:20Z">
  <meta>
    <model name="harmonie" termin="2026-10-10T12:00:00Z" runended="2026-10-10T13:01:02Z" nextrun="2026-10-10T18:00:00Z" from="2026-10-10T12:00:00Z" to="2026-10-12T12:00:00Z"/>
    <model name="ecmwf" termin="2026-10-10T00:00:00Z" runended="2026-10-10T09:16:57Z" nextrun="2026-10-10T18:00:00Z" from="2026-10-10T00:00:00Z" to="2026-10-20T00:00:00Z"/>
  </meta>
  <product class="pointData">
    <time datatype="forecast" from="2026-10-10T00:00:00Z" to="2026-10-10T00:00:00Z">
      <location altitude="36" latitude="53.3498" longitude="-6.2603">
        <temperature id="TTT" unit="celsius" value="10.1"/>
        <windSpeed id="ff" mps="6.9" beaufort="4" name="Moderate breeze"/>
      </location>
    </time>
    <time datatype="forecast" from="2026-10-09T23:00:00Z" to="2026-10-10T00:00:00Z">
      <location altitude="36" latitude="53.3498" longitude="-6.2603">
        <precipitation unit="mm" value="0.0" minvalue="0.0" maxvalue="0.0" probability="0.0"/>
        <symbol id="LightCloud" number="2"/>
      </location>
    </time>
    <time datatype="forecast" from="2026-10-10T01:00:00Z" to="2026-10-10T01:00:00Z">
      <location altitude="36" latitude="53.3498" longitude="-6.2603">
        <temperature id="TTT" unit="celsius" value="9.8"/>
        <humidity value="83.8" unit="percent"/>
      </location>
    </time>
    <time datatype="forecast" from="2026-10-10T00:00:00Z" to="2026-10-10T01:00:00Z">
      <location altitude="36" latitude="53.3498" longitude="-6.2603">
        <precipitation unit="mm" value="0.0"/>
        <symbol id="PartlyCloud" number="3"/>
      </location>
    </time>
  </product>
</weatherdata>`;

function config(): ProviderConfig {
  return {
    provider: "met_eireann",
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
    authoritative: true,
    coverage: "Ireland",
    description: "Met Éireann open-data catalogue.",
    scope: {
      organization_name: "meteireann",
      organization_id: "met-eireann",
    },
  };
}

const unusedLoader: ResourceLoader = {
  async load() {
    throw new Error("Unexpected resource load");
  },
};

function dependencies(
  fetcher: typeof fetch,
  overrides: Partial<MetEireannAdapterDependencies["forecast"]> = {},
): MetEireannAdapterDependencies {
  return {
    fetch: fetcher,
    resourceLoader: unusedLoader,
    maxInputBytes: 1_000_000,
    maxOutputBytes: 1_000_000,
    now: () => NOW,
    forecast: {
      endpoint: ENDPOINT,
      ...overrides,
    },
  };
}

function xmlResponse(xml = FORECAST_XML, init: ResponseInit = {}): Response {
  return new Response(xml, {
    status: 200,
    ...init,
    headers: {
      "content-type": "application/xml",
      ...init.headers,
    },
  });
}

function ckanResponse(result: unknown): Response {
  return new Response(JSON.stringify({ success: true, result }), {
    headers: { "content-type": "application/json" },
  });
}

function recordingFetch(response: Response): {
  fetcher: typeof fetch;
  calls: Array<{ url: string; init?: RequestInit }>;
} {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  return {
    calls,
    fetcher: (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), ...(init ? { init } : {}) });
      return response;
    }) as typeof fetch,
  };
}

function forecastDataset(): Record<string, unknown> {
  return {
    id: MET_EIREANN_FORECAST_DATA_ID,
    name: "met-eireann-forecast-api",
    title: "Met Éireann forecast API",
    owner_org: "met-eireann",
    organization: { title: "Met Éireann" },
    license_title: "Met Eireann Custom Open Data Licence",
    tags: [{ name: "Forecasts" }],
    resources: [],
  };
}

describe("Met Éireann point forecast", () => {
  it("advertises the synthetic query access only on the forecast dataset", async () => {
    const upstream = recordingFetch(ckanResponse(forecastDataset()));
    const adapter = new MetEireannAdapter(
      config(),
      dependencies(upstream.fetcher),
    );

    const result = await adapter.describeData({
      data_id: MET_EIREANN_FORECAST_DATA_ID,
    });

    expect(result.access_points).toContainEqual({
      access_id: MET_EIREANN_FORECAST_ACCESS_ID,
      title: "Point forecast query",
      description: `Dynamic XML point forecast. ${MET_EIREANN_FORECAST_LICENCE_NOTICE}`,
      format: "xml",
      capabilities: { query: true, link: false },
      upstream_url: ENDPOINT,
    });
  });

  it("does not advertise the synthetic access on another dataset", async () => {
    const upstream = recordingFetch(
      ckanResponse({
        ...forecastDataset(),
        id: "another-dataset",
        name: "another-dataset",
      }),
    );
    const adapter = new MetEireannAdapter(
      config(),
      dependencies(upstream.fetcher),
    );

    const result = await adapter.describeData({ data_id: "another-dataset" });

    expect(result.access_points).toEqual([]);
  });

  it("queries official parameters and preserves model, instant, and interval structure", async () => {
    const upstream = recordingFetch(xmlResponse());
    const adapter = new MetEireannAdapter(
      config(),
      dependencies(upstream.fetcher),
    );

    const result = await adapter.queryData({
      data_id: MET_EIREANN_FORECAST_DATA_ID,
      access_id: MET_EIREANN_FORECAST_ACCESS_ID,
      spatial: { type: "point", latitude: 53.3498, longitude: -6.2603 },
      time_range: {
        start: "2026-10-10T00:00:00.000Z",
        end: "2026-10-10T03:00:00.000Z",
      },
      fields: ["temperature"],
      limit: 2,
      offset: 1,
    });

    expect(upstream.calls[0]?.url).toBe(
      `${ENDPOINT}?lat=53.3498;long=-6.2603;from=2026-10-10T00%3A00;to=2026-10-10T03%3A00`,
    );
    expect(upstream.calls[0]?.init?.headers).toEqual({
      accept: "application/xml, text/xml;q=0.9",
    });
    expect(result.pagination).toEqual({
      limit: 2,
      offset: 1,
      returned: 2,
      total: 4,
    });
    expect(result.provenance).toMatchObject({
      source: "met_eireann",
      original_format: "xml",
      retrieved_at: NOW.toISOString(),
    });

    const data = result.data as {
      metadata: {
        root_attributes: Record<string, string>;
        models: Array<Record<string, string>>;
      };
      product_attributes: Record<string, string>;
      instant_blocks: Array<Record<string, unknown>>;
      interval_blocks: Array<{
        sequence: number;
        location: { elements: unknown[] };
      }>;
      licence_notice: string;
    };
    expect(data.metadata.root_attributes.created).toBe(
      "2026-10-10T14:25:20Z",
    );
    expect(data.metadata.models).toEqual([
      expect.objectContaining({
        name: "harmonie",
        termin: "2026-10-10T12:00:00Z",
        nextrun: "2026-10-10T18:00:00Z",
      }),
      expect.objectContaining({
        name: "ecmwf",
        termin: "2026-10-10T00:00:00Z",
      }),
    ]);
    expect(data.product_attributes).toEqual({ class: "pointData" });
    expect(data.interval_blocks).toEqual([
      expect.objectContaining({
        kind: "interval",
        sequence: 1,
        location: expect.objectContaining({ elements: [] }),
      }),
    ]);
    expect(data.instant_blocks).toEqual([
      expect.objectContaining({
        kind: "instant",
        sequence: 2,
        location: expect.objectContaining({
          elements: [
            {
              name: "temperature",
              attributes: { id: "TTT", unit: "celsius", value: "9.8" },
            },
          ],
        }),
      }),
    ]);
    expect(data.licence_notice).toBe(MET_EIREANN_FORECAST_LICENCE_NOTICE);
  });

  it("returns a valid empty forecast as an empty page", async () => {
    const upstream = recordingFetch(
      xmlResponse(
        '<weatherdata created="2026-10-10T14:25:20Z"><meta><model name="ecmwf" termin="2026-10-10T00:00:00Z"/></meta><product class="pointData"/></weatherdata>',
      ),
    );
    const adapter = new MetEireannAdapter(
      config(),
      dependencies(upstream.fetcher),
    );

    const result = await adapter.queryData({
      data_id: MET_EIREANN_FORECAST_DATA_ID,
      access_id: MET_EIREANN_FORECAST_ACCESS_ID,
      spatial: { type: "point", latitude: 53.3, longitude: -6.2 },
    });

    expect(result.pagination).toEqual({
      limit: 10,
      offset: 0,
      returned: 0,
      total: 0,
    });
    expect(result.data).toMatchObject({
      instant_blocks: [],
      interval_blocks: [],
    });
  });

  it.each([
    {
      name: "missing point",
      input: {},
      message: /spatial.*required/,
    },
    {
      name: "point outside configured model bounds",
      input: {
        spatial: { type: "point" as const, latitude: 40, longitude: -6 },
      },
      message: /forecast model bounds/,
    },
    {
      name: "non-UTC time range",
      input: {
        spatial: {
          type: "point" as const,
          latitude: 53.3,
          longitude: -6.2,
        },
        time_range: {
          start: "2026-10-10T00:00:00+01:00",
          end: "2026-10-10T03:00:00+01:00",
        },
      },
      message: /UTC timestamps/,
    },
  ])("rejects $name before fetching", async ({ input, message }) => {
    const upstream = recordingFetch(xmlResponse());
    const adapter = new MetEireannAdapter(
      config(),
      dependencies(upstream.fetcher),
    );

    await expect(
      adapter.queryData({
        data_id: MET_EIREANN_FORECAST_DATA_ID,
        access_id: MET_EIREANN_FORECAST_ACCESS_ID,
        ...input,
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST", message });
    expect(upstream.calls).toHaveLength(0);
  });

  it.each([
    { status: 429, code: "RATE_LIMITED" },
    { status: 422, code: "INVALID_REQUEST" },
    { status: 503, code: "UPSTREAM_ERROR" },
  ])("maps upstream $status responses", async ({ status, code }) => {
    const upstream = recordingFetch(new Response("", { status }));
    const adapter = new MetEireannAdapter(
      config(),
      dependencies(upstream.fetcher),
    );

    await expect(
      adapter.queryData({
        data_id: MET_EIREANN_FORECAST_DATA_ID,
        access_id: MET_EIREANN_FORECAST_ACCESS_ID,
        spatial: { type: "point", latitude: 53.3, longitude: -6.2 },
      }),
    ).rejects.toMatchObject({ code });
  });

  it("maps a request timeout", async () => {
    const fetcher = (() => new Promise<Response>(() => undefined)) as typeof fetch;
    const adapter = new MetEireannAdapter(
      config(),
      dependencies(fetcher, { timeoutMs: 1 }),
    );

    await expect(
      adapter.queryData({
        data_id: MET_EIREANN_FORECAST_DATA_ID,
        access_id: MET_EIREANN_FORECAST_ACCESS_ID,
        spatial: { type: "point", latitude: 53.3, longitude: -6.2 },
      }),
    ).rejects.toMatchObject({ code: "UPSTREAM_TIMEOUT" });
  });

  it("rejects a successful non-XML response", async () => {
    const upstream = recordingFetch(
      new Response("{}", {
        headers: { "content-type": "application/json" },
      }),
    );
    const adapter = new MetEireannAdapter(
      config(),
      dependencies(upstream.fetcher),
    );

    await expect(
      adapter.queryData({
        data_id: MET_EIREANN_FORECAST_DATA_ID,
        access_id: MET_EIREANN_FORECAST_ACCESS_ID,
        spatial: { type: "point", latitude: 53.3, longitude: -6.2 },
      }),
    ).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
  });

  it("enforces the configured upstream byte limit", async () => {
    const upstream = recordingFetch(
      xmlResponse(FORECAST_XML, { headers: { "content-length": "1000000" } }),
    );
    const adapter = new MetEireannAdapter(
      config(),
      dependencies(upstream.fetcher, { maxInputBytes: 100 }),
    );

    await expect(
      adapter.queryData({
        data_id: MET_EIREANN_FORECAST_DATA_ID,
        access_id: MET_EIREANN_FORECAST_ACCESS_ID,
        spatial: { type: "point", latitude: 53.3, longitude: -6.2 },
      }),
    ).rejects.toMatchObject({ code: "RESOURCE_TOO_LARGE" });
  });

  it("rejects malformed or unsafe XML", async () => {
    const upstream = recordingFetch(
      xmlResponse(
        '<!DOCTYPE weatherdata [<!ENTITY x "bad">]><weatherdata>&x;</weatherdata>',
      ),
    );
    const adapter = new MetEireannAdapter(
      config(),
      dependencies(upstream.fetcher),
    );

    await expect(
      adapter.queryData({
        data_id: MET_EIREANN_FORECAST_DATA_ID,
        access_id: MET_EIREANN_FORECAST_ACCESS_ID,
        spatial: { type: "point", latitude: 53.3, longitude: -6.2 },
      }),
    ).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
  });

  it("rejects fixed-link retrieval for the dynamic access", async () => {
    const upstream = recordingFetch(xmlResponse());
    const adapter = new MetEireannAdapter(
      config(),
      dependencies(upstream.fetcher),
    );

    await expect(
      adapter.getDataLink({
        data_id: MET_EIREANN_FORECAST_DATA_ID,
        access_id: MET_EIREANN_FORECAST_ACCESS_ID,
      }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_OPERATION" });
    expect(upstream.calls).toHaveLength(0);
  });
});
