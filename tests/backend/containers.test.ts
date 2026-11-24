import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
  type MockInstance,
} from "vitest";
import { createMockCtx } from "@termix-ssh/plugin-sdk/testing";
import {
  AWAKE_REASON,
  createContainerManager,
} from "../../src/backend/containers.js";
import { parseHostSettings } from "../../src/backend/host-settings.js";

const values = {
  enableSelkies: true,
  selkiesManageContainer: true,
  selkiesContainerName: "webtop",
  selkiesIdleMinutes: 1,
};
const settings = parseHostSettings(values);
const success = {
  stdout: "webtop",
  stderr: "",
  code: 0,
  timedOut: false,
  truncated: false,
};

let time: number;
let mock: ReturnType<typeof createMockCtx>;
let manager: ReturnType<typeof createContainerManager>;
let exec: MockInstance<typeof mock.ctx.ssh.exec>;
let closeHost: Mock<(hostId: number) => void>;

beforeEach(async () => {
  time = 0;
  mock = createMockCtx({
    pluginId: "selkies",
    permissions: ["selkies.connect"],
    capabilities: ["users:impersonate", "kv:own"],
  });
  for (const [key, value] of Object.entries(values)) {
    await mock.ctx.settings.setHost(1, key, value);
  }
  closeHost = vi.fn();
  manager = createContainerManager(mock.ctx, closeHost, () => time);
  exec = vi.spyOn(mock.ctx.ssh, "exec").mockResolvedValue(success);
});

describe("Docker lifecycle", () => {
  it("does nothing when management is off", async () => {
    const release = await manager.acquire(1, "user-1", parseHostSettings({}));
    release();
    time = 600_000;
    await manager.sweep();
    expect(exec).not.toHaveBeenCalled();
  });

  it("starts over SSH and stops only after the last connection is idle", async () => {
    const preparing = await manager.acquire(1, "user-1", settings);
    expect(exec).toHaveBeenCalledWith(
      1,
      "docker container start 'webtop'",
      expect.anything(),
    );
    const first = manager.track(1)!;
    const second = manager.track(1)!;
    preparing();
    time = 120_000;
    first();
    await manager.sweep();
    expect(exec).toHaveBeenCalledTimes(1);
    second();
    time += 59_999;
    await manager.sweep();
    expect(exec).toHaveBeenCalledTimes(1);
    time++;
    await manager.sweep();
    expect(exec).toHaveBeenLastCalledWith(
      1,
      "docker container stop --time 30 'webtop'",
      expect.anything(),
    );
    expect(closeHost).toHaveBeenCalledWith(1);
    expect(mock.audits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "selkies_container_start",
          success: true,
        }),
        expect.objectContaining({
          action: "selkies_container_stop",
          success: true,
        }),
      ]),
    );
  });

  it("resets idle time when a desktop reconnects", async () => {
    (await manager.acquire(1, "user-1", settings))();
    time = 59_000;
    const release = manager.track(1)!;
    time = 120_000;
    release();
    release(); // Cleanup is idempotent.
    time += 59_000;
    await manager.sweep();
    expect(exec).toHaveBeenCalledTimes(1);
    time += 1000;
    await manager.sweep();
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it("shares concurrent starts and protects containers while they boot", async () => {
    let finish!: (value: typeof success) => void;
    exec.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const first = manager.acquire(1, "user-1", settings);
    const second = manager.acquire(1, "user-2", settings);
    await vi.waitFor(() => expect(exec).toHaveBeenCalledTimes(1));
    time = 600_000;
    await manager.sweep();
    expect(exec).toHaveBeenCalledTimes(1);
    finish(success);
    (await first)();
    (await second)();
  });

  it("waits for a stop already in progress before restarting", async () => {
    (await manager.acquire(1, "user-1", settings))();
    let finish!: (value: typeof success) => void;
    exec.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    time = 60_000;
    const stopping = manager.sweep();
    await vi.waitFor(() => expect(exec).toHaveBeenCalledTimes(2));
    expect(manager.track(1)).toBeNull();
    const reopening = manager.acquire(1, "user-2", settings);
    expect(exec).toHaveBeenCalledTimes(2);
    finish(success);
    await stopping;
    const release = await reopening;
    expect(exec).toHaveBeenCalledTimes(3);
    expect(exec).toHaveBeenLastCalledWith(
      1,
      "docker container start 'webtop'",
      expect.anything(),
    );
    release();
    time += 60_000;
    await manager.sweep();
    expect(exec).toHaveBeenCalledTimes(4);
  });

  it("does not execute invalid container names", async () => {
    for (const name of ["", "-a", "webtop;id", "webtop'", "$(id)"]) {
      await expect(
        manager.acquire(1, "user-1", { ...settings, containerName: name }),
      ).rejects.toThrow();
    }
    expect(exec).not.toHaveBeenCalled();
  });

  it("reports Docker start failures and allows a retry", async () => {
    exec.mockResolvedValueOnce({
      ...success,
      code: 1,
      stderr: "permission denied",
    });
    await expect(manager.acquire(1, "user-1", settings)).rejects.toThrow(
      "permission denied",
    );
    (await manager.acquire(1, "user-1", settings))();
    time = 60_000;
    await manager.sweep();
    expect(exec).toHaveBeenCalledTimes(3);
  });

  it("keeps the previous user in charge after another user's start fails", async () => {
    (await manager.acquire(1, "alice", settings))();
    exec.mockResolvedValueOnce({
      ...success,
      code: 1,
      stderr: "permission denied",
    });
    await expect(manager.acquire(1, "bob", settings)).rejects.toThrow(
      "permission denied",
    );
    expect(await mock.ctx.kv.get("container:1")).toMatchObject({
      userId: "alice",
    });
    const actors: Array<string | undefined> = [];
    vi.spyOn(mock.ctx.rbac, "has").mockImplementation(async () => {
      actors.push(mock.ctx.currentActor());
      return true;
    });
    time = 60_000;
    await manager.sweep();
    expect(actors).toEqual(["alice"]);
    expect(exec).toHaveBeenLastCalledWith(
      1,
      "docker container stop --time 30 'webtop'",
      expect.anything(),
    );
  });

  it("hands idle shutdown to a user only once their own start succeeds", async () => {
    let finishStart!: (value: typeof success) => void;
    exec.mockImplementationOnce(
      () => new Promise((resolve) => (finishStart = resolve)),
    );
    const alice = manager.acquire(1, "alice", settings);
    await vi.waitFor(() => expect(exec).toHaveBeenCalledTimes(1));
    // Bob joins Alice's start: that says nothing about Bob's own access.
    const bob = manager.acquire(1, "bob", settings);
    finishStart(success);
    (await alice)();
    (await bob)();
    expect(exec).toHaveBeenCalledTimes(1);
    expect(await mock.ctx.kv.get("container:1")).toMatchObject({
      userId: "alice",
    });
    // Bob's own start succeeds: Bob is now in charge.
    (await manager.acquire(1, "bob", settings))();
    expect(await mock.ctx.kv.get("container:1")).toMatchObject({
      userId: "bob",
    });
  });

  it("retries failed stops without losing management", async () => {
    (await manager.acquire(1, "user-1", settings))();
    exec.mockResolvedValueOnce({ ...success, code: null, timedOut: true });
    time = 60_000;
    await manager.sweep();
    expect(exec).toHaveBeenCalledTimes(2);
    await manager.sweep();
    expect(exec).toHaveBeenCalledTimes(2);
    time += 60_000;
    await manager.sweep();
    expect(exec).toHaveBeenCalledTimes(3);
  });

  it("retries after the idle interval when the user can't be acted as", async () => {
    (await manager.acquire(1, "user-1", settings))();
    const asUser = vi
      .spyOn(mock.ctx, "asUser")
      .mockRejectedValue(new Error("unknown user"));
    const warn = vi.spyOn(mock.ctx.log, "warn");
    time = 60_000;
    await expect(manager.sweep()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    // Not again on every sweep.
    time += 15_000;
    await manager.sweep();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(asUser).toHaveBeenCalledTimes(1);
    // Once the user can be acted as again, the stop goes ahead.
    asUser.mockRestore();
    time += 45_000;
    await manager.sweep();
    expect(exec).toHaveBeenLastCalledWith(
      1,
      "docker container stop --time 30 'webtop'",
      expect.anything(),
    );
  });

  it("honors changed idle settings and turning management off", async () => {
    (await manager.acquire(1, "user-1", { ...settings, idleMinutes: 10 }))();
    time = 60_000;
    await manager.sweep(); // Reads the saved one-minute timeout.
    expect(exec).toHaveBeenCalledTimes(2);
    (await manager.acquire(1, "user-1", settings))();
    await mock.ctx.settings.setHost(1, "selkiesManageContainer", false);
    time += 60_000;
    await manager.sweep();
    expect(exec).toHaveBeenCalledTimes(3);
  });

  it("checks the original user's permission before background stops", async () => {
    (await manager.acquire(1, "user-1", settings))();
    vi.spyOn(mock.ctx.rbac, "has").mockImplementation(async () => {
      expect(mock.ctx.currentActor()).toBe("user-1");
      return false;
    });
    time = 60_000;
    await manager.sweep();
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("cancels cleanup on plugin disposal", async () => {
    (await manager.acquire(1, "user-1", settings))();
    manager.dispose();
    time = 60_000;
    await manager.sweep();
    expect(exec).toHaveBeenCalledTimes(1);
    await expect(manager.acquire(1, "user-1", settings)).rejects.toThrow(
      "shutting down",
    );
  });

  it("keeps the plugin process awake only while a container is managed", async () => {
    await manager.restore();
    expect(mock.awake.has(AWAKE_REASON)).toBe(false);
    (await manager.acquire(1, "user-1", settings))();
    expect(mock.awake.has(AWAKE_REASON)).toBe(true);
    time = 60_000;
    await manager.sweep();
    expect(exec).toHaveBeenCalledTimes(2);
    expect(mock.awake.has(AWAKE_REASON)).toBe(false);
  });

  it("stops a container started before the process restarted", async () => {
    (await manager.acquire(1, "user-1", settings))();
    await manager.flush();
    manager.dispose();
    // Disposal keeps the reason, so core starts the plugin again at boot.
    expect(mock.awake.has(AWAKE_REASON)).toBe(true);

    time = 30_000;
    const restarted = createContainerManager(mock.ctx, closeHost, () => time);
    await restarted.restore();
    // The idle timer starts again from the restart.
    time = 89_999;
    await restarted.sweep();
    expect(exec).toHaveBeenCalledTimes(1);
    time++;
    await restarted.sweep();
    expect(exec).toHaveBeenLastCalledWith(
      1,
      "docker container stop --time 30 'webtop'",
      expect.anything(),
    );
    await restarted.flush();
    expect(await mock.ctx.kv.list()).toEqual([]);
    expect(mock.awake.has(AWAKE_REASON)).toBe(false);
  });

  it("drops saved state that is invalid or no longer managed", async () => {
    await mock.ctx.kv.set("container:2", {
      hostId: 2,
      userId: "user-1",
      name: "webtop;id",
    });
    await mock.ctx.kv.set("container:3", { hostId: 4, userId: "user-1" });
    await mock.ctx.kv.set("container:1", {
      hostId: 1,
      userId: "user-1",
      name: "webtop",
    });
    await mock.ctx.settings.setHost(1, "selkiesManageContainer", false);
    await manager.restore();
    expect(await mock.ctx.kv.list()).toEqual(["container:1"]);
    time = 600_000;
    await manager.sweep();
    await manager.flush();
    expect(exec).not.toHaveBeenCalled();
    expect(await mock.ctx.kv.list()).toEqual([]);
    expect(mock.awake.has(AWAKE_REASON)).toBe(false);
  });
});

describe("systemd lifecycle", () => {
  const userService = parseHostSettings({
    ...values,
    selkiesManageType: "systemd-user",
    selkiesServiceName: "selkies.service",
  });

  beforeEach(async () => {
    await mock.ctx.settings.setHost(1, "selkiesManageType", "systemd-user");
    await mock.ctx.settings.setHost(1, "selkiesServiceName", "selkies.service");
  });

  it("starts and stops a user service as the SSH user", async () => {
    (await manager.acquire(1, "user-1", userService))();
    expect(exec).toHaveBeenCalledWith(
      1,
      "systemctl --user start 'selkies.service'",
      expect.objectContaining({ timeoutMs: 120_000 }),
    );
    expect(await mock.ctx.kv.get("container:1")).toEqual({
      hostId: 1,
      userId: "user-1",
      kind: "systemd-user",
      name: "selkies.service",
    });
    time = 60_000;
    await manager.sweep();
    expect(exec).toHaveBeenLastCalledWith(
      1,
      "systemctl --user stop 'selkies.service'",
      expect.anything(),
    );
    expect(closeHost).toHaveBeenCalledWith(1);
    expect(mock.audits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "selkies_service_start",
          details: "systemd-user:selkies.service",
          success: true,
        }),
        expect.objectContaining({
          action: "selkies_service_stop",
          success: true,
        }),
      ]),
    );
  });

  it("starts a system service without a password prompt", async () => {
    await mock.ctx.settings.setHost(1, "selkiesManageType", "systemd-system");
    (
      await manager.acquire(1, "user-1", {
        ...userService,
        manageKind: "systemd-system",
      })
    )();
    expect(exec).toHaveBeenCalledWith(
      1,
      "systemctl --no-ask-password start 'selkies.service'",
      expect.anything(),
    );
    time = 60_000;
    await manager.sweep();
    expect(exec).toHaveBeenLastCalledWith(
      1,
      "systemctl --no-ask-password stop 'selkies.service'",
      expect.anything(),
    );
  });

  it("does not execute invalid unit names", async () => {
    for (const name of ["", "-selkies", "a;id", "a'", "$(id)", "/etc/x"]) {
      await expect(
        manager.acquire(1, "user-1", { ...userService, serviceName: name }),
      ).rejects.toThrow("systemd service");
    }
    expect(exec).not.toHaveBeenCalled();
  });

  it("reports systemd failures", async () => {
    exec.mockResolvedValueOnce({
      ...success,
      code: 5,
      stderr: "Unit selkies.service not found.",
    });
    await expect(manager.acquire(1, "user-1", userService)).rejects.toThrow(
      "systemd start failed: Unit selkies.service not found.",
    );
  });

  it("stops following the old target when the kind changes", async () => {
    (await manager.acquire(1, "user-1", userService))();
    await mock.ctx.settings.setHost(1, "selkiesManageType", "docker");
    time = 60_000;
    await manager.sweep();
    await manager.flush();
    expect(exec).toHaveBeenCalledTimes(1);
    expect(await mock.ctx.kv.list()).toEqual([]);
  });

  it("refuses to switch kinds while desktops are connected", async () => {
    const release = await manager.acquire(1, "user-1", userService);
    await expect(manager.acquire(1, "user-1", settings)).rejects.toThrow(
      "Disconnect this host's desktops",
    );
    release();
  });

  it("restores saved services, and Docker state saved without a kind", async () => {
    await mock.ctx.kv.set("container:1", {
      hostId: 1,
      userId: "user-1",
      kind: "systemd-user",
      name: "selkies.service",
    });
    await mock.ctx.kv.set("container:2", {
      hostId: 2,
      userId: "user-1",
      name: "webtop",
    });
    await mock.ctx.kv.set("container:3", {
      hostId: 3,
      userId: "user-1",
      kind: "shell",
      name: "selkies",
    });
    await mock.ctx.kv.set("container:4", {
      hostId: 4,
      userId: "user-1",
      kind: "systemd-system",
      name: "-x",
    });
    for (const [key, value] of Object.entries(values)) {
      await mock.ctx.settings.setHost(2, key, value);
    }
    await manager.restore();
    expect((await mock.ctx.kv.list()).sort()).toEqual([
      "container:1",
      "container:2",
    ]);
    time = 60_000;
    await manager.sweep();
    expect(exec).toHaveBeenCalledWith(
      1,
      "systemctl --user stop 'selkies.service'",
      expect.anything(),
    );
    expect(exec).toHaveBeenCalledWith(
      2,
      "docker container stop --time 30 'webtop'",
      expect.anything(),
    );
  });
});
