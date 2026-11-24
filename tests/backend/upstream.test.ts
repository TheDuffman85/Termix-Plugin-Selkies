import { PassThrough } from "node:stream";
import tls from "node:tls";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { afterEach, expect, it, vi } from "vitest";
import {
  createSshUpstream,
  sessionToken,
  stripSessionToken,
  withSessionToken,
} from "../../src/backend/upstream.js";

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
      token: "",
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

it("adds the session token to api/ paths only, replacing the client's", () => {
  expect(withSessionToken("api/websockets", "t0k")).toBe(
    "api/websockets?token=t0k",
  );
  expect(withSessionToken("api/files/a?x=%20&token=mine&y", "a+b")).toBe(
    "api/files/a?x=%20&y&token=a%2Bb",
  );
  expect(withSessionToken("index.html?token=mine", "t0k")).toBe(
    "index.html?token=mine",
  );
  expect(withSessionToken("api/websockets?token=mine", null)).toBe(
    "api/websockets?token=mine",
  );
});

it("keeps the session token out of addresses the browser sees", () => {
  expect(stripSessionToken("?a=1&token=t0k&b")).toBe("?a=1&b");
  expect(stripSessionToken("?token=t0k")).toBe("");
  expect(stripSessionToken("")).toBe("");
});

it("accepts only printable tokens without spaces", () => {
  expect(sessionToken("  abc-123_XYZ  ")).toBe("abc-123_XYZ");
  expect(sessionToken("")).toBeNull();
  expect(sessionToken("has space")).toBeNull();
  expect(sessionToken("line\nbreak")).toBeNull();
  expect(sessionToken(undefined)).toBeNull();
});
