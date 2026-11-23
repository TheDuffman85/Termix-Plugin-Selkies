import net from "node:net";
import tls from "node:tls";
import type { Duplex } from "node:stream";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { resolveTarget } from "@termix-ssh/plugin-sdk/net-guard";
import { hostPort, type SelkiesScheme } from "./host-settings.js";

/** Where a session's requests go, and how to open a connection there. */
export interface Upstream {
  scheme: SelkiesScheme;
  /** The container's SUBFOLDER, "/" or "/name/". */
  path: string;
  /** Host header the container sees, "host:port". */
  hostHeader: string;
  /** The container's own origin, for the Origin header of its socket. */
  origin: string;
  /** "Basic ..." for the container's login, or null when it has none. */
  authorization: string | null;
  /** A new connection, TLS already set up for https. */
  connect: () => Promise<Duplex>;
  close: () => void;
}

export interface UpstreamTarget {
  scheme: SelkiesScheme;
  host: string;
  port: number;
  path: string;
  ignoreCert: boolean;
  username: string;
  password: string;
}

const CONNECT_TIMEOUT_MS = 15_000;

/** The Basic login linuxserver's nginx asks for, or null without a password. */
export function basicAuthorization(
  username: string,
  password: string,
): string | null {
  if (!password) return null;
  const user = username || "abc";
  return `Basic ${Buffer.from(`${user}:${password}`, "utf8").toString("base64")}`;
}

function wrapTls(
  socket: Duplex | null,
  options: { host?: string; port?: number; identity: string },
  ignoreCert: boolean,
): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    const secure = tls.connect({
      ...(socket ? { socket } : { host: options.host, port: options.port }),
      servername: net.isIP(options.identity) ? undefined : options.identity,
      checkServerIdentity: (_host, cert) =>
        tls.checkServerIdentity(options.identity, cert),
      rejectUnauthorized: !ignoreCert,
      ALPNProtocols: ["http/1.1"],
    });
    const timer = setTimeout(() => {
      secure.destroy(new Error("TLS handshake timed out"));
    }, CONNECT_TIMEOUT_MS);
    secure.once("secureConnect", () => {
      clearTimeout(timer);
      secure.setNoDelay?.(true);
      resolve(secure);
    });
    secure.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function common(target: UpstreamTarget) {
  const authority = hostPort(target.host, target.port);
  return {
    scheme: target.scheme,
    path: target.path,
    hostHeader: authority,
    origin: `${target.scheme}://${authority}`,
    authorization: basicAuthorization(target.username, target.password),
  };
}

/**
 * The container reached straight from the Termix server. The host's saved
 * address may be private (that is the point), so it is allowed by name; the
 * name is looked up once and every connection goes to that checked address.
 */
export async function createDirectUpstream(
  target: UpstreamTarget,
): Promise<Upstream> {
  const bare = target.host.replace(/^\[|\]$/g, "");
  const { address } = await resolveTarget(bare, {
    allowPrivateHosts: [bare, target.host],
  });
  return {
    ...common(target),
    connect: async () => {
      if (target.scheme === "https") {
        return wrapTls(
          null,
          { host: address, port: target.port, identity: bare },
          target.ignoreCert,
        );
      }
      return new Promise<Duplex>((resolve, reject) => {
        const socket = net.connect({ host: address, port: target.port });
        socket.setTimeout(CONNECT_TIMEOUT_MS, () =>
          socket.destroy(new Error("Connection timed out")),
        );
        socket.once("connect", () => {
          socket.setTimeout(0);
          socket.setNoDelay(true);
          resolve(socket);
        });
        socket.once("error", reject);
      });
    },
    close: () => undefined,
  };
}

interface ForwardingClient {
  forwardOut: (
    srcIP: string,
    srcPort: number,
    dstIP: string,
    dstPort: number,
    callback: (error: Error | undefined, stream: Duplex) => void,
  ) => void;
}

/**
 * The container reached through the host's own SSH connection, at
 * 127.0.0.1:<port> as the host sees it. One connection serves the whole
 * session and is closed with it.
 */
export async function createSshUpstream(
  ctx: PluginContext,
  hostId: number,
  target: UpstreamTarget,
): Promise<Upstream> {
  const connection = await ctx.ssh.connect<ForwardingClient>(hostId, {
    purpose: "selkies",
    profile: "forward",
  });
  let closed = false;
  const identity = target.host.replace(/^\[|\]$/g, "");
  const loopback: UpstreamTarget = { ...target, host: "127.0.0.1" };
  return {
    ...common(loopback),
    connect: () =>
      new Promise<Duplex>((resolve, reject) => {
        if (closed) {
          reject(new Error("The SSH connection is closed"));
          return;
        }
        connection.client.forwardOut(
          "127.0.0.1",
          0,
          "127.0.0.1",
          target.port,
          (error, stream) => {
            if (error || !stream) {
              reject(error ?? new Error("SSH forward failed"));
              return;
            }
            if (target.scheme !== "https") {
              resolve(stream);
              return;
            }
            wrapTls(stream, { identity }, target.ignoreCert).then(
              resolve,
              (failure) => {
                stream.destroy();
                reject(failure);
              },
            );
          },
        );
      }),
    close: () => {
      if (closed) return;
      closed = true;
      try {
        connection.dispose();
      } catch {
        // Already gone.
      }
    },
  };
}
