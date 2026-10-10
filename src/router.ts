import { AppError } from "./errors";
import {
  isSource,
  SOURCES,
  type ProviderOperation,
  type SourceDescription,
  type Source,
} from "./models";
import type { ProviderAdapter } from "./providers/provider";

export class SourceRouter {
  private readonly adapters: ReadonlyMap<Source, ProviderAdapter>;

  constructor(adapters: readonly ProviderAdapter[]) {
    const registered = new Map<Source, ProviderAdapter>();

    for (const adapter of adapters) {
      const source = adapter.config.provider;
      if (registered.has(source)) {
        throw new Error(`Duplicate provider adapter: ${source}`);
      }
      registered.set(source, adapter);
    }

    for (const source of SOURCES) {
      if (!registered.has(source)) {
        throw new Error(`Missing provider adapter: ${source}`);
      }
    }

    this.adapters = registered;
  }

  resolve(source: string, operation: ProviderOperation): ProviderAdapter {
    if (!isSource(source)) {
      throw new AppError("INVALID_SOURCE");
    }

    const adapter = this.adapters.get(source)!;

    if (!adapter.config.capabilities[operation]) {
      throw new AppError("UNSUPPORTED_OPERATION");
    }

    return adapter;
  }

  listSources(): readonly SourceDescription[] {
    return SOURCES.map((source) => {
      const config = this.adapters.get(source)!.config;
      return {
        source,
        type: config.type,
        authoritative: config.authoritative ?? false,
        coverage: config.coverage ?? "Not specified",
        description: config.description ?? "No source description provided.",
        capabilities: config.capabilities,
        formats: config.formats,
        limits: {
          default: config.pagination.default_limit,
          maximum: config.pagination.max_limit,
        },
      };
    });
  }
}
