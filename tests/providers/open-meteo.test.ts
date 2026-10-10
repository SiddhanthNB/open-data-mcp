import { describe, expect, it } from "vitest";

import { AppError } from "../../src/errors";
import {
  OPEN_METEO_ACCESS_ID,
  OPEN_METEO_DATA_ID,
  OPEN_METEO_HOURLY_FIELDS,
  OpenMeteoAdapter,
  isInRepublicOfIreland,
  type OpenMeteoProviderConfig,
} from "../../src/providers/open-meteo";

const NOW = new Date("2026-10-10T12:00:00.000Z");

function config(): OpenMeteoProviderConfig {
  return {
    provider: "open_meteo_ie",
    type: "forecast_api",
    base_url: "https://api.open-meteo.com",
    endpoints: { forecast: "/v1/forecast" },
    http_timeout_ms: 1_000,
    pagination: { default_limit: 2, max_limit: 100 },
    capabilities: {
      search_data_by_source: true,
      describe_data_by_id: true,
      query_data_by_id: true,
      get_data_link_by_id: false,
    },
    formats: ["json"],
    forecast: {
      data_id: OPEN_METEO_DATA_ID,
      access_id: OPEN_METEO_ACCESS_ID,
      endpoint: "https://api.open-meteo.com/v1/forecast",
      model: "ecmwf_ifs",
      horizon_days: 15,
      allowed_hourly_fields: OPEN_METEO_HOURLY_FIELDS,
      max_fields: 10,
      timezone: "GMT",
      timeformat: "iso8601",
      temperature_unit: "celsius",
      wind_speed_unit: "kmh",
      precipitation_unit: "mm",
      cell_selection: "land",
      attribution: {
        provider: "Open-Meteo",
        weather_model: "ECMWF IFS HRES 9 km",
        licence: "CC BY 4.0",
        url: "https://open-meteo.com/",
      },
    },
  } as unknown as OpenMeteoProviderConfig;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function forecastResponse(): Record<string, unknown> {
  return {
    latitude: 53.375,
    longitude: -6.25,
    hourly_units: {
      time: "iso8601",
      temperature_2m: "°C",
      precipitation: "mm",
    },
    hourly: {
      time: [
        "2026-10-10T00:00",
        "2026-10-10T01:00",
        "2026-10-10T02:00",
        "2026-10-10T03:00",
        "2026-10-10T04:00",
      ],
      temperature_2m: [11.2, null, 10.8, 10.5, 10.1],
      precipitation: [0, 0.1, 0.2, 0, 0],
    },
  };
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

function adapter(fetcher: typeof fetch, overrides: { maxInputBytes?: number; maxOutputBytes?: number } = {}): OpenMeteoAdapter {
  return new OpenMeteoAdapter(config(), {
    fetch: fetcher,
    now: () => NOW,
    maxInputBytes: overrides.maxInputBytes ?? 100_000,
    maxOutputBytes: overrides.maxOutputBytes ?? 100_000,
  });
}

function validQuery() {
  return {
    data_id: OPEN_METEO_DATA_ID,
    access_id: OPEN_METEO_ACCESS_ID,
    fields: ["temperature_2m", "precipitation"],
    spatial: { type: "point" as const, latitude: 53.3498, longitude: -6.2603 },
    time_range: {
      start: "2026-10-10T00:00:00Z",
      end: "2026-10-10T03:00:00Z",
    },
    limit: 2,
    offset: 1,
  };
}

describe("Open-Meteo Ireland boundary", () => {
  it("includes Republic points and excludes Northern Ireland and external points", () => {
    expect(isInRepublicOfIreland(53.3498, -6.2603)).toBe(true);
    expect(isInRepublicOfIreland(51.8985, -8.4756)).toBe(true);
    expect(isInRepublicOfIreland(54.0004, -6.4058)).toBe(true);
    expect(isInRepublicOfIreland(54.956, -7.734)).toBe(true);
    expect(isInRepublicOfIreland(54.1751, -6.3402)).toBe(false);
    expect(isInRepublicOfIreland(54.9966, -7.3086)).toBe(false);
    expect(isInRepublicOfIreland(54.5973, -5.93)).toBe(false);
    expect(isInRepublicOfIreland(51.5072, -0.1276)).toBe(false);
    expect(isInRepublicOfIreland(53, -13)).toBe(false);
  });
});

describe("OpenMeteoAdapter", () => {
  it("rejects non-official endpoint settings", () => {
    const unsafe = config();
    unsafe.forecast.endpoint = "https://example.test/forecast";
    expect(
      () =>
        new OpenMeteoAdapter(unsafe, {
          fetch: async () => jsonResponse({}),
          now: () => NOW,
          maxInputBytes: 100_000,
          maxOutputBytes: 100_000,
        }),
    ).toThrow(RangeError);
  });

  it("exposes one local forecast catalogue item and query-only access", async () => {
    const instance = adapter(async () => {
      throw new Error("not called");
    });

    const search = await instance.searchData({ query: "ECMWF Ireland" });
    expect(search.pagination.total).toBe(1);
    expect(search.results).toHaveLength(1);
    expect(search.results[0]).toMatchObject({
      data_id: OPEN_METEO_DATA_ID,
      publisher: "Open-Meteo GmbH",
      available_formats: ["json"],
    });

    const description = await instance.describeData({ data_id: OPEN_METEO_DATA_ID });
    expect(description).toMatchObject({
      licence: "CC BY 4.0",
      access_points: [
        {
          access_id: OPEN_METEO_ACCESS_ID,
          capabilities: { query: true, link: false },
        },
      ],
    });
    expect((await instance.searchData({ query: "marine" })).results).toEqual([]);
  });

  it("uses only allowlisted upstream parameters and normalizes rows, units, nulls, and metadata", async () => {
    const upstream = recordingFetch(jsonResponse(forecastResponse()));
    const result = await adapter(upstream.fetcher).queryData(validQuery());

    expect(upstream.calls).toHaveLength(1);
    const url = new URL(upstream.calls[0]!.url);
    expect(`${url.origin}${url.pathname}`).toBe("https://api.open-meteo.com/v1/forecast");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      latitude: "53.3498",
      longitude: "-6.2603",
      hourly: "temperature_2m,precipitation",
      models: "ecmwf_ifs",
      timezone: "GMT",
      timeformat: "iso8601",
      temperature_unit: "celsius",
      wind_speed_unit: "kmh",
      precipitation_unit: "mm",
      cell_selection: "land",
      start_hour: "2026-10-10T00:00",
      end_hour: "2026-10-10T03:00",
    });
    expect(result.pagination).toEqual({ limit: 2, offset: 1, returned: 2, total: 4 });
    expect(result.data).toEqual({
      rows: [
        { timestamp: "2026-10-10T01:00Z", temperature_2m: null, precipitation: 0.1 },
        { timestamp: "2026-10-10T02:00Z", temperature_2m: 10.8, precipitation: 0.2 },
      ],
      units: { timestamp: "iso8601", temperature_2m: "°C", precipitation: "mm" },
      requested_coordinates: { latitude: 53.3498, longitude: -6.2603 },
      resolved_coordinates: { latitude: 53.375, longitude: -6.25 },
      data_kind: "model_forecast",
      observation: false,
      authoritative: false,
      model_id: "ecmwf_ifs",
      snapshot_stable: false,
      attribution: {
        provider: "Open-Meteo",
        weather_model: "ECMWF IFS HRES 9 km",
        licence: "CC BY 4.0",
        url: "https://open-meteo.com/",
      },
    });
  });

  it("rejects points outside the Republic without fetching", async () => {
    let called = false;
    const instance = adapter(async () => {
      called = true;
      return jsonResponse(forecastResponse());
    });

    await expect(instance.queryData({
      ...validQuery(),
      spatial: { type: "point", latitude: 54.5973, longitude: -5.93 },
    })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(called).toBe(false);
  });

  it("rejects missing, duplicate, unsupported, and excessive field selections", async () => {
    const instance = adapter(async () => jsonResponse(forecastResponse()));
    const invalidFields: Array<readonly string[] | undefined> = [
      undefined,
      ["temperature_2m", "temperature_2m"],
      ["temperature_2m", "secret_field"],
      Array.from({ length: 11 }, (_, index) => `field_${index}`),
    ];

    for (const fields of invalidFields) {
      await expect(instance.queryData({ ...validQuery(), fields })).rejects.toMatchObject({
        code: "INVALID_REQUEST",
      });
    }
  });

  it("rejects non-UTC, past, reversed, and out-of-horizon ranges", async () => {
    const instance = adapter(async () => jsonResponse(forecastResponse()));
    const ranges = [
      { start: "2026-10-10T00:00:00+01:00", end: "2026-10-10T03:00:00+01:00" },
      { start: "2026-10-10T00:30:00Z", end: "2026-10-10T03:00:00Z" },
      { start: "2026-10-09T23:00:00Z", end: "2026-10-10T03:00:00Z" },
      { start: "2026-10-11T03:00:00Z", end: "2026-10-11T02:00:00Z" },
      { start: "2026-10-24T00:00:00Z", end: "2026-10-25T00:00:00Z" },
    ];

    for (const time_range of ranges) {
      await expect(instance.queryData({ ...validQuery(), time_range })).rejects.toMatchObject({
        code: "INVALID_REQUEST",
      });
    }
  });

  it("validates data/access ids and rejects dynamic links", async () => {
    const instance = adapter(async () => jsonResponse(forecastResponse()));
    await expect(instance.describeData({ data_id: "unknown" })).rejects.toMatchObject({
      code: "DATASET_NOT_FOUND",
    });
    await expect(instance.queryData({ ...validQuery(), access_id: "unknown" })).rejects.toMatchObject({
      code: "RESOURCE_NOT_FOUND",
    });
    await expect(instance.getDataLink({
      data_id: OPEN_METEO_DATA_ID,
      access_id: OPEN_METEO_ACCESS_ID,
    })).rejects.toMatchObject({ code: "UNSUPPORTED_OPERATION" });
  });

  it("maps rate limits, malformed payloads, and oversized input", async () => {
    await expect(adapter(async () => jsonResponse({}, 429)).queryData(validQuery())).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
    await expect(adapter(async () => jsonResponse({ latitude: 53.3 })).queryData(validQuery())).rejects.toMatchObject({
      code: "UPSTREAM_ERROR",
    });
    await expect(adapter(async () => jsonResponse(forecastResponse()), { maxInputBytes: 10 }).queryData(validQuery())).rejects.toMatchObject({
      code: "RESOURCE_TOO_LARGE",
    });
  });

  it("maps aborted upstream requests to a timeout", async () => {
    const fetcher = ((_: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    })) as typeof fetch;
    const shortConfig = config();
    shortConfig.http_timeout_ms = 1;
    const instance = new OpenMeteoAdapter(shortConfig, {
      fetch: fetcher,
      now: () => NOW,
      maxInputBytes: 100_000,
      maxOutputBytes: 100_000,
    });

    await expect(instance.queryData(validQuery())).rejects.toMatchObject({ code: "UPSTREAM_TIMEOUT" });
  });

  it("enforces the serialized output limit", async () => {
    await expect(adapter(async () => jsonResponse(forecastResponse()), { maxOutputBytes: 20 }).queryData(validQuery())).rejects.toBeInstanceOf(AppError);
    await expect(adapter(async () => jsonResponse(forecastResponse()), { maxOutputBytes: 20 }).queryData(validQuery())).rejects.toMatchObject({
      code: "RESOURCE_TOO_LARGE",
    });
  });
});
