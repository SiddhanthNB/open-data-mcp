const SENSITIVE_QUERY_PARAMETERS = new Set([
  "accesstoken",
  "apikey",
  "authorization",
  "clientsecret",
  "credential",
  "googleaccessid",
  "key",
  "password",
  "passwd",
  "secret",
  "securitytoken",
  "sig",
  "signature",
  "token",
]);

function isSensitiveParameter(name: string): boolean {
  const normalized = name.toLowerCase().replace(/[^a-z0-9]/gu, "");
  return [...SENSITIVE_QUERY_PARAMETERS].some(
    (sensitive) => normalized === sensitive || normalized.endsWith(sensitive),
  );
}

export function isBrowserDataUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username !== "" ||
      url.password !== ""
    ) {
      return false;
    }
    const queryHasCredential = [...url.searchParams.keys()].some(isSensitiveParameter);
    const fragmentParameters = url.hash.includes("=")
      ? new URLSearchParams(url.hash.slice(1))
      : undefined;
    const fragmentHasCredential = fragmentParameters
      ? [...fragmentParameters.keys()].some(isSensitiveParameter)
      : false;
    return !queryHasCredential && !fragmentHasCredential;
  } catch {
    return false;
  }
}

export function linkName(url: string, fallback: string): string {
  try {
    const pathname = new URL(url).pathname;
    const candidate = pathname.slice(pathname.lastIndexOf("/") + 1);
    return candidate ? decodeURIComponent(candidate) : fallback;
  } catch {
    return fallback;
  }
}
