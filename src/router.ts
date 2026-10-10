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
  private readonly disabledSources: ReadonlySet<Source>;

  constructor(
    adapters: readonly ProviderAdapter[],
    disabledSources: readonly Source[] = [],
  ) {
    const registered = new Map<Source, ProviderAdapter>();
    const disabled = new Set<Source>();

    for (const source of disabledSources) {
      if (!isSource(source)) {
        throw new Error(`Unknown disabled provider: ${source}`);
      }
      if (disabled.has(source)) {
        throw new Error(`Duplicate disabled provider: ${source}`);
      }
      disabled.add(source);
    }

    for (const adapter of adapters) {
      const source = adapter.config.provider;
      if (disabled.has(source)) {
        throw new Error(`Provider cannot be registered and disabled: ${source}`);
      }
      if (registered.has(source)) {
        throw new Error(`Duplicate provider adapter: ${source}`);
      }
      registered.set(source, adapter);
    }

    for (const source of SOURCES) {
      if (!registered.has(source) && !disabled.has(source)) {
        throw new Error(`Missing provider adapter: ${source}`);
      }
    }

    this.adapters = registered;
    this.disabledSources = disabled;
  }

  resolve(source: string, operation: ProviderOperation): ProviderAdapter {
    if (!isSource(source)) {
      throw new AppError("INVALID_SOURCE");
    }

    if (this.disabledSources.has(source)) {
      throw new AppError("SOURCE_DISABLED");
    }

    const adapter = this.adapters.get(source)!;

    if (!adapter.config.capabilities[operation]) {
      throw new AppError("UNSUPPORTED_OPERATION");
    }

    return adapter;
  }

  listSources(): readonly SourceDescription[] {
    return SOURCES.flatMap((source) => {
      const adapter = this.adapters.get(source);
      if (!adapter) {
        return [];
      }
      const config = adapter.config;
      return [
        {
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
        },
      ];
    });
  }
}
