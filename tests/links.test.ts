import { describe, expect, it } from "vitest";

import { isBrowserDataUrl } from "../src/links";

describe("browser data links", () => {
  it("accepts public HTTP and HTTPS URLs", () => {
    expect(isBrowserDataUrl("https://example.test/data.csv?page=1")).toBe(true);
    expect(isBrowserDataUrl("http://example.test/data.csv")).toBe(true);
  });

  it("rejects credentials, sensitive query parameters, and other protocols", () => {
    for (const url of [
      "https://user:password@example.test/data.csv",
      "https://example.test/data.csv?access_token=secret",
      "https://example.test/data.csv?API_KEY=secret",
      "https://example.test/data.csv?apikey=secret",
      "https://example.test/data.csv?signature=secret",
      "https://example.test/data.csv?X-Amz-Signature=secret",
      "https://example.test/data.csv?sig=secret",
      "https://example.test/data.csv#access_token=secret",
      "file:///private/data.csv",
      "javascript:alert(1)",
    ]) {
      expect(isBrowserDataUrl(url)).toBe(false);
    }
  });
});
