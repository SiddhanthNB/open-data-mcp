import { describe, expect, it } from "vitest";

import type { ProviderConfig } from "../src/models";
import { CkanClient } from "../src/providers/ckan/client";
import { DirectResourceLoader } from "../src/resources";

function receiverCheckingFetch(response: () => Response): typeof fetch {
  return function (this: unknown): Promise<Response> {
    if (this !== undefined) {
      throw new TypeError("fetch received an incorrect this reference");
    }
    return Promise.resolve(response());
  } as unknown as typeof fetch;
}

const config: ProviderConfig = {
  provider: "data_gov_ie",
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
  formats: ["json"],
};

describe("Worker fetch binding", () => {
  it("calls the CKAN fetch dependency without a receiver", async () => {
    const client = new CkanClient(
      config,
      receiverCheckingFetch(() =>
        Response.json({ success: true, result: { count: 0, results: [] } }),
      ),
      10_000,
    );

    await expect(
      client.packageSearch(new URLSearchParams({ rows: "1", start: "0" })),
    ).resolves.toEqual({ count: 0, results: [] });
  });

  it("calls the direct resource fetch dependency without a receiver", async () => {
    const loader = new DirectResourceLoader({
      fetch: receiverCheckingFetch(() => Response.json([{ id: 1 }])),
      maxInputBytes: 10_000,
      maxOutputBytes: 10_000,
    });

    await expect(
      loader.load({
        url: "https://files.example.test/data.json",
        format: "json",
        limit: 1,
        offset: 0,
        timeout_ms: 1_000,
      }),
    ).resolves.toEqual({
      data: [{ id: 1 }],
      pagination: { limit: 1, offset: 0, returned: 1, total: 1 },
      pagination_supported: true,
    });
  });
});
