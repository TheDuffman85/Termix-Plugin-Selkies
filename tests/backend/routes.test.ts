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

function target(
  password = "secret",
  fields: Record<string, string> = {},
): PluginProtocolTarget {
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
    auth: { authType: "direct", username: "abc", password, fields },
  };
}

let selkies: Awaited<ReturnType<typeof fakeSelkies>>;
let mock: MockPluginContext;
let server: http.Server;
let base: string;
let streamStatus: number;
let streamChallenge: string | null;

async function start(
  options: {
    permissions?: string[];
    password?: string;
    enabled?: boolean;
    manageContainer?: boolean;
    token?: string;
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
    protocolTargets: {
      "1:selkies": target(
        options.password,
        options.token === undefined ? {} : { token: options.token },
      ),
    },
    settings: { enabled: options.enabled ?? true },
  } as Parameters<typeof createMockCtx>[0]);
  await mock.ctx.settings.setHost(1, "enableSelkies", true);
  await mock.ctx.settings.setHost(1, "selkiesScheme", "http");
  await mock.ctx.settings.setHost(1, "selkiesPort", selkies.port);
  await mock.ctx.settings.setHost(1, "selkiesPath", "/desk/");
  if (options.manageContainer) {
    await mock.ctx.settings.setHost(1, "selkiesManageContainer", true);
    await mock.ctx.settings.setHost(1, "selkiesContainerName", "webtop");
    await mock.ctx.settings.setHost(1, "selkiesIdleMinutes", 1);
  }
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

async function post(path: string, json?: unknown) {
  const response = await fetch(
    `http://${base}${path}`,
    json === undefined
      ? { method: "POST" }
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(json),
        },
  );
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

beforeEach(async () => {
  streamStatus = 204;
  streamChallenge = null;
  selkies = await fakeSelkies((req, res) => {
    if (req.headers.authorization !== "Basic YWJjOnNlY3JldA==") {
      res.writeHead(401);
      res.end();
      return;
    }
    if (req.url?.startsWith("/desk/api/websockets")) {
      res.writeHead(
        streamStatus,
        streamChallenge ? { "www-authenticate": streamChallenge } : {},
      );
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
  it("starts Docker and waits for the desktop to become ready", async () => {
    await start({ manageContainer: true });
    const exec = vi.spyOn(mock.ctx.ssh, "exec");
    streamStatus = 503;
    const launching = post("/launch/1");
    await vi.waitFor(() => expect(selkies.seen).toHaveLength(1));
    streamStatus = 204;
    const result = await launching;
    expect(result.status).toBe(200);
    expect(exec).toHaveBeenCalledWith(
      1,
      "docker container start 'webtop'",
      expect.anything(),
    );
    expect(selkies.seen.length).toBeGreaterThan(1);
  });

  it("keeps an active desktop running, then stops after disconnection", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    await start({ manageContainer: true });
    const exec = vi.spyOn(mock.ctx.ssh, "exec");
    const {
      body: { token },
    } = await post("/launch/1");
    const ws = new WebSocket(
      `ws://${base}/plugin-ws/selkies/stream?t=${token}`,
    );
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    try {
      await vi.advanceTimersByTimeAsync(120_000);
      expect(exec).toHaveBeenCalledTimes(1);
      const closed = new Promise<void>((resolve) =>
        ws.once("close", () => resolve()),
      );
      ws.close();
      await closed;
      await vi.advanceTimersByTimeAsync(45_000);
      expect(exec).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(exec).toHaveBeenCalledTimes(2);
      expect(exec).toHaveBeenLastCalledWith(
        1,
        "docker container stop --time 30 'webtop'",
        expect.anything(),
      );
      expect((await fetch(`http://${base}/s/${token}/`)).status).toBe(404);
    } finally {
      ws.terminate();
    }
  });

  it("never starts Docker without connect permission", async () => {
    await start({ manageContainer: true, permissions: [] });
    const exec = vi.spyOn(mock.ctx.ssh, "exec");
    expect((await post("/launch/1")).status).toBe(403);
    expect((await post("/probe/1")).status).toBe(403);
    expect(exec).not.toHaveBeenCalled();
  });

  it("reports Docker failures before contacting Selkies", async () => {
    await start({ manageContainer: true });
    vi.spyOn(mock.ctx.ssh, "exec").mockResolvedValue({
      stdout: "",
      stderr: "No such container: webtop",
      code: 1,
      timedOut: false,
      truncated: false,
    });
    expect(await post("/launch/1")).toMatchObject({
      status: 502,
      body: {
        code: "container-failed",
        error: expect.stringContaining("No such container"),
      },
    });
    expect(selkies.seen).toHaveLength(0);
  });

  it.each([
    {
      error: Object.assign(new Error("Host denied (verification failed)"), {
        code: "HOST_KEY_UNVERIFIED",
      }),
      code: "container-ssh-unverified",
      explanation: "SSH key is not trusted yet",
      nextStep: "verify its fingerprint and trust the key",
    },
    {
      // Some core versions/bridges keep the message without the error code.
      error: new Error(
        "This host's key is not trusted yet. Open a terminal to the host once to check and trust it.",
      ),
      code: "container-ssh-unverified",
      explanation: "SSH key is not trusted yet",
      nextStep: "verify its fingerprint and trust the key",
    },
    {
      error: Object.assign(new Error("Host denied (verification failed)"), {
        code: "HOST_KEY_CHANGED",
      }),
      code: "container-ssh-key-changed",
      explanation: "SSH key has changed",
      nextStep: "verify the new fingerprint before trusting it",
    },
    {
      error: new Error(
        "This host's key has changed. Open a terminal to the host to check the new key.",
      ),
      code: "container-ssh-key-changed",
      explanation: "SSH key has changed",
      nextStep: "verify the new fingerprint before trusting it",
    },
    {
      error: new Error("Connection lost before handshake"),
      code: "container-failed",
      explanation: "Could not start the Docker container over SSH",
      nextStep: "Details: Connection lost before handshake",
    },
  ])(
    "explains Docker startup failures in launch and probe: $code",
    async ({ error, code, explanation, nextStep }) => {
      await start({ manageContainer: true });
      vi.spyOn(mock.ctx.ssh, "exec").mockRejectedValue(error);
      for (const route of ["/launch/1", "/probe/1"]) {
        const result = await post(route);
        expect(result.status).toBe(502);
        expect(result.body.code).toBe(code);
        expect(result.body.error).toContain(explanation);
        expect(result.body.error).toContain(nextStep);
        expect(result.body.error).toContain("same host entry in Termix");
        expect(result.body.error).toContain(
          "even when the desktop route is Direct",
        );
      }
      expect(selkies.seen).toHaveLength(0);
    },
  );

  it("preserves connect-policy refusals during Docker startup", async () => {
    await start({ manageContainer: true });
    vi.spyOn(mock.ctx.ssh, "exec").mockRejectedValue(
      Object.assign(new Error("SSH access requires approval"), {
        code: "access-required",
      }),
    );
    expect(await post("/launch/1")).toEqual({
      status: 403,
      body: { code: "access-required", error: "SSH access requires approval" },
    });
  });

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

  it("launches and probes with a JSON body, as the frontend sends", async () => {
    await start();
    expect(await post("/probe/1", {})).toEqual({
      status: 200,
      body: { ok: true },
    });
    expect((await post("/launch/1", {})).status).toBe(200);
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

  it("reports a server in WebRTC mode", async () => {
    await start();
    streamStatus = 409;
    expect(await post("/probe/1")).toMatchObject({
      status: 502,
      body: { code: "websocket-mode-inactive" },
    });
  });

  it("sends the saved access token to the stream probe", async () => {
    await start({ token: " t0k " });
    expect(await post("/probe/1")).toEqual({ status: 200, body: { ok: true } });
    expect(selkies.seen[0].url).toBe("/desk/api/websockets?token=t0k");
  });

  it.each([
    { token: undefined, error: /wants an access token/ },
    { token: "t0k", error: /refused the access token/ },
  ])(
    "reports a secure-mode server that wants a token ($token)",
    async ({ token, error }) => {
      await start({ token });
      streamStatus = 401;
      streamChallenge = 'Bearer realm="Selkies Restricted"';
      const result = await post("/probe/1");
      expect(result).toMatchObject({
        status: 409,
        body: { code: "token-required" },
      });
      expect(result.body.error).toMatch(error);
    },
  );

  it.each([200, 404])(
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
