import { describe, expect, it } from "vitest";

import {
  isSource,
  PROVIDER_OPERATIONS,
  SOURCES,
  type QuerySelectors,
} from "../src/models";

describe("shared models", () => {
  it("defines the fixed sources", () => {
    expect(SOURCES).toEqual([
      "data_gov_ie",
      "smart_dublin",
      "met_eireann",
      "open_meteo_ie",
      "cso_pxstat",
      "marine_institute",
      "geohive",
      "opw",
      "epa",
      "tfi_nta",
      "seai",
      "eirgrid",
      "open_data_ni",
    ]);
    expect(isSource("smart_dublin")).toBe(true);
    expect(isSource("unknown")).toBe(false);
    expect(isSource("open_meteo_ie")).toBe(true);
    expect(isSource("open_data_ni")).toBe(true);
  });

  it("defines the generic provider operations", () => {
    expect(PROVIDER_OPERATIONS).toEqual([
      "search_data_by_source",
      "describe_data_by_id",
      "query_data_by_id",
      "get_data_link_by_id",
    ]);
  });

  it("defines source-neutral query selectors", () => {
    const selectors: QuerySelectors = {
      fields: ["temperature_2m"],
      filters: [
        { field: "station", operator: "in", value: ["Dublin", "Cork"] },
        { field: "temperature", operator: "gte", value: 10 },
      ],
      spatial: {
        type: "bbox",
        west: -10.7,
        south: 51.3,
        east: -5.4,
        north: 55.5,
      },
      time_range: {
        start: "2026-10-10T00:00:00.000Z",
        end: "2026-10-11T00:00:00.000Z",
      },
    };

    expect(selectors.spatial?.type).toBe("bbox");
  });
});
