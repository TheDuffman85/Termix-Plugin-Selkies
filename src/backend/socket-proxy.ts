import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { upstreamRequest } from "./proxy.js";
import { isToken, type SessionStore } from "./sessions.js";
import { withSessionToken } from "./upstream.js";

/** Sockets the Selkies client opens below its api/ route. */
const SOCKET_PATHS = new Set(["websockets", "webrtc/signaling"]);

/** How long the container may take to answer the upgrade. */
export const HANDSHAKE_TIMEOUT_MS = 30_000;

/** Handshake headers passed on; extensions are left out so frames stay plain. */
const PASS_HANDSHAKE = [
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-protocol",
  "user-agent",
];
const PASS_ANSWER = [
  "upgrade",
  "connection",
  "sec-websocket-accept",
  "sec-websocket-protocol",
];

export interface SocketTarget {
  token: string;
  /** The container path, like "api/websockets?role=viewer". */
  path: string;
}

/**
 * Reads /plugin-ws/selkies/stream?t=<token>&p=<api path>&<the client's own
 * query>, as the shim writes it. Null for anything else.
 */
export function parseSocketUrl(url: string | undefined): SocketTarget | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url, "http://localhost");
  } catch {
    return null;
  }
  const token = parsed.searchParams.get("t");
  const sub = parsed.searchParams.get("p") ?? "websockets";
  if (!isToken(token) || !SOCKET_PATHS.has(sub)) return null;
  const rest = new URLSearchParams();
  parsed.searchParams.forEach((value, key) => {
    if (key !== "t" && key !== "p") rest.append(key, value);
  });
  const search = rest.toString();
  return { token, path: `api/${sub}${search ? `?${search}` : ""}` };
}

function refuse(socket: Duplex, status: number, reason: string): void {
  if (socket.destroyed || socket.writableEnded) return;
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
}

/**
 * The public stream socket. The session token in the query is the only
 * credential, as for the page. The container's own handshake answer is
 * relayed, then bytes flow both ways untouched.
 */
export function createSocketProxy(
  sessions: SessionStore,
  handshakeTimeoutMs = HANDSHAKE_TIMEOUT_MS,
) {
  return async (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on("error", () => socket.destroy());
    socket.once("finish", () => socket.destroy());
    const target = parseSocketUrl(request.url);
    const session = target ? await sessions.use(target.token, true) : null;
    if (socket.destroyed) return;
    const release = session && sessions.track(session);
    if (!target || !session || !release) {
      refuse(socket, 404, "Not Found");
      return;
    }
    // The Termix stream bridge forwards end and error, but a plain destroy
    // only closes the plugin's side. An error aborts without waiting on writes.
    const stop = () =>
      socket.destroy(new Error("The Selkies session has ended"));
    session.signal.addEventListener("abort", stop, { once: true });
    socket.once("close", () => {
      session.signal.removeEventListener("abort", stop);
      release();
    });
    const upstream = session.upstream;
    const headers: Record<string, string> = {
      host: upstream.hostHeader,
      origin: upstream.origin,
      connection: "Upgrade",
      upgrade: "websocket",
      "x-forwarded-proto": upstream.scheme,
    };
    for (const name of PASS_HANDSHAKE) {
      const value = request.headers[name];
      if (typeof value === "string") headers[name] = value;
    }
    if (upstream.authorization) headers.authorization = upstream.authorization;

    const outgoing = upstreamRequest(upstream, {
      method: "GET",
      path: upstream.path + withSessionToken(target.path, upstream.token),
      headers,
    });
    let settled = false;
    // A container that accepts the connection but never answers the upgrade
    // would otherwise hold the browser's socket open indefinitely.
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      outgoing.destroy();
      refuse(socket, 504, "Gateway Timeout");
    }, handshakeTimeoutMs);
    timer.unref?.();
    const settle = (): boolean => {
      if (settled) return false;
      settled = true;
      clearTimeout(timer);
      return true;
    };
    socket.once("close", () => {
      if (settle()) outgoing.destroy();
    });

    outgoing.on(
      "upgrade",
      (answer: IncomingMessage, remote: Duplex, remoteHead: Buffer) => {
        if (!settle() || socket.destroyed) {
          remote.destroy();
          return;
        }
        const lines = ["HTTP/1.1 101 Switching Protocols"];
        for (const name of PASS_ANSWER) {
          const value = answer.headers[name];
          if (typeof value === "string") lines.push(`${name}: ${value}`);
        }
        socket.write(`${lines.join("\r\n")}\r\n\r\n`);
        if (remoteHead.length) socket.write(remoteHead);
        if (head.length) remote.write(head);
        (
          socket as Duplex & { setNoDelay?: (on: boolean) => void }
        ).setNoDelay?.(true);
        remote.on("error", (error) => socket.destroy(error));
        remote.once("close", () => {
          if (!socket.destroyed && !socket.writableEnded) socket.end();
        });
        socket.once("close", () => remote.destroy());
        remote.pipe(socket);
        socket.pipe(remote);
      },
    );

    outgoing.on("response", (answer: IncomingMessage) => {
      answer.destroy();
      if (!settle()) return;
      const status = answer.statusCode ?? 502;
      refuse(
        socket,
        status === 401 ? 401 : 502,
        status === 401 ? "Unauthorized" : "Bad Gateway",
      );
    });

    outgoing.on("error", () => {
      if (!settle()) return;
      refuse(socket, 502, "Bad Gateway");
    });

    outgoing.end();
  };
}
