import { describe, expect, it } from "vitest";

import { AppError } from "../src/errors";
import { SOURCES, type ProviderConfig, type Source } from "../src/models";
import type { ProviderAdapter } from "../src/providers/provider";
import { SourceRouter } from "../src/router";

function createAdapter(
  provider: Source,
  capabilities: ProviderConfig["capabilities"] = {
    search_data_by_source: true,
    describe_data_by_id: true,
    query_data_by_id: true,
    get_data_link_by_id: true,
  },
): ProviderAdapter {
  return {
    config: {
      provider,
      type: "catalogue",
      authoritative: provider !== "open_meteo_ie",
      coverage: "Test coverage",
      description: "Test source",
      base_url: "https://example.com",
      endpoints: {},
      http_timeout_ms: 5_000,
      pagination: { default_limit: 10, max_limit: 100 },
      capabilities,
      formats: ["json"],
    },
    searchData: async () => ({
      results: [],
      pagination: { limit: 10, offset: 0, returned: 0 },
    }),
    describeData: async () => {
      throw new Error("not used");
    },
    queryData: async () => {
      throw new Error("not used");
    },
    getDataLink: async () => {
      throw new Error("not used");
    },
  };
}

describe("SourceRouter", () => {
  const dataGovAdapter = createAdapter("data_gov_ie", {
    search_data_by_source: true,
    describe_data_by_id: false,
    query_data_by_id: true,
    get_data_link_by_id: true,
  });
  const smartDublinAdapter = createAdapter("smart_dublin");
  const metEireannAdapter = createAdapter("met_eireann");
  const openMeteoAdapter = createAdapter("open_meteo_ie");
  const remainingAdapters = SOURCES.slice(4).map((source) =>
    createAdapter(source),
  );
  const adapters = [
    dataGovAdapter,
    smartDublinAdapter,
    metEireannAdapter,
    openMeteoAdapter,
    ...remainingAdapters,
  ];
  const router = new SourceRouter(adapters);

  function expectCode(action: () => unknown, code: AppError["code"]): void {
    try {
      action();
      throw new Error("Expected an AppError");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe(code);
    }
  }

  it("returns the registered adapter for a supported operation", () => {
    expect(router.resolve("data_gov_ie", "search_data_by_source")).toBe(
      dataGovAdapter,
    );
  });

  it("rejects an unknown source", () => {
    expectCode(
      () => router.resolve("unknown", "search_data_by_source"),
      "INVALID_SOURCE",
    );
  });

  it("excludes disabled sources and returns a specific error for them", () => {
    const disabledSource = "open_data_ni";
    const disabledRouter = new SourceRouter(
      adapters.filter((adapter) => adapter.config.provider !== disabledSource),
      [disabledSource],
    );

    expect(
      disabledRouter
        .listSources()
        .some(({ source }) => source === disabledSource),
    ).toBe(false);
    expectCode(
      () => disabledRouter.resolve(disabledSource, "search_data_by_source"),
      "SOURCE_DISABLED",
    );
  });

  it("fails during construction when a source is not registered", () => {
    expect(
      () =>
        new SourceRouter([
          ...adapters.slice(0, -1),
        ]),
    ).toThrow("Missing provider adapter: open_data_ni");
  });

  it("rejects duplicate adapter registration", () => {
    expect(
      () => new SourceRouter([...adapters, createAdapter("data_gov_ie")]),
    ).toThrow("Duplicate provider adapter: data_gov_ie");
  });

  it("rejects a source that is both registered and disabled", () => {
    expect(() => new SourceRouter(adapters, ["open_data_ni"])).toThrow(
      "Provider cannot be registered and disabled: open_data_ni",
    );
  });

  it("enforces provider capabilities", () => {
    expectCode(
      () => router.resolve("data_gov_ie", "describe_data_by_id"),
      "UNSUPPORTED_OPERATION",
    );
  });

  it("lists source capabilities and limits from configuration", () => {
    expect(router.listSources()[0]).toEqual({
      source: "data_gov_ie",
      type: "catalogue",
      authoritative: true,
      coverage: "Test coverage",
      description: "Test source",
      capabilities: dataGovAdapter.config.capabilities,
      formats: ["json"],
      limits: { default: 10, maximum: 100 },
    });
  });
});
