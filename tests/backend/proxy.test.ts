import http from "node:http";
import zlib from "node:zlib";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import {
  PAGE_CSP,
  checkPath,
  forward,
  injectShim,
  rewriteLocation,
  shimHrefFor,
  takeMovedHeaders,
  upstreamRequestHeaders,
} from "../../src/backend/proxy.js";
import { MOVED_HEADERS_PARAM, SHIM_SOURCE } from "../../src/backend/shim.js";
import { fakeSelkies, localUpstream } from "./helpers.js";

describe("checkPath", () => {
  it("allows the page, its files and the client's API calls", () => {
    expect(checkPath("/")).toBe("");
    expect(checkPath("/index.html")).toBe("index.html");
    expect(checkPath("/assets/index-abc.js")).toBe("assets/index-abc.js");
    expect(checkPath("/api/websockets")).toBe("api/websockets");
    expect(checkPath("/api/files/Desktop/a%20b.txt")).toBe(
      "api/files/Desktop/a%20b.txt",
    );
    expect(checkPath("/api/upload")).toBe("api/upload");
  });

  it("refuses climbing out and operator routes", () => {
    expect(checkPath("/../etc/passwd")).toBeNull();
    expect(checkPath("/a/%2e%2e/b")).toBeNull();
    expect(checkPath("/a//b")).toBeNull();
    expect(checkPath("/a\\b")).toBeNull();
    expect(checkPath("/api/tokens")).toBeNull();
    expect(checkPath("/api/sessions/1")).toBeNull();
    expect(checkPath("/api/recording")).toBeNull();
    expect(checkPath("/api/metrics")).toBeNull();
    expect(checkPath("/pelorus/")).toBeNull();
    expect(checkPath("/devmode")).toBeNull();
    expect(checkPath("/%zz")).toBeNull();
  });
});

describe("headers", () => {
  const upstream = localUpstream(3000);

  it("sends the container's own host, origin and login, never Termix's", () => {
    const out = upstreamRequestHeaders(
      {
        host: "termix.example",
        origin: "null",
        cookie: "jwt=abc",
        authorization: "Bearer termix",
        "x-forwarded-for": "1.2.3.4",
        "content-type": "application/octet-stream",
        "content-length": "5",
        connection: "keep-alive",
        "accept-encoding": "gzip",
      },
      upstream,
      { "x-upload-path": "/config/Desktop" },
      false,
    );
    expect(out).toEqual({
      host: "127.0.0.1:3000",
      origin: "http://127.0.0.1:3000",
      authorization: "Basic YWJjOnNlY3JldA==",
      "content-type": "application/octet-stream",
      "content-length": "5",
      "x-upload-path": "/config/Desktop",
      "x-forwarded-proto": "http",
    });
  });

  it("takes back only X-Upload-* headers from the query", () => {
    const encoded = Buffer.from(
      JSON.stringify({
        "X-Upload-Path": "/config",
        "x-upload-offset": "0",
        authorization: "Basic evil",
        "x-upload-bad": "a\r\nb",
      }),
    ).toString("base64");
    const result = takeMovedHeaders(
      new URLSearchParams(
        `a=1&${MOVED_HEADERS_PARAM}=${encodeURIComponent(encoded)}`,
      ),
    );
    expect(result.headers).toEqual({
      "x-upload-path": "/config",
      "x-upload-offset": "0",
    });
    expect(result.search).toBe("?a=1");
    expect(
      takeMovedHeaders(new URLSearchParams(`${MOVED_HEADERS_PARAM}=@@@`))
        .headers,
    ).toEqual({});
  });

  it("keeps redirects inside the session", () => {
    const sub = localUpstream(3000, "/desk/");
    expect(rewriteLocation("/desk/", sub, "/")).toBe("./");
    expect(rewriteLocation("/desk/files/", sub, "/a/b")).toBe("../files/");
    expect(rewriteLocation("/desk", sub, "/")).toBe("./");
    expect(rewriteLocation("http://127.0.0.1:3000/desk/x", sub, "/")).toBe("x");
    expect(rewriteLocation("/other/", sub, "/")).toBe("/other/");
    expect(rewriteLocation("https://elsewhere.example/", sub, "/")).toBe(
      "https://elsewhere.example/",
    );
  });
});

describe("injectShim", () => {
  it("puts the shim first in the head", () => {
    expect(
      injectShim(
        '<!doctype html><html><head lang="x"><title>t</title></head></html>',
        "S",
      ),
    ).toBe(
      '<!doctype html><html><head lang="x"><script src="S"></script><title>t</title></head></html>',
    );
    expect(injectShim("<!DOCTYPE html><body></body>", "S")).toBe(
      '<!DOCTYPE html><script src="S"></script><body></body>',
    );
    expect(injectShim("<p>x</p>", "S")).toBe(
      '<script src="S"></script><p>x</p>',
    );
  });

  it("references the shim from pages in subfolders", () => {
    expect(shimHrefFor("/")).toMatch(/^__termix\/shim\.js\?v=/);
    expect(shimHrefFor("/a/b.html")).toMatch(/^\.\.\/__termix\/shim\.js\?v=/);
  });
});

describe("forward", () => {
  let selkies: Awaited<ReturnType<typeof fakeSelkies>>;
  let server: http.Server;
  let base: string;

  beforeEach(async () => {
    selkies = await fakeSelkies((req, res) => {
      if (req.url === "/desk/") {
        const html = zlib.gzipSync(
          Buffer.from("<html><head></head><body>desk</body></html>"),
        );
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "content-encoding": "gzip",
          "content-security-policy": "frame-ancestors 'self'",
          "x-frame-options": "DENY",
          "set-cookie": "selkies_socket=1; SameSite=Strict",
        });
        res.end(html);
        return;
      }
      if (req.url === "/desk/app.js") {
        res.writeHead(200, { "content-type": "text/javascript" });
        res.end("console.log(1)");
        return;
      }
      if (req.url === "/desk/large.html") {
        const body = zlib.gzipSync(" ".repeat(4 * 1024 * 1024 + 1));
        res.writeHead(200, {
          "content-type": "text/html",
          "content-encoding": "gzip",
        });
        res.end(body);
        return;
      }
      if (req.url === "/desk/locked") {
        res.writeHead(401, { "www-authenticate": 'Basic realm="x"' });
        res.end();
        return;
      }
      if (req.url?.startsWith("/desk/api/upload")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"ok":true}');
        return;
      }
      res.writeHead(302, { location: "/desk/" });
      res.end();
    });
    const upstream = localUpstream(selkies.port, "/desk/");
    const app = express();
    app.use("/s/tok", (req, res) => {
      void forward(req, res, upstream, req.url);
    });
    server = http.createServer(app);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/s/tok`;
  });

  afterEach(async () => {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await selkies.close();
  });

  it("serves the page with the shim, sandboxed and uncompressed", async () => {
    const response = await fetch(`${base}/`, { headers: { origin: "null" } });
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toMatch(
      /^<html><head><script src="__termix\/shim\.js\?v=\w+"><\/script><\/head>/,
    );
    expect(response.headers.get("content-security-policy")).toBe(PAGE_CSP);
    // The parent is the opaque-origin view frame, which no frame-ancestors
    // source matches.
    expect(PAGE_CSP).not.toContain("frame-ancestors");
    expect(response.headers.get("x-frame-options")).toBeNull();
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("access-control-allow-origin")).toBe("null");
    expect(selkies.seen[0].headers.authorization).toBe(
      "Basic YWJjOnNlY3JldA==",
    );
    expect(selkies.seen[0].headers.host).toBe(`127.0.0.1:${selkies.port}`);
    expect(selkies.seen[0].headers["accept-encoding"]).toBeUndefined();
  });

  it("streams other files as they are", async () => {
    const response = await fetch(`${base}/app.js`);
    expect(await response.text()).toBe("console.log(1)");
    expect(response.headers.get("content-type")).toBe("text/javascript");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects HTML that exceeds the limit after decompression", async () => {
    const response = await fetch(`${base}/large.html`);
    expect(response.status).toBe(502);
  });

  it("serves the shim itself", async () => {
    const response = await fetch(`${base}/__termix/shim.js?v=1`);
    expect(response.headers.get("content-type")).toMatch(/javascript/);
    expect(await response.text()).toBe(SHIM_SOURCE);
    expect(selkies.seen).toHaveLength(0);
  });

  it("never lets the container ask the browser for a password", async () => {
    const response = await fetch(`${base}/locked`);
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBeNull();
  });

  it("refuses operator routes without asking the container", async () => {
    expect((await fetch(`${base}/api/tokens`, { method: "POST" })).status).toBe(
      404,
    );
    expect(selkies.seen).toHaveLength(0);
  });

  it("passes upload bodies and moved headers on", async () => {
    const moved = Buffer.from(
      JSON.stringify({ "x-upload-path": "/config/Desktop/a.txt" }),
    ).toString("base64");
    const response = await fetch(
      `${base}/api/upload?${MOVED_HEADERS_PARAM}=${encodeURIComponent(moved)}`,
      {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: "hello",
      },
    );
    expect(await response.json()).toEqual({ ok: true });
    const seen = selkies.seen[0];
    expect(seen.url).toBe("/desk/api/upload");
    expect(seen.body).toBe("hello");
    expect(seen.headers["x-upload-path"]).toBe("/config/Desktop/a.txt");
  });

  it("rewrites redirects into the session", async () => {
    const response = await fetch(`${base}/somewhere/deep`, {
      redirect: "manual",
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("../");
  });

  it("answers 502 when the container is gone", async () => {
    await selkies.close();
    const response = await fetch(`${base}/app.js`);
    expect(response.status).toBe(502);
    // Readable inside the view frame, not blocked by core's frame-ancestors.
    expect(response.headers.get("content-security-policy")).toBe(PAGE_CSP);
  });
});
