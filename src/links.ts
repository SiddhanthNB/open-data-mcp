export function isBrowserDataUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
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
