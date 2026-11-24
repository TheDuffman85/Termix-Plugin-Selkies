import { describe, expect, it } from "vitest";
import {
  asPort,
  containerName,
  idleMinutes,
  manageKind,
  managedTarget,
  serviceName,
  directUrl,
  hostPort,
  normalizePath,
  normalizePublicUrl,
  parseHostSettings,
} from "../../src/backend/host-settings.js";
import { basicAuthorization } from "../../src/backend/upstream.js";

describe("host settings", () => {
  it("fills in defaults for an empty host", () => {
    expect(parseHostSettings({})).toEqual({
      enabled: false,
      port: 3001,
      scheme: "https",
      path: "/",
      route: "direct",
      ignoreCert: true,
      openInBrowser: false,
      publicUrl: "",
      manageContainer: false,
      manageKind: "docker",
      containerName: "",
      serviceName: "",
      idleMinutes: 10,
    });
  });

  it("reads every field", () => {
    expect(
      parseHostSettings({
        enableSelkies: true,
        selkiesPort: "3000",
        selkiesScheme: "http",
        selkiesPath: "desktop",
        selkiesRoute: "ssh",
        selkiesIgnoreCert: false,
        selkiesOpenInBrowser: true,
        selkiesPublicUrl: "https://desk.example.com/",
        selkiesManageContainer: true,
        selkiesManageType: "systemd-user",
        selkiesContainerName: "webtop",
        selkiesServiceName: "selkies@1.service",
        selkiesIdleMinutes: "15",
      }),
    ).toEqual({
      enabled: true,
      port: 3000,
      scheme: "http",
      path: "/desktop/",
      route: "ssh",
      ignoreCert: false,
      openInBrowser: true,
      publicUrl: "https://desk.example.com/",
      manageContainer: true,
      manageKind: "systemd-user",
      containerName: "webtop",
      serviceName: "selkies@1.service",
      idleMinutes: 15,
    });
  });

  it("keeps a port in range", () => {
    expect(asPort(0)).toBe(3001);
    expect(asPort(70000)).toBe(3001);
    expect(asPort(1.5)).toBe(3001);
    expect(asPort(443)).toBe(443);
  });

  it("accepts only container names/IDs, never shell syntax or options", () => {
    expect(containerName(" webtop-1.foo_bar ")).toBe("webtop-1.foo_bar");
    expect(containerName("ab123def")).toBe("ab123def");
    for (const value of [
      "",
      "--help",
      "a;b",
      "$(id)",
      "a'b",
      "a b",
      "a\nb",
      42,
    ]) {
      expect(containerName(value)).toBe("");
    }
  });

  it("accepts only systemd unit names, never shell syntax, paths or options", () => {
    expect(serviceName(" selkies.service ")).toBe("selkies.service");
    expect(serviceName("selkies@1:display.service")).toBe(
      "selkies@1:display.service",
    );
    for (const value of [
      "",
      "-selkies",
      "--now",
      "a;b",
      "$(id)",
      "a'b",
      "a b",
      "a\\x2d",
      "../etc/x",
      "/etc/x",
      "a\nb",
      42,
    ]) {
      expect(serviceName(value)).toBe("");
    }
  });

  it("manages Docker unless a systemd kind is chosen", () => {
    expect(manageKind(undefined)).toBe("docker");
    expect(manageKind("bogus")).toBe("docker");
    expect(manageKind("systemd-system")).toBe("systemd-system");
    expect(managedTarget(parseHostSettings({}))).toBeNull();
    expect(
      managedTarget(
        parseHostSettings({
          selkiesManageContainer: true,
          selkiesContainerName: "webtop",
          selkiesServiceName: "selkies",
        }),
      ),
    ).toEqual({ kind: "docker", name: "webtop" });
    expect(
      managedTarget(
        parseHostSettings({
          selkiesManageContainer: true,
          selkiesManageType: "systemd-system",
          selkiesContainerName: "webtop",
          selkiesServiceName: "selkies",
        }),
      ),
    ).toEqual({ kind: "systemd-system", name: "selkies" });
  });

  it("bounds the idle time to whole minutes between 1 and 1440", () => {
    expect(idleMinutes("30")).toBe(30);
    expect(idleMinutes(1)).toBe(1);
    expect(idleMinutes(1440)).toBe(1440);
    for (const value of [0, -1, 1.5, 1441, Infinity, NaN, "bad", null]) {
      expect(idleMinutes(value)).toBe(10);
    }
  });

  it("normalizes the subfolder and refuses anything odd", () => {
    expect(normalizePath("/")).toBe("/");
    expect(normalizePath("/a/b")).toBe("/a/b/");
    expect(normalizePath("//a//b//")).toBe("/a/b/");
    expect(normalizePath("/a/../b/")).toBe("/");
    expect(normalizePath("/a?x=1")).toBe("/");
    expect(normalizePath("/a b/")).toBe("/");
    expect(normalizePath(42)).toBe("/");
  });

  it("accepts only plain http(s) addresses for Open in browser", () => {
    expect(normalizePublicUrl("https://x.example/desk/")).toBe(
      "https://x.example/desk/",
    );
    expect(normalizePublicUrl("javascript:alert(1)")).toBe("");
    expect(normalizePublicUrl("https://u:p@x.example/")).toBe("");
    expect(normalizePublicUrl("not a url")).toBe("");
  });

  it("offers no direct address while Open in browser is off", () => {
    expect(directUrl(parseHostSettings({}), "10.0.0.5")).toBeNull();
    expect(
      directUrl(
        parseHostSettings({ selkiesPublicUrl: "https://desk.example/" }),
        "10.0.0.5",
      ),
    ).toBeNull();
  });

  it("builds the direct address", () => {
    const settings = parseHostSettings({
      selkiesPath: "/d/",
      selkiesOpenInBrowser: true,
    });
    expect(directUrl(settings, "10.0.0.5")).toBe("https://10.0.0.5:3001/d/");
    expect(directUrl(settings, "fd00::5")).toBe("https://[fd00::5]:3001/d/");
    expect(
      directUrl(
        { ...settings, publicUrl: "https://desk.example/" },
        "10.0.0.5",
      ),
    ).toBe("https://desk.example/");
    expect(hostPort("[::1]", 80)).toBe("[::1]:80");
  });

  it("makes the Basic login only when there is a password", () => {
    expect(basicAuthorization("abc", "")).toBeNull();
    expect(basicAuthorization("", "secret")).toBe("Basic YWJjOnNlY3JldA==");
    expect(basicAuthorization("me", "pw")).toBe(
      `Basic ${Buffer.from("me:pw").toString("base64")}`,
    );
  });
});
