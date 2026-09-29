const DEFAULT_HERMES_DASHBOARD_PORT = "9119";
const HERMES_DASHBOARD_API_PATHS = new Set(["", "/", "/chat"]);
const REDACTED_URL_USERINFO = "REDACTED";

export function isDefaultDashboardApiEntry(url: URL): boolean {
  const normalizedPath = url.pathname.replace(/\/+$/, "") || "/";
  return url.port === DEFAULT_HERMES_DASHBOARD_PORT && HERMES_DASHBOARD_API_PATHS.has(normalizedPath);
}

/**
 * The single normalizer for the Hermes gateway base URL, shared by the run
 * executor and the Test-Connection probe. Clearing the query and fragment here
 * is what keeps the probe validating the same origin+path a run will use; the
 * two per-file copies that previously existed had already drifted on exactly
 * these fields.
 */
export function normalizeBaseUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (isDefaultDashboardApiEntry(url)) {
      url.pathname = "/api";
    } else {
      url.pathname = url.pathname.replace(/\/+$/, "");
    }
    url.search = "";
    url.hash = "";
    return url;
  } catch {
    return null;
  }
}

export function apiUrl(baseUrl: URL, path: string): string {
  const base = baseUrl.toString().replace(/\/+$/, "");
  return `${base}${path}`;
}

/**
 * Mask the userinfo (username:password) on a copy of the URL so it is safe to
 * persist in run logs, run metadata, and UI command displays. The credential is
 * masked, not dropped: callers that must authenticate keep the original URL for
 * the real request and use this copy only for display.
 */
export function redactUrlCredentials(baseUrl: URL): URL {
  const redacted = new URL(baseUrl.toString());
  if (redacted.username || redacted.password) {
    redacted.username = REDACTED_URL_USERINFO;
    redacted.password = "";
  }
  return redacted;
}
