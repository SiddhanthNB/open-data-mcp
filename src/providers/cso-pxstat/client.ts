import { AppError } from "../../errors";
import { cancelBody, readBoundedJsonResponse } from "../../resources/limits";

export const CSO_JSON_RPC_ENDPOINT = "https://ws.cso.ie/public/api.jsonrpc";
export const CSO_REST_BASE = "https://ws.cso.ie/public/api.restful";
export const CSO_SEARCH_METHOD =
  "PxStat.System.Navigation.Navigation_API.Search";
export const CSO_DATASET_METHOD = "PxStat.Data.Cube_API.ReadDataset";

const MATRIX_CODE = /^[A-Za-z0-9_-]{1,20}$/u;

export interface CsoPxStatClientSettings {
  jsonRpcEndpoint: string;
  restfulBaseUrl: string;
  searchMethod: string;
  datasetMethod: string;
  language: "en";
  timeoutMs: number;
  maxInputBytes: number;
}

export interface CsoSearchRecord {
  MtrCode: string;
  MtrTitle: string;
  MtrOfficialFlag?: boolean;
  SbjValue?: string;
  PrcValue?: string;
  RlsLiveDatetimeFrom?: string;
  CprCode?: string;
  CprValue?: string;
}

interface JsonRpcEnvelope {
  jsonrpc: "2.0";
  result?: unknown;
  error?: unknown;
}

export class CsoPxStatClient {
  private readonly settings: CsoPxStatClientSettings;
  private readonly fetcher: typeof fetch;

  constructor(settings: CsoPxStatClientSettings, fetcher: typeof fetch) {
    validateClientSettings(settings);
    this.settings = settings;
    this.fetcher = fetcher;
  }

  async search(query: string): Promise<readonly CsoSearchRecord[]> {
    const result = await this.rpc(this.settings.searchMethod, {
      Search: query,
      LngIsoCode: this.settings.language,
    });
    if (!Array.isArray(result)) {
      throw new AppError("UPSTREAM_ERROR");
    }
    return result.map(searchRecord);
  }

  async metadata(matrix: string): Promise<unknown> {
    const url = this.metadataUrl(matrix);
    return this.getJson(url, true);
  }

  async readDataset(matrix: string, params: unknown): Promise<unknown> {
    requireMatrixCode(matrix);
    return this.rpc(this.settings.datasetMethod, params);
  }

  metadataUrl(matrix: string): string {
    requireMatrixCode(matrix);
    return `${this.settings.restfulBaseUrl}/PxStat.Data.Cube_API.ReadMetadata/${encodeURIComponent(matrix)}/${this.settings.language}`;
  }

  datasetUrl(matrix: string, type: string, version: string): string {
    requireMatrixCode(matrix);
    return `${this.settings.restfulBaseUrl}/PxStat.Data.Cube_API.ReadDataset/${encodeURIComponent(matrix)}/${encodeURIComponent(type)}/${encodeURIComponent(version)}/${this.settings.language}`;
  }

  private async rpc(method: string, params: unknown): Promise<unknown> {
    const envelope = await this.requestJson(
      this.settings.jsonRpcEndpoint,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", method, params, id: "1" }),
      },
      false,
    );
    if (!isRecord(envelope) || envelope.jsonrpc !== "2.0") {
      throw new AppError("UPSTREAM_ERROR");
    }
    const rpc = envelope as unknown as JsonRpcEnvelope;
    if (rpc.error !== undefined || !("result" in rpc)) {
      throw new AppError("UPSTREAM_ERROR");
    }
    return rpc.result;
  }

  private async getJson(url: string, notFoundIsDataset: boolean): Promise<unknown> {
    return this.requestJson(
      url,
      { headers: { accept: "application/json" } },
      notFoundIsDataset,
    );
  }

  private async requestJson(
    url: string,
    init: RequestInit,
    notFoundIsDataset: boolean,
  ): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.settings.timeoutMs);
    try {
      const response = await this.fetcher(url, {
        ...init,
        signal: controller.signal,
      });
      if (response.status === 404 && notFoundIsDataset) {
        cancelBody(response.body);
        throw new AppError("DATASET_NOT_FOUND");
      }
      if (response.status === 429) {
        cancelBody(response.body);
        throw new AppError("RATE_LIMITED");
      }
      if (!response.ok) {
        cancelBody(response.body);
        throw new AppError("UPSTREAM_ERROR");
      }
      return await readBoundedJsonResponse(
        response,
        this.settings.maxInputBytes,
        controller.signal,
      );
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      if (controller.signal.aborted || isAbortError(error)) {
        throw new AppError("UPSTREAM_TIMEOUT");
      }
      throw new AppError("UPSTREAM_ERROR");
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function requireMatrixCode(value: string): void {
  if (!MATRIX_CODE.test(value)) {
    throw new AppError("INVALID_REQUEST", "data_id must be a valid PxStat matrix code.");
  }
}

function validateClientSettings(settings: CsoPxStatClientSettings): void {
  if (
    settings.jsonRpcEndpoint !== CSO_JSON_RPC_ENDPOINT ||
    settings.restfulBaseUrl !== CSO_REST_BASE ||
    settings.searchMethod !== CSO_SEARCH_METHOD ||
    settings.datasetMethod !== CSO_DATASET_METHOD ||
    settings.language !== "en"
  ) {
    throw new RangeError("CSO PxStat endpoints, methods, and language are fixed");
  }
  requirePositiveInteger(settings.timeoutMs, "timeoutMs");
  requirePositiveInteger(settings.maxInputBytes, "maxInputBytes");
}

function searchRecord(value: unknown): CsoSearchRecord {
  if (!isRecord(value)) {
    throw new AppError("UPSTREAM_ERROR");
  }
  const code = requiredString(value.MtrCode);
  const title = requiredString(value.MtrTitle);
  requireMatrixCode(code);
  return {
    MtrCode: code,
    MtrTitle: title,
    ...(typeof value.MtrOfficialFlag === "boolean"
      ? { MtrOfficialFlag: value.MtrOfficialFlag }
      : {}),
    ...(optionalString(value.SbjValue)
      ? { SbjValue: optionalString(value.SbjValue) }
      : {}),
    ...(optionalString(value.PrcValue)
      ? { PrcValue: optionalString(value.PrcValue) }
      : {}),
    ...(optionalString(value.RlsLiveDatetimeFrom)
      ? { RlsLiveDatetimeFrom: optionalString(value.RlsLiveDatetimeFrom) }
      : {}),
    ...(optionalString(value.CprCode)
      ? { CprCode: optionalString(value.CprCode) }
      : {}),
    ...(optionalString(value.CprValue)
      ? { CprValue: optionalString(value.CprValue) }
      : {}),
  };
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new AppError("UPSTREAM_ERROR");
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function requirePositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
}
