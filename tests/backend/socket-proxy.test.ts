import http from "node:http";
import type { AddressInfo } from "node:net";
import { Duplex } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  createSessionStore,
  type SessionStore,
} from "../../src/backend/sessions.js";
import {
  createSocketProxy,
  parseSocketUrl,
} from "../../src/backend/socket-proxy.js";
import { fakeSelkies, localUpstream } from "./helpers.js";

const TOKEN = "a".repeat(43);

/** Termix relays an end or an error to the browser, but a plain destroy stays local. */
function bridgeSocket(browser: Duplex): Duplex {
  const port = new Duplex({
    read: () => browser.resume(),
    write: (chunk, _encoding, callback) => browser.write(chunk, callback),
    final: (callback) => {
      browser.end();
      callback();
    },
    destroy: (error, callback) => {
      if (error) browser.destroy();
      callback(error);
    },
  });
  browser.on("data", (chunk) => {
    if (!port.push(chunk)) browser.pause();
  });
  browser.on("end", () => port.push(null));
  browser.on("close", () => port.destroy());
  return port;
}

describe("parseSocketUrl", () => {
  it("reads the token, the api path and the client's own query", () => {
    expect(
      parseSocketUrl(
        `/plugin-ws/selkies/stream?t=${TOKEN}&p=websockets&role=viewer&slot=2`,
      ),
    ).toEqual({
      token: TOKEN,
      path: "api/websockets?role=viewer&slot=2",
    });
    expect(parseSocketUrl(`/stream?t=${TOKEN}&p=webrtc/signaling`)?.path).toBe(
      "api/webrtc/signaling",
    );
  });

  it("refuses other paths and bad tokens", () => {
    expect(parseSocketUrl(`/stream?t=${TOKEN}&p=tokens`)).toBeNull();
    expect(parseSocketUrl(`/stream?t=short&p=websockets`)).toBeNull();
    expect(parseSocketUrl(undefined)).toBeNull();
  });
});

describe("socket proxy", () => {
  let selkies: Awaited<ReturnType<typeof fakeSelkies>>;
  let sessions: SessionStore;
  let server: http.Server;
  let base: string;
  const browserSockets = new Set<Duplex>();

  beforeEach(async () => {
    selkies = await fakeSelkies((_req, res) => {
      res.writeHead(204);
      res.end();
    });
    sessions = createSessionStore(async () => true);
    const proxy = createSocketProxy(sessions);
    server = http.createServer();
    server.on("upgrade", (req, socket: Duplex, head: Buffer) => {
      browserSockets.add(socket);
      socket.once("close", () => browserSockets.delete(socket));
      void proxy(req, bridgeSocket(socket), head);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    base = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/plugin-ws/selkies/stream`;
  });

  afterEach(async () => {
    sessions.clear();
    for (const socket of browserSockets) socket.destroy();
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await selkies.close();
  });

  function open(url: string): Promise<{ ws: WebSocket; first: string }> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { headers: { origin: "null" } });
      ws.once("message", (data) => resolve({ ws, first: data.toString() }));
      ws.once("error", reject);
      ws.once("unexpected-response", (_req, res) =>
        reject(new Error(`status ${res.statusCode}`)),
      );
    });
  }

  it("relays authenticated traffic and closes the browser through the bridge", async () => {
    const session = sessions.mint({
      userId: "u1",
      hostId: 1,
      upstream: localUpstream(selkies.port, "/desk/"),
    });
    const { ws, first } = await open(
      `${base}?t=${session.token}&p=websockets&role=viewer`,
    );
    expect(first).toBe("MODE websockets");
    const echoed = new Promise<Buffer>((resolve) =>
      ws.once("message", (data) => resolve(data as Buffer)),
    );
    ws.send(Buffer.from([0x02, 1, 2, 3]));
    expect([...(await echoed)]).toEqual([0x02, 1, 2, 3]);

    const seen = selkies.upgrades[0];
    expect(seen.url).toBe("/desk/api/websockets?role=viewer");
    expect(seen.headers.authorization).toBe("Basic YWJjOnNlY3JldA==");
    expect(seen.headers.origin).toBe(`http://127.0.0.1:${selkies.port}`);
    expect(seen.headers.host).toBe(`127.0.0.1:${selkies.port}`);
    expect(seen.headers["sec-websocket-extensions"]).toBeUndefined();

    const closed = new Promise<void>((resolve) =>
      ws.once("close", () => resolve()),
    );
    sessions.close(session.token, "u1");
    await closed;
  });

  it("refuses an unknown session", async () => {
    await expect(open(`${base}?t=${TOKEN}&p=websockets`)).rejects.toThrow(
      /404/,
    );
    expect(selkies.upgrades).toHaveLength(0);
  });

  it("reports a refused container login", async () => {
    const session = sessions.mint({
      userId: "u1",
      hostId: 1,
      upstream: localUpstream(selkies.port, "/", "Basic d3Jvbmc="),
    });
    await expect(open(`${base}?t=${session.token}`)).rejects.toThrow(/401/);
  });
});
