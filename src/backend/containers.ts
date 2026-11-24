import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import {
  DEFAULT_IDLE_MINUTES,
  manageKind,
  managedTarget,
  readHostSettings,
  targetName,
  type ManageKind,
  type SelkiesHostSettings,
} from "./host-settings.js";

/**
 * Why the plugin process must stay up: core stops idle plugins otherwise.
 * Unchanged from when Docker was the only kind, so a reason an earlier build
 * left set is still cleared.
 */
export const AWAKE_REASON = "Docker idle shutdown";
const KEY_PREFIX = "container:";

/**
 * What survives a process restart, so a running container or service is still
 * stopped. State saved before systemd support has no kind: it was Docker.
 */
interface StoredContainer {
  hostId: number;
  userId: string;
  kind: ManageKind;
  name: string;
}

interface ManagedContainer {
  hostId: number;
  userId: string;
  kind: ManageKind;
  name: string;
  idleMs: number;
  idleSince: number;
  busy: number;
  /** After a failure, the sweep leaves the entry alone until then. */
  retryAt?: number;
  starting?: Promise<void>;
  stopping?: Promise<void>;
}

function missingName(kind: ManageKind): string {
  return kind === "docker"
    ? "Set a valid Docker container name or ID first"
    : "Set a valid systemd service name first";
}

function sameTarget(
  entry: { kind: ManageKind; name: string },
  target: { kind: ManageKind; name: string },
): boolean {
  return entry.kind === target.kind && entry.name === target.name;
}

/**
 * The command line for a validated name. Names are quoted anyway, and can't
 * start with "-", so they are never read as options.
 */
function commandFor(
  entry: { kind: ManageKind; name: string },
  action: "start" | "stop",
): { label: string; line: string; timeoutMs: number } {
  switch (entry.kind) {
    case "docker":
      return {
        label: "Docker",
        line: `docker container ${action}${action === "stop" ? " --time 30" : ""} '${entry.name}'`,
        timeoutMs: 60_000,
      };
    case "systemd-user":
      // systemd's own stop timeout is 90 seconds by default.
      return {
        label: "systemd",
        line: `systemctl --user ${action} '${entry.name}'`,
        timeoutMs: 120_000,
      };
    case "systemd-system":
      return {
        label: "systemd",
        line: `systemctl --no-ask-password ${action} '${entry.name}'`,
        timeoutMs: 120_000,
      };
  }
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
      kind: entry.kind,
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
    // New use starts a fresh idle period, without an old failure's backoff.
    entry.retryAt = undefined;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--entry.busy === 0) entry.idleSince = now();
    };
  }

  async function command(entry: ManagedContainer, action: "start" | "stop") {
    // Validate again at the execution boundary; values are never shell code.
    if (!entry.name || targetName(entry.kind, entry.name) !== entry.name) {
      throw new Error(missingName(entry.kind));
    }
    const { label, line, timeoutMs } = commandFor(entry, action);
    const result = await ctx.ssh.exec(entry.hostId, line, {
      purpose: "selkies",
      profile: "background",
      timeoutMs,
      maxOutputBytes: 4096,
    });
    const success = result.code === 0 && !result.timedOut;
    await ctx.audit.record({
      action:
        entry.kind === "docker"
          ? `selkies_container_${action}`
          : `selkies_service_${action}`,
      resourceType: "host",
      resourceId: String(entry.hostId),
      details:
        entry.kind === "docker" ? entry.name : `${entry.kind}:${entry.name}`,
      success,
    });
    if (!success) {
      throw new Error(
        result.timedOut
          ? `${label} ${action} timed out`
          : `${label} ${action} failed: ${result.stderr.trim() || `exit code ${result.code}`}`,
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
          const kind = value?.kind === undefined ? "docker" : value.kind;
          if (
            !value ||
            value.hostId !== hostId ||
            !Number.isInteger(hostId) ||
            typeof value.userId !== "string" ||
            !value.userId ||
            manageKind(kind) !== kind ||
            targetName(kind, value.name) !== value.name ||
            !value.name
          ) {
            await ctx.kv.delete(key);
            continue;
          }
          if (disposed || containers.has(hostId)) continue;
          containers.set(hostId, {
            hostId,
            userId: value.userId,
            kind,
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
      const target = managedTarget(settings);
      if (!target) return () => undefined;
      if (disposed) throw new Error("Selkies is shutting down");
      if (!target.name) throw new Error(missingName(target.kind));
      let entry = containers.get(hostId);
      if (entry && !sameTarget(entry, target)) {
        // Don't replace a lifecycle still serving other desktops.
        if (entry.busy || entry.starting || entry.stopping) {
          throw new Error(
            entry.kind === "docker" && target.kind === "docker"
              ? "Disconnect this host's desktops before changing its container"
              : "Disconnect this host's desktops before changing what starts Selkies",
          );
        }
        forget(entry);
        entry = undefined;
      }
      if (!entry) {
        entry = {
          hostId,
          userId,
          kind: target.kind,
          name: target.name,
          idleMs: settings.idleMinutes * 60_000,
          idleSince: now(),
          busy: 0,
        };
        remember(entry);
      }
      entry.idleMs = settings.idleMinutes * 60_000;
      const release = hold(entry);
      try {
        // A reconnect during stop waits, then starts again. Commands never race.
        await entry.stopping;
        if (disposed) throw new Error("Selkies is shutting down");
        let ownStart = false;
        if (!entry.starting) {
          const current = entry;
          ownStart = true;
          entry.starting = command(entry, "start").finally(() => {
            current.starting = undefined;
          });
        }
        await entry.starting;
        // Idle shutdown runs as the last user whose own start succeeded. A
        // failed attempt (say, SSH refused for this user) keeps the previous
        // one, and joining someone else's start proves nothing about access.
        if (
          ownStart &&
          entry.userId !== userId &&
          containers.get(hostId) === entry
        ) {
          entry.userId = userId;
          remember(entry);
        }
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
          if (entry.retryAt !== undefined && now() < entry.retryAt) return;
          // asUser itself can fail too (the user was deleted, say), so the
          // whole check sits inside the try.
          try {
            // Reading settings must not briefly refuse traffic on every sweep.
            await ctx.asUser(entry.userId, async () => {
              const settings = await readHostSettings(ctx, entry.hostId);
              if (
                disposed ||
                entry.busy ||
                entry.starting ||
                entry.stopping ||
                containers.get(entry.hostId) !== entry
              )
                return;
              const target = managedTarget(settings);
              if (!target || !sameTarget(entry, target)) {
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
            });
            entry.retryAt = undefined;
          } catch (error) {
            // Keep tracking failed stops and retry after another idle interval,
            // rather than on every sweep.
            entry.idleSince = now();
            entry.retryAt = now() + entry.idleMs;
            ctx.log.warn(
              `Could not stop Selkies ${entry.kind === "docker" ? "container" : "service"} on host ${entry.hostId}: ${String(error)}`,
            );
          }
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
