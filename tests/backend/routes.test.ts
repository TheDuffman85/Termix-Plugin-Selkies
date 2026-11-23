import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express, { type Router } from "express";
import WebSocket from "ws";
import {
  createMockCtx,
  type MockPluginContext,
} from "@termix-ssh/plugin-sdk/testing";
import type {
  PluginManifest,
  PluginProtocolTarget,
} from "@termix-ssh/plugin-sdk/backend";
import manifestJson from "../../manifest.json";
import { activate } from "../../src/backend/index.js";
import { SESSION_ACCESS_MS } from "../../src/backend/sessions.js";
import { fakeSelkies } from "./helpers.js";

const manifest = manifestJson as unknown as PluginManifest;

function target(password = "secret"): PluginProtocolTarget {
  return {
    host: {
      id: 1,
      name: "desk",
      ip: "127.0.0.1",
      port: 22,
      ownerUserId: "user-1",
      jumpHosts: [],
    },
    shared: false,
    auth: { authType: "direct", username: "abc", password, fields: {} },
  };
}

let selkies: Awaited<ReturnType<typeof fakeSelkies>>;
let mock: MockPluginContext;
let server: http.Server;
let base: string;
let streamStatus: number;

async function start(
  options: {
    permissions?: string[];
    password?: string;
    enabled?: boolean;
  } = {},
) {
  let router: Router | null = null;
  mock = createMockCtx({
    pluginId: manifest.id,
    manifest,
    sandbox: true,
    capabilities: manifest.capabilities,
    router: () => (router = express.Router()),
    permissions: options.permissions ?? ["selkies.connect"],
    hosts: [
      {
        id: 1,
        userId: "user-1",
        name: "desk",
        ip: "127.0.0.1",
        port: 22,
        username: "abc",
        tags: null,
        folder: null,
        authType: "direct",
      },
    ],
    protocolTargets: { "1:selkies": target(options.password) },
    settings: { enabled: options.enabled ?? true },
  } as Parameters<typeof createMockCtx>[0]);
  await mock.ctx.settings.setHost(1, "enableSelkies", true);
  await mock.ctx.settings.setHost(1, "selkiesScheme", "http");
  await mock.ctx.settings.setHost(1, "selkiesPort", selkies.port);
  await mock.ctx.settings.setHost(1, "selkiesPath", "/desk/");
  await activate(mock.ctx);

  const app = express();
  app.use((req, _res, next) => {
    // Core sets the actor for signed-in routes; public ones have none.
    mock.setActor(req.path.startsWith("/s/") ? undefined : "user-1");
    next();
  });
  app.use((req, res, next) => router!(req, res, next));
  server = http.createServer(app);
  const upgrade = mock.wsRoutes.find(
    (route) => route.path === "/stream",
  )!.upgrade!;
  server.on("upgrade", (req, socket: Duplex, head) =>
    upgrade(req, socket, head, ""),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function post(path: string) {
  const response = await fetch(`http://${base}${path}`, { method: "POST" });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

beforeEach(async () => {
  streamStatus = 204;
  selkies = await fakeSelkies((req, res) => {
    if (req.headers.authorization !== "Basic YWJjOnNlY3JldA==") {
      res.writeHead(401);
      res.end();
      return;
    }
    if (req.url === "/desk/api/websockets") {
      res.writeHead(streamStatus);
      res.end();
      return;
    }
    if (req.url === "/desk/wait") return;
    if (req.url !== "/desk/") {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html><head></head><body>desk</body></html>");
  }, "/desk/api/websockets");
});

afterEach(async () => {
  for (const dispose of mock?.disposals ?? []) await dispose();
  if (server) {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await selkies.close();
  vi.useRealTimers();
});

describe("routes", () => {
  it("registers a public proxy route and the stream socket", async () => {
    await start();
    expect(mock.httpRouters[0]).toMatchObject({
      public: ["/s/:token/*"],
      rawBody: true,
    });
    expect(mock.wsRoutes).toEqual([
      expect.objectContaining({ path: "/stream", options: { public: true } }),
    ]);
  });

  it("launches a session that serves the desktop and its socket", async () => {
    await start();
    const launched = await post("/launch/1");
    expect(launched.status).toBe(200);
    const token = launched.body.token as string;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Open in browser is off unless the host turns it on.
    expect(launched.body.directUrl).toBeNull();
    expect(selkies.upgrades).toHaveLength(0);

    const page = await fetch(`http://${base}/s/${token}/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("__termix/shim.js");

    const ws = new WebSocket(
      `ws://${base}/plugin-ws/selkies/stream?t=${token}&p=websockets`,
    );
    const first = await new Promise<string>((resolve, reject) => {
      ws.once("message", (data) => resolve(data.toString()));
      ws.once("error", reject);
    });
    expect(first).toBe("MODE websockets");
    ws.close();

    const closed = await post(`/sessions/${token}/close`);
    expect(closed.body).toEqual({ closed: true });
    expect((await fetch(`http://${base}/s/${token}/`)).status).toBe(404);
    expect((await fetch(`http://${base}/s/${token}/app.js`)).status).toBe(404);
  });

  it.each(["host share", "connect policy grant"] as const)(
    "closes active connections when the opener loses a %s",
    async (grant) => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
      await start();
      let allowed = true;
      const resolve = mock.ctx.credentials.resolveHostProtocol;
      const access = vi
        .spyOn(mock.ctx.credentials, "resolveHostProtocol")
        .mockImplementation(async (hostId, protocol) => {
          expect(mock.ctx.currentActor()).toBe("user-1");
          if (allowed) return resolve(hostId, protocol);
          if (grant === "host share") return null;
          throw Object.assign(new Error("Access approval expired"), {
            code: "access-required",
          });
        });
      const {
        body: { token },
      } = await post("/launch/1");
      const page = `http://${base}/s/${token}/`;
      expect((await fetch(page)).status).toBe(200);
      const ws = new WebSocket(
        `ws://${base}/plugin-ws/selkies/stream?t=${token}`,
      );
      const closed = new Promise<void>((resolve) =>
        ws.once("close", () => resolve()),
      );
      await new Promise<void>((resolve, reject) => {
        ws.once("open", resolve);
        ws.once("error", reject);
      });
      try {
        expect(access).toHaveBeenCalledWith(1, "selkies");
        const pending = fetch(`${page}wait`);
        await vi.waitFor(() =>
          expect(selkies.seen.some(({ url }) => url === "/desk/wait")).toBe(
            true,
          ),
        );
        allowed = false;
        await vi.advanceTimersByTimeAsync(SESSION_ACCESS_MS);
        await closed;
        expect((await pending).status).toBe(404);
        expect((await fetch(page)).status).toBe(404);
      } finally {
        ws.terminate();
      }
    },
  );

  it("sends the container's own address once Open in browser is on", async () => {
    await start();
    await mock.ctx.settings.setHost(1, "selkiesOpenInBrowser", true);
    const { body } = await post("/launch/1");
    expect(body.directUrl).toBe(`http://127.0.0.1:${selkies.port}/desk/`);
  });

  it("redirects the bare session path to its folder", async () => {
    await start();
    const { body } = await post("/launch/1");
    const response = await fetch(`http://${base}/s/${body.token}`, {
      redirect: "manual",
    });
    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toBe(`${body.token}/`);
  });

  it("refuses without the connect permission", async () => {
    await start({ permissions: [] });
    expect((await post("/launch/1")).status).toBe(403);
    expect((await post("/probe/1")).status).toBe(403);
  });

  it("reports a refused container login", async () => {
    await start({ password: "wrong" });
    const result = await post("/launch/1");
    expect(result.status).toBe(409);
    expect(result.body.code).toBe("unauthorized");
  });

  it("reports an unreachable container", async () => {
    await start();
    await selkies.close();
    const result = await post("/probe/1");
    expect(result.status).toBe(502);
    expect(result.body.code).toBe("unreachable");
  });

  it("answers 404 for an unknown host and 400 for a bad id", async () => {
    await start();
    expect((await post("/launch/2")).status).toBe(404);
    expect((await post("/launch/abc")).status).toBe(400);
  });

  it("refuses a host with Selkies off", async () => {
    await start();
    await mock.ctx.settings.setHost(1, "enableSelkies", false);
    const result = await post("/launch/1");
    expect(result.status).toBe(409);
    expect(result.body.code).toBe("not-enabled");
  });

  it("closes every way in when an admin turns Selkies off", async () => {
    await start();
    const { body } = await post("/launch/1");
    await mock.ctx.settings.set("enabled", false);
    expect((await fetch(`http://${base}/s/${body.token}/`)).status).toBe(404);
    expect((await post("/launch/1")).status).toBe(503);
  });

  it("probes a host", async () => {
    await start();
    expect(await post("/probe/1")).toEqual({ status: 200, body: { ok: true } });
    expect(selkies.seen[0]).toMatchObject({
      method: "GET",
      url: "/desk/api/websockets",
    });
    expect(selkies.upgrades).toHaveLength(0);
  });

  it.each([200, 409])(
    "rejects HTTP %s from the stream probe",
    async (status) => {
      await start();
      streamStatus = status;
      expect(await post("/probe/1")).toMatchObject({
        status: 502,
        body: { code: "not-selkies" },
      });
    },
  );

  it("refuses launch and probe when the configured stream path is missing", async () => {
    await start();
    await mock.ctx.settings.setHost(1, "selkiesPath", "/missing/");
    for (const path of ["/probe/1", "/launch/1"]) {
      expect(await post(path)).toMatchObject({
        status: 502,
        body: { code: "not-selkies" },
      });
    }
  });

  it("audits each launch", async () => {
    await start();
    await post("/launch/1");
    expect(mock.audits).toEqual([
      expect.objectContaining({
        action: "selkies_connect",
        resourceId: "1",
        success: true,
      }),
    ]);
  });
});
