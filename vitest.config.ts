import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
    }),
  ],
  test: {
    testTimeout: 15_000,
    deps: {
      optimizer: {
        ssr: {
          enabled: true,
          include: [
            "@opentelemetry/api",
            "@opentelemetry/resources",
            "@opentelemetry/sdk-trace-base",
          ],
        },
      },
    },
  },
});
