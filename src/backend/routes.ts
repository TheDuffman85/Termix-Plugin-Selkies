import express, { type Request, type Response, type Router } from "express";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { setTimeout as delay } from "node:timers/promises";
import type { ContainerManager } from "./containers.js";
import {
  directUrl,
  readHostSettings,
  type SelkiesHostSettings,
} from "./host-settings.js";
import { forward, PAGE_CSP, upstreamRequest } from "./proxy.js";
import { isToken, SessionLimitError, type SessionStore } from "./sessions.js";
import {
  createDirectUpstream,
  createSshUpstream,
  type Upstream,
} from "./upstream.js";

export interface RouteDeps {
  ctx: PluginContext;
  sessions: SessionStore;
  containers?: ContainerManager;
  /** Swapped in tests, which have no real container or SSH. */
  openUpstream?: (hostId: number, target: UpstreamInput) => Promise<Upstream>;
}

export interface UpstreamInput {
  ip: string;
  settings: SelkiesHostSettings;
  username: string;
  password: string;
}

type Failure = { status: number; code: string; error: string };

function fail(res: Response, failure: Failure): void {
  res.status(failure.status).json({ error: failure.error, code: failure.code });
}

export function parseHostId(value: unknown): number | null {
  const id = typeof value === "string" ? Number(value) : NaN;
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** An access refusal from core's connect policy, as a 403 body. */
function accessRefusal(error: unknown): Record<string, unknown> | null {
  const failure = error as {
    code?: unknown;
    message?: unknown;
    toJSON?: () => Record<string, unknown>;
  } | null;
  if (
    failure?.code !== "access-required" &&
    failure?.code !== "access-denied"
  ) {
    return null;
  }
  if (typeof failure.toJSON === "function") return failure.toJSON();
  return { error: String(failure.message ?? ""), code: failure.code };
}

/**
 * True once the browser has dropped the request, before an answer was sent.
 *
 * `req.destroyed` alone is no signal: Node also destroys a request whose body
 * was read to the end (as the JSON body parser does). Only a response closed
 * before it finished, or a request closed before its body arrived, is a drop.
 */
function clientGone(req: Request, res: Response): () => boolean {
  let gone = false;
  res.once("close", () => {
    if (!res.writableFinished) gone = true;
  });
  return () => gone || (req.destroyed && !req.complete);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Explain the SSH prerequisite separately from the desktop connection. */
function containerFailure(error: unknown): Failure {
  const reason = message(error);
  const code = (error as { code?: unknown } | null)?.code;
  const context =
    "Automatic Docker startup uses this host's SSH connection, even when the desktop route is Direct.";
  if (
    code === "HOST_KEY_UNVERIFIED" ||
    /host's key is not trusted yet/i.test(reason)
  ) {
    return {
      status: 502,
      code: "container-ssh-unverified",
      error: `Docker startup is blocked because this host's SSH key is not trusted yet. Open a normal SSH terminal for this same host entry in Termix, verify its fingerprint and trust the key, then reconnect to Selkies. ${context}`,
    };
  }
  if (code === "HOST_KEY_CHANGED" || /host's key has changed/i.test(reason)) {
    return {
      status: 502,
      code: "container-ssh-key-changed",
      error: `Docker startup is blocked because this host's SSH key has changed. Open a normal SSH terminal for this same host entry in Termix and verify the new fingerprint before trusting it, then reconnect to Selkies. ${context}`,
    };
  }
  return {
    status: 502,
    code: "container-failed",
    error: `Could not start the Docker container over SSH. Check that a normal SSH terminal can connect to this same host entry in Termix, then check the container name and the SSH user's Docker permissions. ${context} Details: ${reason}`,
  };
}

/** Selkies answers a plain GET with 204 when its WebSocket transport is active. */
export function probeUpstream(
  upstream: Upstream,
  timeoutMs = 10_000,
): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      host: upstream.hostHeader,
      "x-forwarded-proto": upstream.scheme,
    };
    if (upstream.authorization) headers.authorization = upstream.authorization;
    const request = upstreamRequest(upstream, {
      method: "GET",
      path: `${upstream.path}api/websockets`,
      headers,
    });
    const timeout = setTimeout(() => {
      request.destroy();
      reject(new Error("The container did not answer in time"));
    }, timeoutMs);
    request.once("response", (answer) => {
      clearTimeout(timeout);
      answer.destroy();
      resolve({ status: answer.statusCode ?? 0 });
    });
    request.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    request.end();
  });
}

function probeFailure(status: number): Failure | null {
  if (status === 401 || status === 403) {
    return {
      status: 409,
      code: "unauthorized",
      error: "The Selkies container refused the login",
    };
  }
  if (status >= 500 || status === 0) {
    return {
      status: 502,
      code: "unreachable",
      error: `The Selkies container answered ${status}`,
    };
  }
  return status === 204
    ? null
    : {
        status: 502,
        code: "not-selkies",
        error: `The configured Selkies stream did not report active WebSocket mode (HTTP ${status})`,
      };
}

export function registerRoutes(router: Router, deps: RouteDeps): void {
  const { ctx, sessions } = deps;
  const json = express.json({ limit: "16kb" });
  const requireConnect = ctx.rbac.require("connect") as never;
  const enabled = async () =>
    (await ctx.settings.get<boolean>("enabled")) !== false;
  const disabled: Failure = {
    status: 503,
    code: "disabled",
    error: "Selkies is turned off",
  };

  const openUpstream =
    deps.openUpstream ??
    (async (hostId: number, input: UpstreamInput): Promise<Upstream> => {
      const target = {
        scheme: input.settings.scheme,
        host: input.ip,
        port: input.settings.port,
        path: input.settings.path,
        ignoreCert: input.settings.ignoreCert,
        username: input.username,
        password: input.password,
      };
      return input.settings.route === "ssh"
        ? createSshUpstream(ctx, hostId, target)
        : createDirectUpstream(target);
    });

  /**
   * Resolves a host the actor may connect to, its login and settings, and
   * opens the way to its container. Answers the request itself on failure.
   */
  async function prepare(
    req: Request,
    res: Response,
    gone: () => boolean = () => false,
  ): Promise<{
    hostId: number;
    name: string;
    settings: SelkiesHostSettings;
    ip: string;
    upstream: Upstream;
    release: () => void;
  } | null> {
    if (!(await enabled())) {
      fail(res, disabled);
      return null;
    }
    const hostId = parseHostId(req.params.hostId);
    if (hostId === null) {
      fail(res, { status: 400, code: "bad-host", error: "Invalid host id" });
      return null;
    }
    let target;
    try {
      target = await ctx.credentials.resolveHostProtocol(hostId, "selkies");
    } catch (error) {
      const refusal = accessRefusal(error);
      if (!refusal) throw error;
      res.status(403).json(refusal);
      return null;
    }
    if (!target) {
      fail(res, { status: 404, code: "not-found", error: "Host not found" });
      return null;
    }
    const settings = await readHostSettings(ctx, hostId);
    if (!settings.enabled) {
      fail(res, {
        status: 409,
        code: "not-enabled",
        error: "Selkies is not turned on for this host",
      });
      return null;
    }
    let release = () => {};
    if (settings.manageContainer) {
      const userId = ctx.currentActor();
      if (!userId) {
        fail(res, {
          status: 401,
          code: "unauthenticated",
          error: "Sign in first",
        });
        return null;
      }
      try {
        if (!deps.containers)
          throw new Error("Container management is unavailable");
        release = await deps.containers.acquire(hostId, userId, settings);
      } catch (error) {
        const refusal = accessRefusal(error);
        if (refusal) res.status(403).json(refusal);
        else fail(res, containerFailure(error));
        return null;
      }
    }
    let upstream: Upstream;
    try {
      upstream = await openUpstream(hostId, {
        ip: target.host.ip,
        settings,
        username: target.auth.username,
        password: target.auth.password,
      });
    } catch (error) {
      release();
      fail(res, { status: 502, code: "unreachable", error: message(error) });
      return null;
    }
    try {
      // A freshly started desktop takes time to boot. Retry transport errors
      // and startup responses, but fail bad credentials immediately.
      const deadline = Date.now() + (settings.manageContainer ? 60_000 : 0);
      let status: number;
      for (;;) {
        // Nobody waits for the answer any more: stop probing.
        if (gone()) throw new Error("The request was cancelled");
        try {
          ({ status } = await probeUpstream(
            upstream,
            settings.manageContainer ? 2000 : 10_000,
          ));
          if (
            status === 204 ||
            status === 401 ||
            status === 403 ||
            Date.now() >= deadline
          )
            break;
        } catch (error) {
          if (Date.now() >= deadline) throw error;
        }
        await delay(1000);
      }
      const failure = probeFailure(status);
      if (failure) {
        upstream.close();
        release();
        fail(res, failure);
        return null;
      }
    } catch (error) {
      upstream.close();
      release();
      fail(res, { status: 502, code: "unreachable", error: message(error) });
      return null;
    }
    return {
      hostId,
      name: target.host.name ?? target.host.ip,
      settings,
      ip: target.host.ip,
      upstream,
      release,
    };
  }

  /**
   * @openapi
   * /plugin-api/selkies/launch/{hostId}:
   *   post:
   *     summary: Open a Selkies desktop on a host
   *     description: >
   *       Checks access and the container, then starts a session. The answer's
   *       token opens the proxied desktop page at /plugin-api/selkies/s/{token}/.
   *     tags:
   *       - Selkies
   *     parameters:
   *       - in: path
   *         name: hostId
   *         required: true
   *         schema:
   *           type: integer
   *     responses:
   *       200:
   *         description: >
   *           The session token, and the container's own address for Open in
   *           browser (null when the host has Open in browser off)
   *       400:
   *         description: Invalid host id
   *       403:
   *         description: No permission or connect access to the host
   *       404:
   *         description: Host not found
   *       409:
   *         description: Selkies is off for the host, or the container refused the login
   *       502:
   *         description: The container could not be reached
   *       503:
   *         description: >
   *           Selkies is turned off on this server, or every desktop slot holds
   *           a live desktop
   */
  router.post(
    "/launch/:hostId",
    requireConnect,
    json,
    async (req: Request, res: Response) => {
      const userId = ctx.currentActor();
      if (!userId) {
        fail(res, {
          status: 401,
          code: "unauthenticated",
          error: "Sign in first",
        });
        return;
      }
      const gone = clientGone(req, res);
      const prepared = await prepare(req, res, gone);
      if (!prepared) return;
      try {
        if (!(await enabled())) {
          prepared.upstream.close();
          fail(res, disabled);
          return;
        }
        // The browser gave up while the container started: no one would ever
        // load this session, and it would hold its connection until it idles out.
        if (gone()) {
          prepared.upstream.close();
          return;
        }
        let session;
        try {
          session = sessions.mint({
            userId,
            hostId: prepared.hostId,
            upstream: prepared.upstream,
          });
        } catch (error) {
          prepared.upstream.close();
          if (!(error instanceof SessionLimitError)) throw error;
          fail(res, { status: 503, code: error.code, error: error.message });
          return;
        }
        ctx.audit.record({
          action: "selkies_connect",
          resourceType: "host",
          resourceId: String(prepared.hostId),
          resourceName: prepared.name,
          details: prepared.settings.route,
          success: true,
        });
        res.json({
          token: session.token,
          directUrl: directUrl(prepared.settings, prepared.ip),
        });
      } finally {
        prepared.release();
      }
    },
  );

  /**
   * @openapi
   * /plugin-api/selkies/probe/{hostId}:
   *   post:
   *     summary: Check that a host's Selkies container answers
   *     tags:
   *       - Selkies
   *     parameters:
   *       - in: path
   *         name: hostId
   *         required: true
   *         schema:
   *           type: integer
   *     responses:
   *       200:
   *         description: The container answered with the saved login
   *       403:
   *         description: No permission or connect access to the host
   *       404:
   *         description: Host not found
   *       409:
   *         description: Selkies is off for the host, or the container refused the login
   *       502:
   *         description: The container could not be reached
   */
  router.post(
    "/probe/:hostId",
    requireConnect,
    json,
    async (req: Request, res: Response) => {
      const prepared = await prepare(req, res, clientGone(req, res));
      if (!prepared) return;
      prepared.upstream.close();
      prepared.release();
      res.json({ ok: true });
    },
  );

  /**
   * @openapi
   * /plugin-api/selkies/sessions/{token}/close:
   *   post:
   *     summary: End one of the caller's Selkies sessions
   *     tags:
   *       - Selkies
   *     parameters:
   *       - in: path
   *         name: token
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: Whether a session was ended
   */
  router.post(
    "/sessions/:token/close",
    requireConnect,
    json,
    (req: Request, res: Response) => {
      const userId = ctx.currentActor();
      const token = req.params.token;
      const closed =
        !!userId && isToken(token) && sessions.close(token, userId);
      res.json({ closed });
    },
  );

  /**
   * @openapi
   * /plugin-api/selkies/s/{token}/:
   *   get:
   *     summary: Open the proxied Selkies desktop page
   *     security: []
   *     tags:
   *       - Selkies
   *     parameters:
   *       - in: path
   *         name: token
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: The container's desktop page
   *       404:
   *         description: Unknown, expired or revoked session
   * /plugin-api/selkies/s/{token}/{path}:
   *   get:
   *     summary: The proxied Selkies desktop page and its files
   *     security: []
   *     description: >
   *       Public: the session token in the path is the credential, since the
   *       page runs in a sandboxed frame that sends no Termix login. Requests
   *       go to the session's container with its saved login.
   *     tags:
   *       - Selkies
   *     parameters:
   *       - in: path
   *         name: token
   *         required: true
   *         schema:
   *           type: string
   *       - in: path
   *         name: path
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: The container's answer
   *       404:
   *         description: Unknown or expired session, or a refused path
   *       502:
   *         description: The container did not answer
   */
  async function serveSession(req: Request, res: Response) {
    const token = req.path.split("/", 3)[2];
    const session =
      isToken(token) && (await enabled()) ? await sessions.use(token) : null;
    const release = session && sessions.track(session);
    if (!session || !release) {
      req.resume();
      res
        .status(404)
        .type("text/plain")
        .set("cache-control", "no-store")
        .set("content-security-policy", PAGE_CSP)
        .send(
          "This Selkies session has ended. Reopen the tab to start a new one.",
        );
      return;
    }
    try {
      // Keep the raw path escapes for the upstream path validation.
      const rest = req.url.slice(`/s/${session.token}`.length);
      if (!rest.startsWith("/")) {
        req.resume();
        res
          .set("cache-control", "no-store")
          .set("content-security-policy", PAGE_CSP)
          .redirect(301, `${session.token}/${rest}`);
        return;
      }
      await forward(req, res, session.upstream, rest, session.signal);
    } finally {
      release();
    }
  }

  router.all("/s/:token", serveSession);
  router.all("/s/:token/*path", serveSession);
}
