import { describe, expect, it } from "vitest";
import {
  patchLogin,
  patchLoginField,
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
