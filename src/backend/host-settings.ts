import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";

export type SelkiesScheme = "https" | "http";
export type SelkiesRoute = "direct" | "ssh";

/** One host's Selkies settings, coerced to safe values. */
export interface SelkiesHostSettings {
  enabled: boolean;
  port: number;
  scheme: SelkiesScheme;
  /** The container's SUBFOLDER: starts and ends with "/". */
  path: string;
  route: SelkiesRoute;
  ignoreCert: boolean;
  /** Whether the tab offers "Open in browser". Off unless turned on. */
  openInBrowser: boolean;
  /** Where a browser reaches the container itself, or "" for the default. */
  publicUrl: string;
  manageContainer: boolean;
  containerName: string;
  idleMinutes: number;
}

export const DEFAULT_PORT = 3001;
export const DEFAULT_IDLE_MINUTES = 10;
export const MAX_IDLE_MINUTES = 1440;

/** Docker names/IDs only, never shell syntax or command-line options. */
export function containerName(value: unknown): string {
  return typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value.trim())
    ? value.trim()
    : "";
}

export function idleMinutes(value: unknown): number {
  const minutes = typeof value === "string" ? Number(value) : value;
  return typeof minutes === "number" &&
    Number.isInteger(minutes) &&
    minutes >= 1 &&
    minutes <= MAX_IDLE_MINUTES
    ? minutes
    : DEFAULT_IDLE_MINUTES;
}

export function asPort(value: unknown, fallback = DEFAULT_PORT): number {
  const port = typeof value === "string" ? Number(value) : value;
  return typeof port === "number" &&
    Number.isInteger(port) &&
    port >= 1 &&
    port <= 65535
    ? port
    : fallback;
}

/**
 * A SUBFOLDER as linuxserver writes it: "/" or "/name/". Anything with odd
 * characters, dot segments or a query falls back to "/", so the value can
 * never move the proxy outside the container's own paths.
 */
export function normalizePath(value: unknown): string {
  if (typeof value !== "string") return "/";
  const trimmed = value.trim();
  if (!trimmed) return "/";
  if (!/^[A-Za-z0-9._~\-/]+$/.test(trimmed)) return "/";
  const segments = trimmed.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return "/";
  }
  return segments.length ? `/${segments.join("/")}/` : "/";
}

/** An http(s) URL without credentials, or "". */
export function normalizePublicUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "";
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    if (url.username || url.password) return "";
    return url.toString();
  } catch {
    return "";
  }
}

export function parseHostSettings(
  values: Record<string, unknown> | null | undefined,
): SelkiesHostSettings {
  const v = values ?? {};
  return {
    enabled: v.enableSelkies === true,
    port: asPort(v.selkiesPort),
    scheme: v.selkiesScheme === "http" ? "http" : "https",
    path: normalizePath(v.selkiesPath),
    route: v.selkiesRoute === "ssh" ? "ssh" : "direct",
    ignoreCert: v.selkiesIgnoreCert !== false,
    openInBrowser: v.selkiesOpenInBrowser === true,
    publicUrl: normalizePublicUrl(v.selkiesPublicUrl),
    manageContainer: v.selkiesManageContainer === true,
    containerName: containerName(v.selkiesContainerName),
    idleMinutes: idleMinutes(v.selkiesIdleMinutes),
  };
}

export async function readHostSettings(
  ctx: PluginContext,
  hostId: number,
): Promise<SelkiesHostSettings> {
  const values = (await ctx.settings.getAll("host", hostId)) as Record<
    string,
    unknown
  >;
  return parseHostSettings(values);
}

/** "host:port", with brackets around an IPv6 address. */
export function hostPort(host: string, port: number): string {
  const bare = host.replace(/^\[|\]$/g, "");
  return bare.includes(":") ? `[${bare}]:${port}` : `${bare}:${port}`;
}

/**
 * The address "Open in browser" uses for a host, or null when the host has it
 * turned off.
 */
export function directUrl(
  settings: SelkiesHostSettings,
  ip: string,
): string | null {
  if (!settings.openInBrowser) return null;
  if (settings.publicUrl) return settings.publicUrl;
  return `${settings.scheme}://${hostPort(ip, settings.port)}${settings.path}`;
}
