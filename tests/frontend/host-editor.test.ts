import { describe, expect, it } from "vitest";
import {
  hasUnsavedSettings,
  patchLogin,
  patchLoginField,
  patchSetting,
  readForm,
} from "../../src/frontend/HostEditorSelkiesSection";

describe("host editor login", () => {
  it("sets the access token beside the username and password", () => {
    let form: Record<string, unknown> = {};
    form = { ...form, ...patchLogin(form, "username", "ubuntu") };
    form = { ...form, ...patchLoginField(form, "token", "t0k") };
    form = { ...form, ...patchLogin(form, "password", "mypasswd") };
    expect(readForm(form).login).toMatchObject({
      username: "ubuntu",
      password: "mypasswd",
      fields: { token: "t0k" },
    });
  });
});

describe("host editor automatic startup", () => {
  it("reads the managed kind and service, defaulting to Docker", () => {
    expect(readForm({})).toMatchObject({
      manageType: "docker",
      serviceName: "",
    });
    let form: Record<string, unknown> = {};
    form = {
      ...form,
      ...patchSetting(form, "selkiesManageType", "systemd-user"),
    };
    form = { ...form, ...patchSetting(form, "selkiesServiceName", "selkies") };
    expect(readForm(form)).toMatchObject({
      manageType: "systemd-user",
      serviceName: "selkies",
    });
    expect(
      hasUnsavedSettings(form, {
        pluginSettings: { selkies: { selkiesManageType: "systemd-user" } },
      }),
    ).toBe(true);
  });
});
