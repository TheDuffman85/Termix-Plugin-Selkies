import { randomBytes } from "node:crypto";
import type { Upstream } from "./upstream.js";

/** A session with no traffic and no active connection ends after this. */
export const SESSION_IDLE_MS = 10 * 60 * 1000;
/** Maximum session age, enforced on use and during the sweep. */
export const SESSION_MAX_MS = 12 * 60 * 60 * 1000;
export const SESSION_ACCESS_MS = 15_000;
const MAX_SESSIONS = 500;
/** One user's open desktops; their oldest ends to make room for a new one. */
const MAX_SESSIONS_PER_USER = 20;

/** Every session slot holds a live desktop: nothing can be ended for a new one. */
export class SessionLimitError extends Error {
  readonly code = "too-many-sessions";
  constructor() {
    super(
      "Too many Selkies desktops are open on this server. Close one and try again.",
    );
  }
}

/**
 * One opened desktop. Its token is the only credential for the proxied page
 * and its socket: the page runs in a sandboxed frame that sends no Termix
 * cookie, so the token rides in the path (pages) or the query (the socket).
 */
export interface SelkiesSession {
  token: string;
  userId: string;
  hostId: number;
  upstream: Upstream;
  createdAt: number;
  lastUsed: number;
  signal: AbortSignal;
}

interface StoredSession extends SelkiesSession {
  controller: AbortController;
  active: number;
  accessUntil: number;
  accessCheck?: Promise<void>;
}

export interface SessionStoreOptions {
  now?: () => number;
  idleMs?: number;
  maxMs?: number;
  maxSessions?: number;
  maxSessionsPerUser?: number;
  /** Keeps a managed container busy while an HTTP request or stream is open. */
  onTrack?: (session: SelkiesSession) => (() => void) | null;
}

export function createSessionStore(
  checkAccess: (session: SelkiesSession) => Promise<boolean>,
  options: SessionStoreOptions = {},
) {
  const now = options.now ?? Date.now;
  const idleMs = options.idleMs ?? SESSION_IDLE_MS;
  const maxMs = options.maxMs ?? SESSION_MAX_MS;
  const maxSessions = options.maxSessions ?? MAX_SESSIONS;
  const maxPerUser = options.maxSessionsPerUser ?? MAX_SESSIONS_PER_USER;
  const sessions = new Map<string, StoredSession>();

  function end(session: StoredSession): void {
    if (!sessions.delete(session.token)) return;
    session.controller.abort();
    session.upstream.close();
  }

  function expired(session: StoredSession, time: number): boolean {
    if (time - session.createdAt > maxMs) return true;
    return session.active === 0 && time - session.lastUsed > idleMs;
  }

  function prune(): void {
    const time = now();
    for (const session of [...sessions.values()]) {
      if (expired(session, time)) end(session);
    }
  }

  function refreshAccess(session: StoredSession, fresh: boolean) {
    if (session.accessCheck) return session.accessCheck;
    if (!fresh && now() < session.accessUntil) return;
    // Asset requests can arrive in parallel. Share one audited check and
    // keep its result briefly, while upgrades and the sweep ask again.
    session.accessCheck = Promise.resolve()
      .then(() => checkAccess(session))
      .then(
        (allowed) => {
          if (allowed) session.accessUntil = now() + SESSION_ACCESS_MS;
          else end(session);
        },
        () => end(session),
      )
      .finally(() => {
        session.accessCheck = undefined;
      });
    return session.accessCheck;
  }

  return {
    mint(data: {
      userId: string;
      hostId: number;
      upstream: Upstream;
    }): SelkiesSession {
      prune();
      const oldest = (list: StoredSession[]) =>
        list.reduce<StoredSession | undefined>(
          (found, session) =>
            !found || session.lastUsed < found.lastUsed ? session : found,
          undefined,
        );
      // A user makes room among their own desktops first.
      for (;;) {
        const own = [...sessions.values()].filter(
          (session) => session.userId === data.userId,
        );
        if (own.length < maxPerUser) break;
        const victim = oldest(own);
        if (!victim) break;
        end(victim);
      }
      // Server-wide, only sessions with no open stream or request make room,
      // so one user can never end another user's live desktop.
      while (sessions.size >= maxSessions) {
        const victim = oldest(
          [...sessions.values()].filter((session) => session.active === 0),
        );
        if (!victim) throw new SessionLimitError();
        end(victim);
      }
      const time = now();
      const controller = new AbortController();
      const session: StoredSession = {
        ...data,
        token: randomBytes(32).toString("base64url"),
        createdAt: time,
        lastUsed: time,
        signal: controller.signal,
        controller,
        active: 0,
        accessUntil: time,
      };
      sessions.set(session.token, session);
      return session;
    },

    /** The live session for a token whose opener still has access. */
    async use(token: string, fresh = false): Promise<SelkiesSession | null> {
      const session = sessions.get(token);
      if (!session) return null;
      const time = now();
      if (expired(session, time)) {
        end(session);
        return null;
      }
      await refreshAccess(session, fresh);
      if (session.signal.aborted) return null;
      if (expired(session, now())) {
        end(session);
        return null;
      }
      session.lastUsed = now();
      return session;
    },

    /** Ends a session, only for the user who opened it. */
    close(token: string, userId: string): boolean {
      const session = sessions.get(token);
      if (!session || session.userId !== userId) return false;
      end(session);
      return true;
    },

    /** Counts a request or a socket as active until its caller releases it. */
    track(session: SelkiesSession): (() => void) | null {
      const stored = sessions.get(session.token);
      if (stored !== session) return null;
      const release = options.onTrack?.(session);
      if (release === null) return null;
      stored.active++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        stored.active--;
        stored.lastUsed = now();
        release?.();
      };
    },

    async sweep(): Promise<void> {
      prune();
      await Promise.all(
        [...sessions.values()]
          .filter((session) => session.active > 0)
          .map((session) => refreshAccess(session, true)),
      );
    },

    clear(): void {
      for (const session of [...sessions.values()]) end(session);
    },

    closeHost(hostId: number): void {
      for (const session of [...sessions.values()]) {
        if (session.hostId === hostId) end(session);
      }
    },

    get size(): number {
      return sessions.size;
    },
  };
}

export type SessionStore = ReturnType<typeof createSessionStore>;

/** A token as mint makes it: 43 base64url characters. */
export function isToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}
