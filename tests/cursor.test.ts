import { describe, expect, it } from "vitest";

import {
  decodeQueryCursor,
  decodeSearchCursor,
  encodeQueryCursor,
  encodeSearchCursor,
} from "../src/cursor";

describe("opaque cursors", () => {
  it("round-trips Unicode search state without exposing an offset contract", () => {
    const cursor = encodeSearchCursor("met_eireann", "Éireann rainfall", 20);

    expect(decodeSearchCursor(cursor, "met_eireann", undefined)).toEqual({
      offset: 20,
      query: "Éireann rainfall",
    });
    expect(() =>
      decodeSearchCursor(cursor, "data_gov_ie", "Éireann rainfall"),
    ).toThrow('The "cursor" field is invalid or does not match this request.');
    expect(() =>
      decodeSearchCursor(cursor, "met_eireann", "temperature"),
    ).toThrow('The "cursor" field is invalid or does not match this request.');
  });

  it("binds query cursors to source, data ID, and access ID", () => {
    const cursor = encodeQueryCursor(
      "data_gov_ie",
      "dataset-1",
      "resource-1",
      100,
    );

    expect(
      decodeQueryCursor(
        cursor,
        "data_gov_ie",
        "dataset-1",
        "resource-1",
      ),
    ).toEqual({ offset: 100, selectors: {} });
    expect(() =>
      decodeQueryCursor(
        cursor,
        "data_gov_ie",
        "dataset-2",
        "resource-1",
      ),
    ).toThrow('The "cursor" field is invalid or does not match this request.');
    expect(() =>
      decodeQueryCursor(
        cursor,
        "data_gov_ie",
        "dataset-1",
        "resource-2",
      ),
    ).toThrow('The "cursor" field is invalid or does not match this request.');
  });

  it("binds query cursors to normalized selectors and restores omitted selectors", () => {
    const selectors = {
      fields: ["temperature_2m", "wind_speed_10m"],
      spatial: {
        type: "point" as const,
        latitude: 53.3498,
        longitude: -6.2603,
      },
      time_range: {
        start: "2026-10-10T00:00:00.000Z",
        end: "2026-10-11T00:00:00.000Z",
      },
    };
    const cursor = encodeQueryCursor(
      "met_eireann",
      "forecast",
      "point-forecast",
      24,
      selectors,
    );

    expect(
      decodeQueryCursor(
        cursor,
        "met_eireann",
        "forecast",
        "point-forecast",
      ),
    ).toEqual({ offset: 24, selectors });
    expect(() =>
      decodeQueryCursor(
        cursor,
        "met_eireann",
        "forecast",
        "point-forecast",
        { fields: ["temperature_2m"] },
      ),
    ).toThrow('The "cursor" field is invalid or does not match this request.');
    expect(() =>
      decodeQueryCursor(
        cursor,
        "met_eireann",
        "forecast",
        "point-forecast",
        {
          spatial: {
            type: "point",
            latitude: 52.66,
            longitude: -8.63,
          },
        },
      ),
    ).toThrow('The "cursor" field is invalid or does not match this request.');
  });

  it("normalizes valid RFC3339 offsets without fractional seconds", () => {
    const cursor = encodeQueryCursor(
      "met_eireann",
      "forecast",
      "point-forecast",
      24,
      {
        time_range: {
          start: "2026-10-10T12:00:00+01:00",
          end: "2026-10-10T18:00:00+01:00",
        },
      },
    );

    expect(
      decodeQueryCursor(
        cursor,
        "met_eireann",
        "forecast",
        "point-forecast",
        {
          time_range: {
            start: "2026-10-10T12:00:00+01:00",
            end: "2026-10-10T18:00:00+01:00",
          },
        },
      ),
    ).toEqual({
      offset: 24,
      selectors: {
        time_range: {
          start: "2026-10-10T11:00:00.000Z",
          end: "2026-10-10T17:00:00.000Z",
        },
      },
    });
  });

  it("binds query cursors to typed filters and bounding boxes", () => {
    const selectors = {
      filters: [
        {
          field: "station",
          operator: "in" as const,
          value: ["Dublin", "Cork"],
        },
        { field: "depth", operator: "gte" as const, value: 10 },
      ],
      spatial: {
        type: "bbox" as const,
        west: -10.7,
        south: 51.3,
        east: -5.4,
        north: 55.5,
      },
    };
    const cursor = encodeQueryCursor(
      "data_gov_ie",
      "dataset-1",
      "resource-1",
      50,
      selectors,
    );

    expect(
      decodeQueryCursor(
        cursor,
        "data_gov_ie",
        "dataset-1",
        "resource-1",
      ),
    ).toEqual({ offset: 50, selectors });
    expect(() =>
      decodeQueryCursor(
        cursor,
        "data_gov_ie",
        "dataset-1",
        "resource-1",
        {
          filters: [
            { field: "station", operator: "in", value: ["Galway"] },
          ],
        },
      ),
    ).toThrow('The "cursor" field is invalid or does not match this request.');
    expect(() =>
      decodeQueryCursor(
        cursor,
        "data_gov_ie",
        "dataset-1",
        "resource-1",
        {
          spatial: {
            type: "bbox",
            west: -9,
            south: 52,
            east: -6,
            north: 54,
          },
        },
      ),
    ).toThrow('The "cursor" field is invalid or does not match this request.');
  });

  it.each(["", "%%%", "bm90LWpzb24", "e30"])(
    "rejects malformed cursor %j",
    (cursor) => {
      expect(() =>
        decodeQueryCursor(
          cursor,
          "data_gov_ie",
          "dataset-1",
          "resource-1",
        ),
      ).toThrow('The "cursor" field is invalid or does not match this request.');
    },
  );
});
