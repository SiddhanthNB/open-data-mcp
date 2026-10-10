import type { ProviderConfig } from "../models";
import type {
  DescribeDataInput,
  GetDataLinkInput,
  ProviderAdapter,
  QueryDataInput,
  SearchDataInput,
} from "./provider";

type ProviderOperations = Omit<ProviderAdapter, "config">;

export class ConfiguredAdapter implements ProviderAdapter {
  constructor(
    readonly config: ProviderConfig,
    private readonly adapter: ProviderOperations,
  ) {}

  searchData(input: SearchDataInput) {
    return this.adapter.searchData(input);
  }

  describeData(input: DescribeDataInput) {
    return this.adapter.describeData(input);
  }

  queryData(input: QueryDataInput) {
    return this.adapter.queryData(input);
  }

  getDataLink(input: GetDataLinkInput) {
    return this.adapter.getDataLink(input);
  }
}
