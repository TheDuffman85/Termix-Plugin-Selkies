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
