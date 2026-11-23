import { describe, expect, it } from "vitest";
import {
  asPort,
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
    });
  });

  it("keeps a port in range", () => {
    expect(asPort(0)).toBe(3001);
    expect(asPort(70000)).toBe(3001);
    expect(asPort(1.5)).toBe(3001);
    expect(asPort(443)).toBe(443);
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
