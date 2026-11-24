import type { Router } from "express";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { readHostSettings } from "./host-settings.js";
import { registerRoutes } from "./routes.js";
import { createSessionStore, SESSION_ACCESS_MS } from "./sessions.js";
import { createSocketProxy } from "./socket-proxy.js";
import { createContainerManager } from "./containers.js";

export async function activate(ctx: PluginContext) {
  // The proxy streams bodies and serves a whole web app from public routes,
  // so it needs raw bodies and more than the default public request budget.
  const router = ctx.http.router<Router>({
    public: ["/s/:token/*"],
    rawBody: true,
    publicRateLimit: 6000,
  });

  const containers = createContainerManager(ctx, (hostId) =>
    sessions.closeHost(hostId),
  );
  const sessions = createSessionStore(
    async ({ userId, hostId }) => {
      if ((await ctx.settings.get<boolean>("enabled")) === false) return false;
      return ctx.asUser(userId, async () => {
        if (!(await ctx.rbac.has("connect"))) return false;
        if (!(await readHostSettings(ctx, hostId)).enabled) return false;
        // Use the same host grant and connect policy as launch. Nothing from
        // the resolved login is needed to check whether this session may continue.
        return (
          (await ctx.credentials.resolveHostProtocol(hostId, "selkies")) !==
          null
        );
      });
    },
    { onTrack: ({ hostId }) => containers.track(hostId) },
  );
  ctx.disposables.add(() => containers.dispose());
  // Containers started before a Termix restart or an idle process stop.
  await containers.restore();
  ctx.disposables.add(() => sessions.clear());
  const timer = setInterval(() => {
    void sessions
      .sweep()
      .then(() => containers.sweep())
      .catch((error: unknown) => {
        ctx.log.warn(`Selkies cleanup failed: ${String(error)}`);
      });
  }, SESSION_ACCESS_MS);
  timer.unref?.();
  ctx.disposables.add(() => clearInterval(timer));

  ctx.settings.onChange("enabled", (value) => {
    if (value === false) sessions.clear();
  });

  registerRoutes(router, { ctx, sessions, containers });

  // Public like the page: the session token in the query is the credential.
  const socketProxy = createSocketProxy(sessions);
  ctx.ws.upgrade(
    "/stream",
    (request, socket, head) =>
      socketProxy(
        request as Parameters<typeof socketProxy>[0],
        socket as Parameters<typeof socketProxy>[1],
        head as Buffer,
      ),
    { public: true },
  );

  ctx.hosts.status.registerPort(
    "selkies",
    async (hostId) => (await readHostSettings(ctx, hostId)).port,
  );
}

export async function deactivate() {
  // Everything registered through ctx is disposed by core.
}
