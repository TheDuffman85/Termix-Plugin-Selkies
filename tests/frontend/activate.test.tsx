import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import {
  renderWithApp,
  type RenderedPluginApp,
} from "@termix-ssh/plugin-sdk/testing";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import * as plugin from "../../src/frontend/index";
import manifestJson from "../../manifest.json";
import locales from "../../locales/en.json";

// The test app has no shell, like the mobile app. Termix's web frames always
// have one, so the tests stand one in unless they test the mobile app.
const shell = vi.hoisted(() => ({ present: true }));
vi.mock("@termix-ssh/plugin-sdk/frontend", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@termix-ssh/plugin-sdk/frontend")>();
  return {
    ...actual,
    useShell: () => (shell.present ? ({} as never) : null),
  };
});

const manifest = manifestJson as unknown as PluginManifest;
const TOKEN = "k".repeat(43);

const host = {
  id: "7",
  name: "desk",
  ip: "10.0.0.7",
  port: 22,
  pluginSettings: { selkies: { enableSelkies: true } },
};

let rendered: RenderedPluginApp | null = null;

afterEach(async () => {
  await rendered?.deactivate();
  rendered = null;
  shell.present = true;
});

describe(`${manifest.id} frontend`, () => {
  it("registers the tab, protocol, connect action and host editor section", async () => {
    rendered = await renderWithApp(plugin, { manifest, locales });
    expect(rendered.registered.tabs()).toEqual(["selkies"]);
    expect(rendered.registered.hostProtocols()).toEqual(["selkies"]);
    expect(rendered.registered.hostEditorSections()).toEqual(["selkies"]);
    expect(rendered.registered.hostActions()).toEqual([
      expect.objectContaining({ id: "selkies", tabType: "selkies" }),
    ]);
  });

  it("offers the desktop tab in the mobile app, opened from a host", () => {
    const raw = manifestJson as {
      contributes: {
        mobile?: { mode: string; views?: string[] };
        tabs: Array<{ id: string; openFrom?: string[] }>;
      };
    };
    expect(raw.contributes.mobile).toMatchObject({
      mode: "webview",
      views: ["selkies"],
    });
    const tab = raw.contributes.tabs.find((entry) => entry.id === "selkies");
    expect(tab?.openFrom).toContain("host-context-menu");
  });

  it("offers connect only on hosts with Selkies on", async () => {
    rendered = await renderWithApp(plugin, { manifest, locales });
    expect(rendered.registered.hostActionsFor(host)).toHaveLength(1);
    expect(
      rendered.registered.hostActionsFor({ ...host, pluginSettings: {} }),
    ).toHaveLength(0);
  });

  it("opens the desktop through Termix after launching", async () => {
    const post = vi.fn(async (url: string) => {
      if (url === "/launch/7") {
        return { data: { token: TOKEN, directUrl: "https://10.0.0.7:3001/" } };
      }
      return { data: { closed: true } };
    });
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: { post } as never,
    });
    rendered.renderTab("selkies", { host, isVisible: true });
    const frame = (await screen.findByTitle(
      locales.tab.title,
    )) as HTMLIFrameElement;
    expect(frame.src).toBe(
      `${location.protocol}//${location.host}/plugin-api/selkies/s/${TOKEN}/`,
    );
    expect(frame.getAttribute("allow")).toContain("autoplay");
    expect(screen.getByText(locales.tab.openInBrowser)).toBeTruthy();
    expect(post).toHaveBeenCalledWith("/launch/7", {});
  });

  it("leaves Open in browser out when the host has it off", async () => {
    const post = vi.fn(async (url: string) =>
      url === "/launch/7"
        ? { data: { token: TOKEN, directUrl: null } }
        : { data: { closed: true } },
    );
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: { post } as never,
    });
    rendered.renderTab("selkies", { host, isVisible: true });
    await screen.findByTitle(locales.tab.title);
    expect(screen.getByText(locales.tab.reconnect)).toBeTruthy();
    expect(screen.queryByText(locales.tab.openInBrowser)).toBeNull();
    expect(screen.queryByText(locales.tab.browserHint)).toBeNull();
  });

  it("hands the desktop to the phone's browser in the mobile app", async () => {
    shell.present = false;
    const post = vi.fn(async (url: string) =>
      url === "/launch/7"
        ? { data: { token: TOKEN, directUrl: null } }
        : { data: { closed: true } },
    );
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: { post } as never,
    });
    rendered.renderTab("selkies", { host, isVisible: true });
    const link = (await screen.findByText(
      locales.tab.app.open,
    )) as HTMLAnchorElement;
    expect(link.tagName).toBe("A");
    expect(link.href).toBe(
      `${location.protocol}//${location.host}/plugin-api/selkies/s/${TOKEN}/`,
    );
    expect(screen.queryByTitle(locales.tab.title)).toBeNull();
    expect(screen.queryByText(locales.tab.openInBrowser)).toBeNull();
  });

  it("explains why a desktop could not open, and retries", async () => {
    const post = vi
      .fn()
      .mockRejectedValueOnce({
        response: {
          status: 409,
          data: { code: "unauthorized", error: "refused" },
        },
      })
      .mockResolvedValue({ data: { token: TOKEN, directUrl: "https://x/" } });
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: { post } as never,
    });
    rendered.renderTab("selkies", { host, isVisible: true });
    expect(
      await screen.findByText(locales.tab.errors.unauthorized),
    ).toBeTruthy();
    fireEvent.click(screen.getByText(locales.tab.reconnect));
    await waitFor(() =>
      expect(screen.getByTitle(locales.tab.title)).toBeTruthy(),
    );
  });

  it("shows the Docker startup explanation and host key instructions", async () => {
    const explanation =
      "Docker startup is blocked because this host's SSH key is not trusted yet. Open a normal SSH terminal for this same host entry in Termix, verify its fingerprint and trust the key, then reconnect to Selkies.";
    const post = vi.fn().mockRejectedValue({
      response: {
        status: 502,
        data: { code: "container-ssh-unverified", error: explanation },
      },
    });
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: { post } as never,
    });
    rendered.renderTab("selkies", { host, isVisible: true });
    expect(await screen.findByText(explanation)).toBeTruthy();
    expect(screen.queryByText(locales.tab.errors.unreachable)).toBeNull();
    expect(screen.getByText(locales.tab.reconnect)).toBeTruthy();
  });

  it("draws the host editor section and writes settings to the form", async () => {
    rendered = await renderWithApp(plugin, { manifest, locales });
    let form: Record<string, unknown> = {};
    const updateForm = vi.fn(
      (patch: (f: Record<string, unknown>) => Record<string, unknown>) => {
        form = { ...form, ...patch(form) };
      },
    );
    rendered.renderHostEditorSection("selkies", {
      form,
      setField: vi.fn(),
      updateForm,
      protocols: { enableSelkies: true },
      advanced: true,
    });
    fireEvent.change(screen.getByPlaceholderText("3001"), {
      target: { value: "8443" },
    });
    fireEvent.change(screen.getByPlaceholderText("abc"), {
      target: { value: "me" },
    });
    expect(form).toEqual({
      pluginSettings: { selkies: { selkiesPort: 8443 } },
      protocolAuth: {
        selkies: {
          authType: "direct",
          credentialId: "",
          username: "me",
          password: "",
          fields: {},
        },
      },
    });
  });

  it("offers Docker management as an optional per-host setting", async () => {
    rendered = await renderWithApp(plugin, { manifest, locales });
    let form: Record<string, unknown> = {
      pluginSettings: { selkies: { selkiesManageContainer: true } },
    };
    rendered.renderHostEditorSection("selkies", {
      form,
      setField: vi.fn(),
      updateForm: (
        patch: (f: Record<string, unknown>) => Record<string, unknown>,
      ) => {
        form = { ...form, ...patch(form) };
      },
      protocols: { enableSelkies: true },
      advanced: false,
    });
    fireEvent.change(screen.getByLabelText(locales.hosts.containerName), {
      target: { value: "my-webtop" },
    });
    fireEvent.change(screen.getByLabelText(locales.hosts.idleMinutes), {
      target: { value: "20" },
    });
    expect(form.pluginSettings).toEqual({
      selkies: {
        selkiesManageContainer: true,
        selkiesContainerName: "my-webtop",
        selkiesIdleMinutes: 20,
      },
    });
  });

  it("saves only whole numbers in range from the number fields", async () => {
    rendered = await renderWithApp(plugin, { manifest, locales });
    let form: Record<string, unknown> = {
      pluginSettings: {
        selkies: { selkiesPort: 3001, selkiesManageContainer: true },
      },
    };
    rendered.renderHostEditorSection("selkies", {
      form,
      setField: vi.fn(),
      updateForm: (
        patch: (f: Record<string, unknown>) => Record<string, unknown>,
      ) => {
        form = { ...form, ...patch(form) };
      },
      protocols: { enableSelkies: true },
      advanced: true,
    });
    const port = screen.getByLabelText(locales.hosts.port) as HTMLInputElement;
    const idle = screen.getByLabelText(
      locales.hosts.idleMinutes,
    ) as HTMLInputElement;
    for (const value of ["", "0", "70000", "1.5"]) {
      fireEvent.change(port, { target: { value } });
    }
    for (const value of ["", "0", "1441"]) {
      fireEvent.change(idle, { target: { value } });
    }
    expect(form.pluginSettings).toEqual({
      selkies: { selkiesPort: 3001, selkiesManageContainer: true },
    });
    // Leaving the field shows the saved number again.
    fireEvent.blur(port);
    expect(port.value).toBe("3001");
  });

  it("notes that Test connection uses the saved settings", async () => {
    rendered = await renderWithApp(plugin, { manifest, locales });
    const props = {
      setField: vi.fn(),
      updateForm: vi.fn(),
      protocols: { enableSelkies: true },
      advanced: true,
    };
    const saved = { selkies: { enableSelkies: true, selkiesPort: 3001 } };
    rendered.renderHostEditorSection("selkies", {
      ...props,
      host: { ...host, pluginSettings: saved } as never,
      form: { pluginSettings: saved },
    });
    expect(screen.queryByText(locales.hosts.testUnsaved)).toBeNull();
    await rendered.deactivate();
    rendered = await renderWithApp(plugin, { manifest, locales });
    rendered.renderHostEditorSection("selkies", {
      ...props,
      host: { ...host, pluginSettings: saved } as never,
      form: {
        pluginSettings: { selkies: { enableSelkies: true, selkiesPort: 3000 } },
      },
    });
    expect(screen.getByText(locales.hosts.testUnsaved)).toBeTruthy();
  });

  it("shows a full server as its own error", async () => {
    const post = vi.fn().mockRejectedValue({
      response: {
        status: 503,
        data: { code: "too-many-sessions", error: "full" },
      },
    });
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: { post } as never,
    });
    rendered.renderTab("selkies", { host, isVisible: true });
    expect(
      await screen.findByText(locales.tab.errors.tooManySessions),
    ).toBeTruthy();
  });

  it("shows a disconnect as a disconnect, not an error", async () => {
    const post = vi.fn(async (url: string) =>
      url === "/launch/7"
        ? { data: { token: TOKEN, directUrl: null } }
        : { data: { closed: true } },
    );
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: { post } as never,
    });
    const handle: { current: { disconnect: () => void } | null } = {
      current: null,
    };
    rendered.renderTab("selkies", {
      host,
      isVisible: true,
      handleRef: handle,
    } as never);
    await screen.findByTitle(locales.tab.title);
    act(() => handle.current!.disconnect());
    expect(await screen.findByText(locales.tab.disconnected)).toBeTruthy();
    expect(screen.queryByText(locales.tab.errors.generic)).toBeNull();
    expect(post).toHaveBeenCalledWith(`/sessions/${TOKEN}/close`, {});
  });
});
