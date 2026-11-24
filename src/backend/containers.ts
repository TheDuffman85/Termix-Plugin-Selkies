import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import {
  containerName,
  DEFAULT_IDLE_MINUTES,
  readHostSettings,
  type SelkiesHostSettings,
} from "./host-settings.js";

/** Why the plugin process must stay up: core stops idle plugins otherwise. */
export const AWAKE_REASON = "Docker idle shutdown";
const KEY_PREFIX = "container:";

/** What survives a process restart, so a running container is still stopped. */
interface StoredContainer {
  hostId: number;
  userId: string;
  name: string;
}

interface ManagedContainer {
  hostId: number;
  userId: string;
  name: string;
  idleMs: number;
  idleSince: number;
  busy: number;
  starting?: Promise<void>;
  stopping?: Promise<void>;
}

/** One lifecycle per host, shared by all of its tabs and users. */
export function createContainerManager(
  ctx: PluginContext,
  closeHost: (hostId: number) => void,
  now = Date.now,
) {
  const containers = new Map<number, ManagedContainer>();
  let disposed = false;
  // Writes for the same host must land in order.
  let writes = Promise.resolve();

  function store(hostId: number, value: StoredContainer | null): void {
    writes = writes
      .then(() =>
        value
          ? ctx.kv.set(`${KEY_PREFIX}${hostId}`, value)
          : ctx.kv.delete(`${KEY_PREFIX}${hostId}`).then(() => undefined),
      )
      .catch((error: unknown) => {
        ctx.log.warn(
          `Could not save Selkies container state for host ${hostId}: ${String(error)}`,
        );
      });
  }

  /**
   * Core stops a plugin process that has been idle for a while (no requests
   * or sockets), which would drop the idle timers before they fire.
   */
  function syncAwake(): void {
    ctx.schedule.keepAwake?.(AWAKE_REASON, containers.size > 0);
  }

  function remember(entry: ManagedContainer): void {
    containers.set(entry.hostId, entry);
    store(entry.hostId, {
      hostId: entry.hostId,
      userId: entry.userId,
      name: entry.name,
    });
    syncAwake();
  }

  function forget(entry: ManagedContainer): void {
    if (containers.get(entry.hostId) !== entry) return;
    containers.delete(entry.hostId);
    store(entry.hostId, null);
    syncAwake();
  }

  function hold(entry: ManagedContainer): () => void {
    entry.busy++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--entry.busy === 0) entry.idleSince = now();
    };
  }

  async function command(entry: ManagedContainer, action: "start" | "stop") {
    // Validate again at the execution boundary; values are never shell code.
    if (!entry.name || containerName(entry.name) !== entry.name) {
      throw new Error("Set a valid Docker container name or ID first");
    }
    const result = await ctx.ssh.exec(
      entry.hostId,
      `docker container ${action}${action === "stop" ? " --time 30" : ""} '${entry.name}'`,
      {
        purpose: "selkies",
        profile: "background",
        timeoutMs: 60_000,
        maxOutputBytes: 4096,
      },
    );
    const success = result.code === 0 && !result.timedOut;
    await ctx.audit.record({
      action: `selkies_container_${action}`,
      resourceType: "host",
      resourceId: String(entry.hostId),
      details: entry.name,
      success,
    });
    if (!success) {
      throw new Error(
        result.timedOut
          ? `Docker ${action} timed out`
          : `Docker ${action} failed: ${result.stderr.trim() || `exit code ${result.code}`}`,
      );
    }
  }

  return {
    /**
     * Picks up containers a previous process started. Their idle timer starts
     * again from now, since the time without desktops before was not seen.
     */
    async restore(): Promise<void> {
      try {
        const keys = (await ctx.kv.list()).filter((key) =>
          key.startsWith(KEY_PREFIX),
        );
        for (const key of keys) {
          const value = (await ctx.kv.get(
            key,
          )) as Partial<StoredContainer> | null;
          const hostId = Number(key.slice(KEY_PREFIX.length));
          if (
            !value ||
            value.hostId !== hostId ||
            !Number.isInteger(hostId) ||
            typeof value.userId !== "string" ||
            !value.userId ||
            containerName(value.name) !== value.name ||
            !value.name
          ) {
            await ctx.kv.delete(key);
            continue;
          }
          if (disposed || containers.has(hostId)) continue;
          containers.set(hostId, {
            hostId,
            userId: value.userId,
            name: value.name,
            // Read again on the first sweep.
            idleMs: DEFAULT_IDLE_MINUTES * 60_000,
            idleSince: now(),
            busy: 0,
          });
        }
      } catch (error) {
        ctx.log.warn(
          `Could not restore Selkies container state: ${String(error)}`,
        );
      }
      if (!disposed) syncAwake();
    },

    /** Hold the container through startup/readiness; callers release in finally. */
    async acquire(
      hostId: number,
      userId: string,
      settings: SelkiesHostSettings,
    ) {
      if (!settings.manageContainer) return () => undefined;
      if (disposed) throw new Error("Selkies is shutting down");
      if (!settings.containerName) {
        throw new Error("Set a valid Docker container name or ID first");
      }
      let entry = containers.get(hostId);
      if (entry && entry.name !== settings.containerName) {
        // Don't replace a lifecycle still serving other desktops.
        if (entry.busy || entry.starting || entry.stopping) {
          throw new Error(
            "Disconnect this host's desktops before changing its container",
          );
        }
        forget(entry);
        entry = undefined;
      }
      if (!entry) {
        entry = {
          hostId,
          userId,
          name: settings.containerName,
          idleMs: settings.idleMinutes * 60_000,
          idleSince: now(),
          busy: 0,
        };
        remember(entry);
      } else if (entry.userId !== userId) {
        entry.userId = userId;
        remember(entry);
      }
      entry.idleMs = settings.idleMinutes * 60_000;
      const release = hold(entry);
      try {
        // A reconnect during stop waits, then starts again. Commands never race.
        await entry.stopping;
        if (disposed) throw new Error("Selkies is shutting down");
        if (!entry.starting) {
          const current = entry;
          entry.starting = command(entry, "start").finally(() => {
            current.starting = undefined;
          });
        }
        await entry.starting;
        return release;
      } catch (error) {
        release();
        throw error;
      }
    },

    /** Includes HTTP transfers as well as long-lived desktop streams. */
    track(hostId: number): (() => void) | null {
      const entry = containers.get(hostId);
      if (!entry) return () => undefined;
      if (disposed || entry.stopping) return null;
      return hold(entry);
    },

    async sweep(): Promise<void> {
      await Promise.all(
        [...containers.values()].map(async (entry) => {
          if (disposed || entry.busy || entry.starting || entry.stopping)
            return;
          // Reading settings must not briefly refuse traffic on every sweep.
          await ctx.asUser(entry.userId, async () => {
            try {
              const settings = await readHostSettings(ctx, entry.hostId);
              if (
                disposed ||
                entry.busy ||
                entry.starting ||
                entry.stopping ||
                containers.get(entry.hostId) !== entry
              )
                return;
              if (
                !settings.manageContainer ||
                settings.containerName !== entry.name
              ) {
                forget(entry);
                return;
              }
              entry.idleMs = settings.idleMinutes * 60_000;
              if (
                disposed ||
                entry.busy ||
                now() - entry.idleSince < entry.idleMs
              )
                return;
              entry.stopping = Promise.resolve()
                .then(async () => {
                  if (!(await ctx.rbac.has("connect"))) {
                    throw new Error(
                      "The user no longer has permission to manage Selkies",
                    );
                  }
                  if (disposed || entry.busy) return;
                  closeHost(entry.hostId);
                  await command(entry, "stop");
                  // A concurrent acquire may be waiting to restart this same entry.
                  if (!entry.busy) forget(entry);
                })
                .finally(() => {
                  entry.stopping = undefined;
                });
              await entry.stopping;
            } catch (error) {
              // Keep tracking failed stops and retry after another idle interval.
              entry.idleSince = now();
              ctx.log.warn(
                `Could not stop Selkies container on host ${entry.hostId}: ${String(error)}`,
              );
            }
          });
        }),
      );
    },

    /**
     * Keeps the saved state and the keep-awake reason, so a restarted process
     * still stops containers this one started.
     */
    dispose(): void {
      disposed = true;
      containers.clear();
    },

    /** Resolves once saved state has been written. For tests. */
    flush(): Promise<void> {
      return writes;
    },
  };
}

export type ContainerManager = ReturnType<typeof createContainerManager>;
