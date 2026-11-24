import http, {
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
} from "node:http";
import zlib from "node:zlib";
import type { Duplex } from "node:stream";
import type { Request, Response } from "express";
import {
  stripSessionToken,
  withSessionToken,
  type Upstream,
} from "./upstream.js";
import { MOVED_HEADERS_PARAM, SHIM_PATH, SHIM_SOURCE } from "./shim.js";

/**
 * Selkies routes a desktop page has no business calling through Termix:
 * minting access tokens and the operator's session, recording and metrics
 * controls, the companion app and the development server.
 */
const REFUSED = [
  /^api\/tokens(\/|$)/,
  /^api\/sessions(\/|$)/,
  /^api\/recording(\/|$)/,
  /^api\/metrics(\/|$)/,
  /^pelorus(\/|$)/,
  /^devmode(\/|$)/,
];

/** Unreserved and sub-delim characters, "%" for escapes, and "/". */
const SAFE_PATH = /^[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/;

/**
 * A request path below the session root, without the leading "/": null when
 * it is malformed, climbs out of the root or names a refused route.
 */
export function checkPath(rest: string): string | null {
  const path = rest.replace(/^\/+/, "");
  if (!SAFE_PATH.test(path)) return null;
  // nginx decodes "%2F" and merges slashes before it routes, so an escaped
  // slash or backslash could reach a refused route under another spelling.
  if (/%(2f|5c)/i.test(path)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return null;
  }
  if (decoded.includes("\\") || decoded.includes("\0")) return null;
  const parts = decoded.split("/");
  // Only a trailing slash may leave a segment empty.
  if (parts.slice(0, -1).some((part) => part === "")) return null;
  if (parts.some((part) => part === "." || part === "..")) return null;
  const lower = decoded.toLowerCase();
  if (REFUSED.some((pattern) => pattern.test(lower))) return null;
  return path;
}

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** Request headers never passed on to the container. */
const DROP_REQUEST = new Set([
  "host",
  "origin",
  "referer",
  "cookie",
  "authorization",
  "forwarded",
  "content-length",
]);

/** Response headers replaced or never passed back. */
const DROP_RESPONSE = new Set([
  "set-cookie",
  "www-authenticate",
  "content-security-policy",
  "content-security-policy-report-only",
  "x-frame-options",
  "strict-transport-security",
  "permissions-policy",
  "cross-origin-opener-policy",
  "cross-origin-embedder-policy",
  "cross-origin-resource-policy",
  "access-control-allow-origin",
  "access-control-allow-credentials",
]);

/** Content codings the HTML rewrite can undo. */
const DECODABLE = new Set(["gzip", "x-gzip", "deflate", "br", "identity"]);

/**
 * The browser's Accept-Encoding without codings the proxy can't decompress
 * (like zstd or "*"), so an HTML answer can always be read and rewritten.
 */
export function decodableEncodings(value: string | string[]): string | null {
  const list = (Array.isArray(value) ? value.join(",") : value)
    .split(",")
    .map((part) => part.trim())
    .filter((part) =>
      DECODABLE.has(part.split(";", 1)[0]!.trim().toLowerCase()),
    );
  return list.length ? list.join(", ") : null;
}

/**
 * The proxied page always runs sandboxed, even opened in a tab of its own, so
 * code from the container can never act as Termix.
 *
 * No frame-ancestors: the page's parent is the plugin's sandboxed view frame,
 * whose origin is opaque, and an opaque ancestor matches no source, not even
 * 'self'. The policy replaces core's default (which has frame-ancestors
 * 'self'), so it must be left out here. The session token in the path keeps
 * other sites from framing someone's desktop.
 */
export const PAGE_CSP =
  "sandbox allow-scripts allow-forms allow-popups allow-downloads allow-pointer-lock allow-modals";

export function upstreamRequestHeaders(
  incoming: IncomingHttpHeaders,
  upstream: Upstream,
  moved: Record<string, string> = {},
  keepEncoding = true,
): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(incoming)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || DROP_REQUEST.has(lower)) continue;
    if (lower.startsWith("x-forwarded-") || lower.startsWith("x-termix")) {
      continue;
    }
    if (lower === "accept-encoding") {
      const accepted = keepEncoding ? decodableEncodings(value) : null;
      if (accepted) out[lower] = accepted;
      continue;
    }
    out[lower] = value;
  }
  for (const [name, value] of Object.entries(moved)) out[name] = value;
  if (incoming["content-length"] !== undefined) {
    out["content-length"] = incoming["content-length"];
  }
  out.host = upstream.hostHeader;
  if (incoming.origin !== undefined) out.origin = upstream.origin;
  if (upstream.authorization) out.authorization = upstream.authorization;
  out["x-forwarded-proto"] = upstream.scheme;
  return out;
}

/**
 * X-Upload-* headers the shim moved into the query. Only those names are
 * taken back, so the parameter can't set anything else on the request.
 */
export function takeMovedHeaders(search: URLSearchParams | string): {
  headers: Record<string, string>;
  search: string;
} {
  if (typeof search === "string") {
    const query = search.replace(/^\?/, "");
    // Most requests carry no moved headers: pass their query on exactly as
    // the client wrote it, rather than re-encoding it.
    if (!query.includes(MOVED_HEADERS_PARAM)) {
      return { headers: {}, search: query ? `?${query}` : "" };
    }
    search = new URLSearchParams(query);
  }
  const raw = search.get(MOVED_HEADERS_PARAM);
  search.delete(MOVED_HEADERS_PARAM);
  const rest = search.toString();
  const headers: Record<string, string> = {};
  if (raw) {
    try {
      const parsed = JSON.parse(
        Buffer.from(raw, "base64").toString("utf8"),
      ) as unknown;
      if (parsed && typeof parsed === "object") {
        for (const [name, value] of Object.entries(parsed)) {
          const lower = name.toLowerCase();
          if (
            /^x-upload-[a-z0-9-]{1,40}$/.test(lower) &&
            typeof value === "string"
          ) {
            if (!/[\r\n]/.test(value) && value.length <= 4096) {
              headers[lower] = value;
            }
          }
        }
      }
    } catch {
      // A broken parameter is just dropped.
    }
  }
  return { headers, search: rest ? `?${rest}` : "" };
}

/**
 * A redirect the container sends, as a path relative to the page that asked,
 * so it stays inside this session whatever Termix's own base path is. Other
 * places are passed through unchanged.
 */
export function rewriteLocation(
  location: string,
  upstream: Upstream,
  requestRest: string,
): string {
  let target: string | null = null;
  if (location.startsWith("/") && !location.startsWith("//")) {
    target = location;
  } else {
    try {
      const url = new URL(location);
      if (url.host === upstream.hostHeader) {
        target = url.pathname + url.search + url.hash;
      }
    } catch {
      return location;
    }
  }
  if (target === null) return location;
  if (upstream.token) {
    // The token went to the container, never to the browser: keep it out of
    // a redirect that repeats the request's query.
    const hash = target.indexOf("#");
    const fragment = hash < 0 ? "" : target.slice(hash);
    const beforeHash = hash < 0 ? target : target.slice(0, hash);
    const mark = beforeHash.indexOf("?");
    if (mark >= 0) {
      target =
        beforeHash.slice(0, mark) +
        stripSessionToken(beforeHash.slice(mark)) +
        fragment;
    }
  }
  const base = upstream.path;
  const inside = target.startsWith(base)
    ? target.slice(base.length)
    : target === base.slice(0, -1)
      ? ""
      : null;
  if (inside === null) return location;
  const depth = requestRest.replace(/^\/+/, "").split("/").length - 1;
  return "../".repeat(depth) + inside || "./";
}

export function pageResponseHeaders(
  incoming: IncomingHttpHeaders,
  upstream: Upstream,
  requestRest: string,
  requestOrigin: string | undefined,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(incoming)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || DROP_RESPONSE.has(lower)) continue;
    if (lower === "location" && typeof value === "string") {
      out.location = rewriteLocation(value, upstream, requestRest);
      continue;
    }
    out[lower] = value;
  }
  out["cache-control"] = "no-store";
  out["content-security-policy"] = PAGE_CSP;
  out["referrer-policy"] = "no-referrer";
  out["x-content-type-options"] = "nosniff";
  out["cross-origin-resource-policy"] = "cross-origin";
  // The page's own requests come from its opaque origin: "null".
  if (requestOrigin) {
    out["access-control-allow-origin"] = requestOrigin;
    out.vary = "Origin";
  }
  return out;
}

const MAX_HTML_BYTES = 4 * 1024 * 1024;

/** Puts the shim first in <head>, or first in the document. */
export function injectShim(html: string, href: string): string {
  const tag = `<script src="${href}"></script>`;
  const head = /<head(\s[^>]*)?>/i.exec(html);
  if (head) {
    const at = head.index + head[0].length;
    return html.slice(0, at) + tag + html.slice(at);
  }
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  if (doctype) {
    return doctype[0] + tag + html.slice(doctype[0].length);
  }
  return tag + html;
}

let shimVersion: string | null = null;
function shimHref(): string {
  if (!shimVersion) {
    let hash = 0;
    for (let i = 0; i < SHIM_SOURCE.length; i++) {
      hash = (hash * 31 + SHIM_SOURCE.charCodeAt(i)) | 0;
    }
    shimVersion = (hash >>> 0).toString(36);
  }
  return `${SHIM_PATH}?v=${shimVersion}`;
}

/**
 * The shim sits at the session root, but a page in a subfolder references it
 * relative to itself: the right number of "../" in front.
 */
export function shimHrefFor(requestRest: string): string {
  const depth = requestRest.replace(/^\/+/, "").split("/").length - 1;
  return "../".repeat(depth) + shimHref();
}

function decompress(body: Buffer, encoding: string | undefined): Buffer {
  const options = { maxOutputLength: MAX_HTML_BYTES };
  switch ((encoding ?? "").trim().toLowerCase()) {
    case "gzip":
    case "x-gzip":
      return zlib.gunzipSync(body, options);
    case "deflate":
      return zlib.inflateSync(body, options);
    case "br":
      return zlib.brotliDecompressSync(body, options);
    case "":
    case "identity":
      return body;
    default:
      // Unreadable: answering with it would send garbage as plain HTML.
      throw new Error(`Unsupported content encoding ${encoding}`);
  }
}

function sendShim(res: Response): void {
  res.status(200);
  res.setHeader("content-type", "text/javascript; charset=utf-8");
  res.setHeader("cache-control", "public, max-age=86400");
  res.setHeader("content-security-policy", PAGE_CSP);
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("cross-origin-resource-policy", "cross-origin");
  res.setHeader("access-control-allow-origin", "*");
  res.end(SHIM_SOURCE);
}

function plainError(res: Response, status: number, message: string): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.status(status);
  res.setHeader("content-type", "text/plain; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  // Shown inside the view frame too, so it needs the page's policy.
  res.setHeader("content-security-policy", PAGE_CSP);
  res.end(message);
}

/** A request on one connection, with no agent pooling. */
export function upstreamRequest(
  upstream: Upstream,
  options: { method: string; path: string; headers: OutgoingHttpHeaders },
): http.ClientRequest {
  return http.request({
    method: options.method,
    path: options.path,
    headers: options.headers,
    createConnection: ((
      _opts: unknown,
      callback: (error: Error | null, socket?: Duplex) => void,
    ) => {
      upstream.connect().then(
        (socket) => callback(null, socket),
        (error: Error) => callback(error),
      );
      return undefined;
    }) as never,
  });
}

/**
 * Streams one request below a session's root to the container and the answer
 * back. HTML gets the shim; everything else passes through as it is.
 */
export function forward(
  req: Request,
  res: Response,
  upstream: Upstream,
  rawRest: string,
  signal?: AbortSignal,
): Promise<void> {
  const mark = rawRest.indexOf("?");
  const restPath = mark < 0 ? rawRest : rawRest.slice(0, mark);
  const rawSearch = mark < 0 ? "" : rawRest.slice(mark + 1);
  const checked = checkPath(restPath);
  if (checked === null) {
    plainError(res, 404, "Not found");
    req.resume();
    return Promise.resolve();
  }
  if (checked === SHIM_PATH) {
    sendShim(res);
    req.resume();
    return Promise.resolve();
  }
  const { headers: moved, search } = takeMovedHeaders(rawSearch);
  // A page may be HTML, which is rewritten: ask for it uncompressed.
  const mayBePage =
    checked === "" || checked.endsWith("/") || /\.html?$/i.test(checked);
  const origin =
    typeof req.headers.origin === "string" ? req.headers.origin : undefined;

  return new Promise((resolve) => {
    const request = upstreamRequest(upstream, {
      method: req.method,
      path: upstream.path + withSessionToken(checked + search, upstream.token),
      headers: upstreamRequestHeaders(req.headers, upstream, moved, !mayBePage),
    });
    let finished = false;
    const finish = () => {
      finished = true;
      res.removeListener("close", onClose);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    const onClose = () => {
      finish();
      request.destroy();
    };
    const onAbort = () => {
      onClose();
      plainError(res, 404, "This Selkies session has ended.");
    };
    res.once("close", onClose);
    signal?.addEventListener("abort", onAbort, { once: true });

    request.setTimeout(30_000, () => {
      // Only an answer that never starts is a failure; streams stay open.
      if (!res.headersSent) request.destroy(new Error("timeout"));
    });
    request.on("response", (answer: IncomingMessage) => {
      request.setTimeout(0);
      const status = answer.statusCode ?? 502;
      if (status === 401) {
        answer.destroy();
        plainError(
          res,
          401,
          "The Selkies container refused the login saved in Termix.",
        );
        finish();
        return;
      }
      const headers = pageResponseHeaders(
        answer.headers,
        upstream,
        restPath,
        origin,
      );
      const type = String(answer.headers["content-type"] ?? "");
      if (/^text\/html/i.test(type) && req.method !== "HEAD") {
        const chunks: Buffer[] = [];
        let size = 0;
        answer.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_HTML_BYTES) {
            answer.destroy();
            return;
          }
          chunks.push(chunk);
        });
        answer.on("end", () => {
          let body: Buffer;
          try {
            body = decompress(
              Buffer.concat(chunks),
              answer.headers["content-encoding"] as string | undefined,
            );
          } catch {
            plainError(res, 502, "The Selkies page could not be read.");
            finish();
            return;
          }
          const html = injectShim(body.toString("utf8"), shimHrefFor(restPath));
          delete headers["content-encoding"];
          delete headers["content-length"];
          delete headers.etag;
          delete headers["last-modified"];
          res.status(status);
          for (const [name, value] of Object.entries(headers)) {
            res.setHeader(name, value);
          }
          res.end(html);
          finish();
        });
        answer.on("error", () => {
          if (finished) return;
          plainError(res, 502, "The Selkies page could not be read.");
          finish();
        });
        answer.on("close", () => {
          if (!finished && size > MAX_HTML_BYTES) {
            plainError(res, 502, "The Selkies page is too large.");
            finish();
          }
        });
        return;
      }
      res.status(status);
      for (const [name, value] of Object.entries(headers)) {
        res.setHeader(name, value);
      }
      answer.pipe(res);
      answer.on("end", finish);
      // A stream cut short must not look complete: without a Content-Length,
      // ending the response would pass a truncated body off as the whole.
      const broken = () => {
        if (finished) return;
        finish();
        res.destroy();
      };
      answer.on("error", broken);
      answer.on("close", () => {
        if (!answer.complete) broken();
      });
    });
    request.on("error", () => {
      if (finished) return;
      plainError(
        res,
        502,
        "The Selkies container did not answer. Reload the tab to reconnect.",
      );
      finish();
    });
    if (req.method === "GET" || req.method === "HEAD") {
      request.end();
      req.resume();
    } else {
      req.pipe(request);
    }
  });
}
