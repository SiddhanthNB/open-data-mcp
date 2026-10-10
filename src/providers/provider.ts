import type {
  DataLink,
  DataDescription,
  DataSearchResult,
  ProviderConfig,
  QuerySelectors,
  QueryDataResult,
} from "../models";

export interface SearchDataInput {
  query?: string;
  limit?: number;
  offset?: number;
}

export interface DescribeDataInput {
  data_id: string;
}

export interface QueryDataInput extends QuerySelectors {
  data_id: string;
  access_id: string;
  limit?: number;
  offset?: number;
}

export interface GetDataLinkInput {
  data_id: string;
  access_id: string;
}

export interface ProviderAdapter {
  readonly config: ProviderConfig;

  searchData(input: SearchDataInput): Promise<DataSearchResult>;
  describeData(input: DescribeDataInput): Promise<DataDescription>;
  queryData(input: QueryDataInput): Promise<QueryDataResult>;
  getDataLink(input: GetDataLinkInput): Promise<DataLink>;
}
