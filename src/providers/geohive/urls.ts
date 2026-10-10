import { AppError } from "../../errors";

export const GEOHIVE_CATALOGUE_ORIGIN = "https://ga.geohive.ie";
export const ARCGIS_PORTAL_ORIGIN = "https://www.arcgis.com";

export interface ValidatedArcGisUrl {
  serviceUrl: string;
  serviceType: "FeatureServer" | "MapServer";
  layerId?: number;
}

export function catalogueSearchUrl(
  query: string | undefined,
  limit: number,
  offset: number,
): string {
  const url = new URL(
    "/api/search/v1/collections/all/items",
    GEOHIVE_CATALOGUE_ORIGIN,
  );
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("startindex", String(offset + 1));
  if (query !== undefined && query.trim() !== "") {
    url.searchParams.set("q", query);
  }
  return url.toString();
}

export function catalogueItemUrl(dataId: string): string {
  requireRecordId(dataId);
  return `${GEOHIVE_CATALOGUE_ORIGIN}/api/search/v1/collections/all/items/${dataId}`;
}

export function portalItemDataUrl(dataId: string): string {
  requireRecordId(dataId);
  const url = new URL(
    `/sharing/rest/content/items/${dataId}/data`,
    ARCGIS_PORTAL_ORIGIN,
  );
  url.searchParams.set("f", "json");
  return url.toString();
}

export function requireRecordId(value: string): void {
  if (!/^[a-f0-9]{32}$/iu.test(value)) {
    throw new AppError("INVALID_REQUEST", 'The "data_id" is invalid.');
  }
}

export function validateArcGisUrl(
  value: string,
  allowedHosts: ReadonlySet<string>,
): ValidatedArcGisUrl | undefined {
  const url = safeHttpsUrl(value, allowedHosts);
  if (!url || url.search !== "" || url.hash !== "") {
    return undefined;
  }
  if (/%(?:2f|5c)/iu.test(url.pathname) || url.pathname.includes("\\")) {
    return undefined;
  }

  const match = url.pathname.match(
    /^(?:\/[a-z0-9_-]+)?\/arcgis\/rest\/services\/(.+)\/(FeatureServer|MapServer)(?:\/(\d+))?\/?$/iu,
  );
  if (!match || !validServicePath(match[1]!)) {
    return undefined;
  }
  const serviceType = canonicalServiceType(match[2]!);
  const servicePath = url.pathname.slice(
    0,
    url.pathname.toLowerCase().lastIndexOf(`/${serviceType.toLowerCase()}`) +
      serviceType.length +
      1,
  );
  const layerId = match[3] === undefined ? undefined : Number(match[3]);
  if (layerId !== undefined && !Number.isSafeInteger(layerId)) {
    return undefined;
  }

  return {
    serviceUrl: `${url.origin}${servicePath}`,
    serviceType,
    ...(layerId !== undefined ? { layerId } : {}),
  };
}

export function validateWmsUrl(
  value: string,
  allowedHosts: ReadonlySet<string>,
): string | undefined {
  const url = safeHttpsUrl(value, allowedHosts);
  if (!url || url.search !== "" || url.hash !== "") {
    return undefined;
  }
  if (/%(?:2f|5c)/iu.test(url.pathname) || url.pathname.includes("\\")) {
    return undefined;
  }
  if (!/^\/geoserver\/[a-z0-9._~-]+\/(?:wms|ows)\/?$/iu.test(url.pathname)) {
    return undefined;
  }
  return `${url.origin}${url.pathname.replace(/\/$/u, "")}`;
}

export function sameEndpoint(left: string, right: string): boolean {
  try {
    const a = new URL(left);
    const b = new URL(right);
    return (
      a.protocol === b.protocol &&
      a.hostname.toLowerCase() === b.hostname.toLowerCase() &&
      normalizedPort(a) === normalizedPort(b) &&
      a.pathname.replace(/\/$/u, "") === b.pathname.replace(/\/$/u, "") &&
      a.search === b.search &&
      a.hash === b.hash
    );
  } catch {
    return false;
  }
}

function safeHttpsUrl(
  value: string,
  allowedHosts: ReadonlySet<string>,
): URL | undefined {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return undefined;
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    !allowedHosts.has(url.hostname.toLowerCase())
  ) {
    return undefined;
  }
  return url;
}

function validServicePath(value: string): boolean {
  const segments = value.split("/");
  return (
    segments.length > 0 &&
    segments.every(
      (segment) =>
        segment !== "" &&
        segment !== "." &&
        segment !== ".." &&
        !/[\u0000-\u001f\u007f]/u.test(segment),
    )
  );
}

function canonicalServiceType(value: string): "FeatureServer" | "MapServer" {
  return value.toLowerCase() === "featureserver"
    ? "FeatureServer"
    : "MapServer";
}

function normalizedPort(url: URL): string {
  return url.port === "443" ? "" : url.port;
}
