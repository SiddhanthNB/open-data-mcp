import { describe, expect, it } from "vitest";

import { AppError } from "../../src/errors";
import {
  ARCGIS_PORTAL_ORIGIN,
  GEOHIVE_CATALOGUE_ORIGIN,
  GeoHiveAdapter,
  type GeoHiveSettings,
} from "../../src/providers/geohive";

const NOW = new Date("2026-10-10T15:00:00.000Z");
const DATA_ID = "e6f6418eb62442c4adbe18d0a64135a2";
const WMS_ID = "a074bb23b8434e62b2287a5e5e495511";
const SERVICE_URL =
  "https://services-eu1.arcgis.com/FH5XCsx8rYXqnjF5/arcgis/rest/services/Counties/FeatureServer";
const WMS_URL = "https://gis.epa.ie/geoserver/EPA/wms";

function settings(overrides: Partial<GeoHiveSettings> = {}): GeoHiveSettings {
  return {
    catalogueOrigin: GEOHIVE_CATALOGUE_ORIGIN,
    portalOrigin: ARCGIS_PORTAL_ORIGIN,
    allowedArcgisHosts: [
      "services-eu1.arcgis.com",
      "atlas.marine.ie",
      "gsi.geodata.gov.ie",
    ],
    allowedWmsHosts: ["gis.epa.ie"],
    timeoutMs: 1_000,
    maxInputBytes: 100_000,
    maxOutputBytes: 100_000,
    defaultLimit: 10,
    maxLimit: 100,
    maxLayers: 10,
    maxSchemaFields: 20,
    maxSelectedFields: 10,
    ...overrides,
  };
}

function catalogueFeature(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: `${DATA_ID}_0`,
    type: "Feature",
    properties: {
      id: DATA_ID,
      title: "Counties - National Statutory Boundaries",
      snippet: "County <b>boundaries</b>.",
      description: "<p>Detailed county boundaries.</p>",
      source: "Tailte Éireann",
      accessInformation: "© Tailte Éireann",
      license: "CC-BY-4.0",
      licenseInfo: "<p>Creative Commons Attribution 4.0.</p>",
      tags: ["boundaries", "Ireland"],
      type: "Feature Service",
      url: SERVICE_URL,
      ...overrides,
    },
  };
}

function serviceMetadata(ids: number[] = [0]): Record<string, unknown> {
  return {
    serviceItemId: "different-service-item-id",
    capabilities: "Query",
    layers: ids.map((id) => ({ id, name: `Layer ${id}` })),
  };
}

function layerMetadata(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 0,
    name: "Counties",
    description: "County attributes",
    copyrightText: "© Tailte Éireann",
    capabilities: "Query",
    advancedQueryCapabilities: { supportsPagination: true },
    geometryType: "esriGeometryPolygon",
    objectIdField: "OBJECTID",
    maxRecordCount: 2_000,
    editingInfo: { lastEditDate: NOW.getTime() },
    timeInfo: { startTimeField: "UPDATED_AT" },
    fields: [
      { name: "OBJECTID", alias: "Object ID", type: "esriFieldTypeOID" },
      { name: "COUNTY", alias: "County", type: "esriFieldTypeString" },
      { name: "POPULATION", alias: "Population", type: "esriFieldTypeInteger" },
      { name: "UPDATED_AT", alias: "Updated", type: "esriFieldTypeDate" },
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

interface RecordedCall {
  url: string;
  init?: RequestInit;
}

function routedFetch(
  route: (url: URL, init?: RequestInit) => Response | Promise<Response>,
): { fetcher: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  return {
    calls,
    fetcher: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, ...(init ? { init } : {}) });
      return route(new URL(url), init);
    }) as typeof fetch,
  };
}

function adapter(fetcher: typeof fetch, overrides: Partial<GeoHiveSettings> = {}) {
  return new GeoHiveAdapter(settings(overrides), {
    fetch: fetcher,
    now: () => NOW,
  });
}

function standardArcGisFetch(options: {
  layer?: Record<string, unknown>;
  count?: number;
  rows?: readonly Record<string, unknown>[];
} = {}) {
  return routedFetch((url) => {
    if (url.hostname === "ga.geohive.ie") {
      return jsonResponse(catalogueFeature());
    }
    if (url.pathname.endsWith("/FeatureServer")) {
      return jsonResponse(serviceMetadata());
    }
    if (url.pathname.endsWith("/FeatureServer/0")) {
      return jsonResponse(options.layer ?? layerMetadata());
    }
    if (url.pathname.endsWith("/FeatureServer/0/query")) {
      if (url.searchParams.get("returnCountOnly") === "true") {
        return jsonResponse({ count: options.count ?? 2 });
      }
      return jsonResponse({
        features: (options.rows ?? [
          { OBJECTID: 1, COUNTY: "Dublin", POPULATION: 1_501_500 },
          { OBJECTID: 2, COUNTY: "Cork", POPULATION: 609_000 },
        ]).map((attributes) => ({ attributes })),
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  });
}

describe("GeoHiveAdapter", () => {
  it("uses OGC q/limit/one-based startindex and stable catalogue record IDs", async () => {
    const upstream = routedFetch((url) => {
      expect(Object.fromEntries(url.searchParams)).toEqual({
        limit: "7",
        startindex: "15",
        q: "county boundaries",
      });
      return jsonResponse({
        type: "FeatureCollection",
        features: [catalogueFeature()],
        numberMatched: 212,
        numberReturned: 1,
      });
    });

    const result = await adapter(upstream.fetcher).searchData({
      query: "county boundaries",
      limit: 7,
      offset: 14,
    });

    expect(result.pagination).toEqual({ limit: 7, offset: 14, returned: 1, total: 212 });
    expect(result.results[0]).toEqual({
      data_id: DATA_ID,
      title: "Counties - National Statutory Boundaries",
      description: "County boundaries.",
      publisher: "Tailte Éireann",
      available_formats: ["json"],
      provenance: {
        source: "geohive",
        upstream_url: `${GEOHIVE_CATALOGUE_ORIGIN}/api/search/v1/collections/all/items/${DATA_ID}`,
        retrieved_at: NOW.toISOString(),
      },
    });
  });

  it("describes validated ArcGIS layers with neutral schemas and record licence", async () => {
    const upstream = standardArcGisFetch();
    const result = await adapter(upstream.fetcher).describeData({ data_id: DATA_ID });

    expect(result).toMatchObject({
      data_id: DATA_ID,
      title: "Counties - National Statutory Boundaries",
      description: "Detailed county boundaries.",
      publisher: "Tailte Éireann",
      licence:
        "CC-BY-4.0 Creative Commons Attribution 4.0. Attribution: © Tailte Éireann",
      tags: ["boundaries", "Ireland"],
    });
    expect(result.access_points).toEqual([
      {
        access_id: "layer:0",
        title: "Counties",
        description: "County attributes Attribution: © Tailte Éireann",
        format: "json",
        capabilities: { query: true, link: true },
        query_schema: {
          fields: [
            { name: "OBJECTID", label: "Object ID", type: "number", operators: [] },
            { name: "COUNTY", label: "County", type: "string", operators: [] },
            { name: "POPULATION", label: "Population", type: "number", operators: [] },
            { name: "UPDATED_AT", label: "Updated", type: "datetime", operators: [] },
          ],
          truncated: false,
          spatial: ["point", "bbox"],
        },
        last_modified: "2026-10-10T15:00:00.000Z",
        upstream_url: `${SERVICE_URL}/0`,
      },
    ]);
  });

  it("queries attributes with fixed parameters, stable ordering, bbox/time selectors, and a separate count", async () => {
    const upstream = standardArcGisFetch();
    const result = await adapter(upstream.fetcher).queryData({
      data_id: DATA_ID,
      access_id: "layer:0",
      fields: ["OBJECTID", "COUNTY"],
      spatial: { type: "bbox", west: -10, south: 51, east: -5, north: 56 },
      time_range: {
        start: "2026-01-01T00:00:00Z",
        end: "2026-02-01T00:00:00Z",
      },
      limit: 2,
      offset: 4,
    });

    const queryCalls = upstream.calls
      .map((call) => new URL(call.url))
      .filter((url) => url.pathname.endsWith("/query"));
    expect(queryCalls).toHaveLength(2);
    expect(Object.fromEntries(queryCalls[0]!.searchParams)).toEqual({
      where: "1=1",
      returnCountOnly: "true",
      f: "json",
      geometry: "-10,51,-5,56",
      geometryType: "esriGeometryEnvelope",
      inSR: "4326",
      spatialRel: "esriSpatialRelIntersects",
      time: "1767225600000,1769904000000",
    });
    expect(Object.fromEntries(queryCalls[1]!.searchParams)).toEqual({
      where: "1=1",
      outFields: "OBJECTID,COUNTY",
      returnGeometry: "false",
      resultOffset: "4",
      resultRecordCount: "2",
      orderByFields: "OBJECTID ASC",
      f: "json",
      geometry: "-10,51,-5,56",
      geometryType: "esriGeometryEnvelope",
      inSR: "4326",
      spatialRel: "esriSpatialRelIntersects",
      time: "1767225600000,1769904000000",
    });
    expect(result.data).toEqual({
      rows: [
        { OBJECTID: 1, COUNTY: "Dublin" },
        { OBJECTID: 2, COUNTY: "Cork" },
      ],
    });
    expect(result.pagination).toEqual({ limit: 2, offset: 4, returned: 2, total: 2 });
    expect(result.provenance.upstream_url).toBe(queryCalls[1]!.toString());
  });

  it("constructs WGS84 point filters without returning geometry", async () => {
    const upstream = standardArcGisFetch({ rows: [{ OBJECTID: 1 }] });
    await adapter(upstream.fetcher).queryData({
      data_id: DATA_ID,
      access_id: "layer:0",
      fields: ["OBJECTID"],
      spatial: { type: "point", latitude: 53.3498, longitude: -6.2603 },
      limit: 1,
    });
    const dataCall = upstream.calls
      .map((call) => new URL(call.url))
      .find(
        (url) =>
          url.pathname.endsWith("/query") &&
          url.searchParams.get("returnCountOnly") !== "true",
      )!;
    expect(dataCall.searchParams.get("geometry")).toBe("-6.2603,53.3498");
    expect(dataCall.searchParams.get("geometryType")).toBe("esriGeometryPoint");
    expect(dataCall.searchParams.get("returnGeometry")).toBe("false");
  });

  it("rejects raw filters, unknown fields, and time on non-time-aware layers", async () => {
    let called = false;
    const noFetch = async () => {
      called = true;
      throw new Error("not expected");
    };
    await expect(adapter(noFetch as typeof fetch).queryData({
      data_id: DATA_ID,
      access_id: "layer:0",
      filters: [{ field: "COUNTY", operator: "eq", value: "Dublin" }],
    })).rejects.toMatchObject({ code: "UNSUPPORTED_OPERATION" });
    expect(called).toBe(false);

    const unknownField = standardArcGisFetch();
    await expect(adapter(unknownField.fetcher).queryData({
      data_id: DATA_ID,
      access_id: "layer:0",
      fields: ["COUNTY; DROP TABLE"],
    })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(unknownField.calls.some((call) => new URL(call.url).pathname.endsWith("/query"))).toBe(false);

    const noTime = standardArcGisFetch({ layer: layerMetadata({ timeInfo: null }) });
    await expect(adapter(noTime.fetcher).queryData({
      data_id: DATA_ID,
      access_id: "layer:0",
      fields: ["COUNTY"],
      time_range: {
        start: "2026-01-01T00:00:00Z",
        end: "2026-02-01T00:00:00Z",
      },
    })).rejects.toMatchObject({ code: "UNSUPPORTED_OPERATION" });
  });

  it("marks and rejects layers without stable pagination", async () => {
    const upstream = standardArcGisFetch({
      layer: layerMetadata({
        advancedQueryCapabilities: { supportsPagination: false },
      }),
    });
    const description = await adapter(upstream.fetcher).describeData({ data_id: DATA_ID });
    expect(description.access_points[0]?.capabilities).toEqual({ query: false, link: true });

    const second = standardArcGisFetch({
      layer: layerMetadata({
        advancedQueryCapabilities: { supportsPagination: false },
      }),
    });
    await expect(adapter(second.fetcher).queryData({
      data_id: DATA_ID,
      access_id: "layer:0",
      fields: ["COUNTY"],
    })).rejects.toMatchObject({
      code: "UNSUPPORTED_OPERATION",
      message: "The ArcGIS layer does not support stable offset pagination.",
    });
  });

  it("uses validated ArcGIS item data for link-only WMS layer names", async () => {
    const upstream = routedFetch((url) => {
      if (url.hostname === "ga.geohive.ie") {
        return jsonResponse(catalogueFeature({
          id: WMS_ID,
          title: "Corine Landcover 2012, EPA",
          source: "Environmental Protection Agency",
          type: "WMS",
          url: WMS_URL,
        }));
      }
      if (url.hostname === "www.arcgis.com") {
        expect(url.pathname).toBe(`/sharing/rest/content/items/${WMS_ID}/data`);
        return jsonResponse({
          url: WMS_URL,
          layers: [{ name: "LAND_CLC12Rev", title: "Corine 2012" }],
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    const instance = adapter(upstream.fetcher);
    const description = await instance.describeData({ data_id: WMS_ID });
    expect(description.access_points).toEqual([
      {
        access_id: "wms:LAND_CLC12Rev",
        title: "Corine 2012",
        format: "wms",
        capabilities: { query: false, link: true },
        upstream_url: WMS_URL,
      },
    ]);

    const linkUpstream = routedFetch((url) => {
      if (url.hostname === "ga.geohive.ie") {
        return jsonResponse(catalogueFeature({
          id: WMS_ID,
          type: "WMS",
          url: WMS_URL,
        }));
      }
      return jsonResponse({
        url: WMS_URL,
        layers: [{ name: "LAND_CLC12Rev", title: "Corine 2012" }],
      });
    });
    const link = await adapter(linkUpstream.fetcher).getDataLink({
      data_id: WMS_ID,
      access_id: "wms:LAND_CLC12Rev",
    });
    expect(link).toMatchObject({
      data_id: WMS_ID,
      access_id: "wms:LAND_CLC12Rev",
      url: WMS_URL,
      format: "wms",
    });
  });

  it("does not expose unallowlisted hosts, unsafe paths, or mismatched WMS item data", async () => {
    for (const url of [
      "https://evil.example/arcgis/rest/services/Unsafe/FeatureServer",
      "https://services-eu1.arcgis.com/not-rest/services/Unsafe/FeatureServer",
      "http://services-eu1.arcgis.com/arcgis/rest/services/Unsafe/FeatureServer",
    ]) {
      const upstream = routedFetch(() => jsonResponse(catalogueFeature({ url })));
      const description = await adapter(upstream.fetcher).describeData({ data_id: DATA_ID });
      expect(description.access_points).toEqual([]);
      expect(upstream.calls).toHaveLength(1);
    }

    const wms = routedFetch((url) => {
      if (url.hostname === "ga.geohive.ie") {
        return jsonResponse(catalogueFeature({ id: WMS_ID, type: "WMS", url: WMS_URL }));
      }
      return jsonResponse({
        url: "https://evil.example/geoserver/EPA/wms",
        layers: [{ name: "guessed-layer" }],
      });
    });
    const description = await adapter(wms.fetcher).describeData({ data_id: WMS_ID });
    expect(description.access_points).toEqual([]);
  });

  it("supports validated direct ArcGIS layer links without trusting serviceItemId suffixes", async () => {
    const direct = `${SERVICE_URL}/4`;
    const upstream = routedFetch((url) => {
      if (url.hostname === "ga.geohive.ie") {
        return jsonResponse(catalogueFeature({ url: direct }));
      }
      return jsonResponse(layerMetadata({
        id: 4,
        name: "Direct layer",
        serviceItemId: "not-the-catalogue-id",
      }));
    });
    const description = await adapter(upstream.fetcher).describeData({ data_id: DATA_ID });
    expect(description.access_points[0]).toMatchObject({
      access_id: "layer:4",
      title: "Direct layer",
      upstream_url: direct,
    });
    expect(upstream.calls).toHaveLength(2);
  });

  it("maps not-found, rate-limit, timeout, and byte-limit failures", async () => {
    await expect(adapter(async () => jsonResponse({}, 404)).describeData({
      data_id: DATA_ID,
    })).rejects.toMatchObject({ code: "DATASET_NOT_FOUND" });

    await expect(adapter(async () => jsonResponse({}, 429)).searchData({})).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });

    const timeoutFetch = ((_: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      })) as typeof fetch;
    await expect(adapter(timeoutFetch, { timeoutMs: 1 }).searchData({})).rejects.toMatchObject({
      code: "UPSTREAM_TIMEOUT",
    });

    await expect(adapter(async () => jsonResponse({
      features: [catalogueFeature()],
      numberMatched: 1,
    }), { maxInputBytes: 10 }).searchData({})).rejects.toMatchObject({
      code: "RESOURCE_TOO_LARGE",
    });
  });

  it("enforces configured search, layer-fanout, and output bounds", async () => {
    const instance = adapter(async () => jsonResponse({ features: [], numberMatched: 0 }));
    await expect(instance.searchData({ limit: 101 })).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });

    const fanout = routedFetch((url) => {
      if (url.hostname === "ga.geohive.ie") {
        return jsonResponse(catalogueFeature());
      }
      return jsonResponse(serviceMetadata([0, 1, 2]));
    });
    await expect(adapter(fanout.fetcher, { maxLayers: 2 }).describeData({
      data_id: DATA_ID,
    })).rejects.toMatchObject({ code: "RESOURCE_TOO_LARGE" });

    await expect(adapter(async () => jsonResponse({
      features: [catalogueFeature()],
      numberMatched: 1,
    }), { maxOutputBytes: 20 }).searchData({})).rejects.toBeInstanceOf(AppError);
  });
});
