import { PassThrough } from "node:stream";
import tls from "node:tls";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { afterEach, expect, it, vi } from "vitest";
import { createSshUpstream } from "../../src/backend/upstream.js";

afterEach(() => vi.restoreAllMocks());

it.each([
  {
    host: "desk.example.test",
    sni: "desk.example.test",
    san: "DNS:desk.example.test",
  },
  { host: "[::1]", sni: undefined, san: "IP Address:::1" },
])(
  "verifies $host over an SSH forward to loopback",
  async ({ host, sni, san }) => {
    const stream = new PassThrough();
    const secure = new PassThrough();
    const connect = vi.spyOn(tls, "connect").mockImplementation(() => {
      queueMicrotask(() => secure.emit("secureConnect"));
      return secure as unknown as tls.TLSSocket;
    });
    const forwardOut = vi.fn((_srcIp, _srcPort, _dstIp, _dstPort, callback) =>
      callback(undefined, stream),
    );
    const dispose = vi.fn();
    const ctx = {
      ssh: { connect: async () => ({ client: { forwardOut }, dispose }) },
    } as unknown as PluginContext;
    const upstream = await createSshUpstream(ctx, 1, {
      scheme: "https",
      host,
      port: 3001,
      path: "/",
      ignoreCert: false,
      username: "",
      password: "",
    });

    expect(await upstream.connect()).toBe(secure);
    expect(forwardOut).toHaveBeenCalledWith(
      "127.0.0.1",
      0,
      "127.0.0.1",
      3001,
      expect.any(Function),
    );
    expect(connect).toHaveBeenCalledWith(
      expect.objectContaining({
        socket: stream,
        servername: sni,
        rejectUnauthorized: true,
      }),
    );
    const options = connect.mock
      .calls[0][0] as unknown as tls.ConnectionOptions;
    const check = options.checkServerIdentity!;
    expect(
      check("localhost", { subjectaltname: san } as tls.PeerCertificate),
    ).toBeUndefined();
    expect(
      check("localhost", {
        subjectaltname: "DNS:localhost",
      } as tls.PeerCertificate),
    ).toBeInstanceOf(Error);
    upstream.close();
    expect(dispose).toHaveBeenCalledOnce();
  },
);
