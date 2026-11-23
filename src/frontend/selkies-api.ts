import type {
  PluginHostRecord,
  TermixApp,
} from "@termix-ssh/plugin-sdk/frontend";

export const PLUGIN_ID = "selkies";
export const ENABLE_KEY = "enableSelkies";
export const PORT_KEY = "selkiesPort";
export const DEFAULT_PORT = 3001;

/** Each frame runs activate, so each keeps its own reference. */
let current: TermixApp | null = null;

export function setApp(app: TermixApp | null): void {
  current = app;
}

function app(): TermixApp {
  if (!current) throw new Error("Selkies is not active");
  return current;
}

export function selkiesSettings(
  host: Pick<PluginHostRecord, "pluginSettings"> | null | undefined,
): Record<string, unknown> {
  return host?.pluginSettings?.[PLUGIN_ID] ?? {};
}

export function selkiesEnabled(
  host: Pick<PluginHostRecord, "pluginSettings"> | null | undefined,
): boolean {
  return selkiesSettings(host)[ENABLE_KEY] === true;
}

/** An Error that keeps the server's code, like "unreachable". */
export interface SelkiesApiError extends Error {
  code?: string;
  status?: number;
}

export function apiError(error: unknown): SelkiesApiError {
  const failure = error as {
    message?: string;
    response?: { status?: number; data?: { error?: string; code?: string } };
  };
  const data = failure?.response?.data;
  const wrapped: SelkiesApiError = new Error(
    data?.error || failure?.message || "Request failed",
  );
  wrapped.code = data?.code;
  wrapped.status = failure?.response?.status;
  return wrapped;
}

export interface LaunchResult {
  token: string;
  /** The container's own address, or null when Open in browser is off. */
  directUrl: string | null;
}

export async function launch(hostId: string | number): Promise<LaunchResult> {
  try {
    const { data } = await app().api.post<LaunchResult>(
      `/launch/${encodeURIComponent(String(hostId))}`,
      {},
    );
    return data;
  } catch (error) {
    throw apiError(error);
  }
}

export async function probe(hostId: string | number): Promise<void> {
  try {
    await app().api.post(`/probe/${encodeURIComponent(String(hostId))}`, {});
  } catch (error) {
    throw apiError(error);
  }
}

/**
 * Ends a session when its tab goes. Also runs as a tab unmounts after the
 * plugin was turned off, when there is no app left to ask: the backend then
 * ends the session itself once it sits idle.
 */
export function closeSession(token: string): void {
  if (!current) return;
  void current.api
    .post(`/sessions/${encodeURIComponent(token)}/close`, {})
    .catch(() => undefined);
}

/**
 * The absolute address of this plugin's routes, as the frame's API client
 * uses it: "https://termix.example/base/plugin-api/selkies".
 */
export function apiRoot(): string {
  const client = app().api as { defaults?: { baseURL?: string } };
  const base = (client.defaults?.baseURL ?? "").replace(/\/+$/, "");
  const mount = `/plugin-api/${PLUGIN_ID}`;
  if (/^https?:\/\//.test(base) && base.endsWith(mount)) return base;
  // Fall back to the frame's own address, served from /plugin-assets/<id>/.
  const path = location.pathname;
  const at = path.indexOf("/plugin-assets/");
  const root = at >= 0 ? path.slice(0, at) : "";
  return `${location.protocol}//${location.host}${root}${mount}`;
}

export function sessionUrl(token: string): string {
  return `${apiRoot()}/s/${encodeURIComponent(token)}/`;
}
