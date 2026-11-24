import http, { type IncomingMessage, type ServerResponse } from "node:http";
import net, { type AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import type { Upstream } from "../../src/backend/upstream.js";

export interface SeenRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/**
 * A stand-in Selkies container: answers HTTP with `handler` and echoes on its
 * /api/websockets socket, keeping what it saw.
 */
export async function fakeSelkies(
  handler: (req: IncomingMessage, res: ServerResponse, body: string) => void,
  streamPath?: string,
) {
  const seen: SeenRequest[] = [];
  const upgrades: SeenRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      seen.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body,
      });
      handler(req, res, body);
    });
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    upgrades.push({
      method: req.method ?? "",
      url: req.url ?? "",
      headers: req.headers,
      body: "",
    });
    if (streamPath && req.url !== streamPath) {
      socket.end("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    if (req.headers.authorization !== "Basic YWJjOnNlY3JldA==") {
      socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      ws.on("message", (data, binary) => ws.send(data, { binary }));
      ws.send("MODE websockets");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    seen,
    upgrades,
    close: () =>
      new Promise<void>((resolve) => {
        wss.close();
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/** An upstream to a local plain-HTTP port, like createDirectUpstream makes. */
export function localUpstream(
  port: number,
  path = "/",
  authorization: string | null = "Basic YWJjOnNlY3JldA==",
  token: string | null = null,
): Upstream & { closed: () => boolean } {
  let closed = false;
  return {
    scheme: "http",
    path,
    hostHeader: `127.0.0.1:${port}`,
    origin: `http://127.0.0.1:${port}`,
    authorization,
    token,
    connect: () =>
      new Promise((resolve, reject) => {
        const socket = net.connect({ host: "127.0.0.1", port });
        socket.once("connect", () => resolve(socket));
        socket.once("error", reject);
      }),
    close: () => {
      closed = true;
    },
    closed: () => closed,
  };
}
