import { describe, expect, it } from "vitest";
import {
  createSessionStore,
  isToken,
  SESSION_ACCESS_MS,
  SessionLimitError,
} from "../../src/backend/sessions.js";
import { localUpstream } from "./helpers.js";

const allow = async () => true;

describe("sessions", () => {
  it("mints unguessable tokens and finds them", async () => {
    const store = createSessionStore(allow);
    const session = store.mint({
      userId: "u",
      hostId: 1,
      upstream: localUpstream(1),
    });
    expect(isToken(session.token)).toBe(true);
    expect(await store.use(session.token)).toBe(session);
    expect(await store.use("x".repeat(43))).toBeNull();
  });

  it("ends idle sessions, but not while a stream is open", async () => {
    let time = 0;
    const store = createSessionStore(allow, {
      now: () => time,
      idleMs: 100,
      maxMs: 1000,
    });
    const upstream = localUpstream(1);
    const session = store.mint({ userId: "u", hostId: 1, upstream });
    const release = store.track(session)!;
    time = 500;
    expect(await store.use(session.token)).toBe(session);
    release();
    // Idle time counts from the stream's end.
    time = 550;
    await store.sweep();
    expect(store.size).toBe(1);
    time = 700;
    await store.sweep();
    expect(store.size).toBe(0);
    expect(upstream.closed()).toBe(true);
  });

  it("ends any session at its maximum age and aborts its connections", async () => {
    let time = 0;
    const store = createSessionStore(allow, {
      now: () => time,
      idleMs: 100,
      maxMs: 1000,
    });
    const session = store.mint({
      userId: "u",
      hostId: 1,
      upstream: localUpstream(1),
    });
    store.track(session);
    time = 1001;
    expect(await store.use(session.token)).toBeNull();
    expect(session.signal.aborted).toBe(true);
  });

  it("rejects an existing token when its cached authorization expires", async () => {
    let time = 0;
    let allowed = true;
    const store = createSessionStore(async () => allowed, { now: () => time });
    const session = store.mint({
      userId: "u",
      hostId: 1,
      upstream: localUpstream(1),
    });

    expect(await store.use(session.token)).toBe(session);
    allowed = false;
    time = SESSION_ACCESS_MS;
    expect(await store.use(session.token)).toBeNull();
    expect(session.signal.aborted).toBe(true);
  });

  it("rejects a grant revoked while an access check was in flight", async () => {
    let complete!: (allowed: boolean) => void;
    const check = new Promise<boolean>((resolve) => {
      complete = resolve;
    });
    const store = createSessionStore(() => check);
    const session = store.mint({
      userId: "u",
      hostId: 1,
      upstream: localUpstream(1),
    });
    const pending = store.use(session.token);
    store.clear();
    complete(true);

    expect(await pending).toBeNull();
    expect(store.track(session)).toBeNull();
  });

  it("closes only for the user who opened it", () => {
    const store = createSessionStore(allow);
    const session = store.mint({
      userId: "u",
      hostId: 1,
      upstream: localUpstream(1),
    });
    expect(store.close(session.token, "other")).toBe(false);
    expect(store.close(session.token, "u")).toBe(true);
    expect(store.size).toBe(0);
  });

  it("drops the oldest session when full", async () => {
    let time = 0;
    const store = createSessionStore(allow, {
      now: () => time++,
      maxSessions: 2,
    });
    const first = store.mint({
      userId: "u",
      hostId: 1,
      upstream: localUpstream(1),
    });
    store.mint({ userId: "u", hostId: 2, upstream: localUpstream(1) });
    store.mint({ userId: "u", hostId: 3, upstream: localUpstream(1) });
    expect(store.size).toBe(2);
    expect(await store.use(first.token)).toBeNull();
  });

  it("makes room among a user's own sessions first", async () => {
    let time = 0;
    const store = createSessionStore(allow, {
      now: () => time++,
      maxSessionsPerUser: 2,
    });
    const other = store.mint({
      userId: "v",
      hostId: 1,
      upstream: localUpstream(1),
    });
    const first = store.mint({
      userId: "u",
      hostId: 1,
      upstream: localUpstream(1),
    });
    store.mint({ userId: "u", hostId: 2, upstream: localUpstream(1) });
    store.mint({ userId: "u", hostId: 3, upstream: localUpstream(1) });
    expect(store.size).toBe(3);
    expect(await store.use(first.token)).toBeNull();
    expect(await store.use(other.token)).toBe(other);
  });

  it("never ends another user's live desktop to make room", async () => {
    let time = 0;
    const store = createSessionStore(allow, {
      now: () => time++,
      maxSessions: 2,
    });
    const live = store.mint({
      userId: "v",
      hostId: 1,
      upstream: localUpstream(1),
    });
    store.track(live);
    const idle = store.mint({
      userId: "v",
      hostId: 2,
      upstream: localUpstream(1),
    });
    // The idle one makes room.
    const mine = store.mint({
      userId: "u",
      hostId: 3,
      upstream: localUpstream(1),
    });
    expect(await store.use(idle.token)).toBeNull();
    store.track(mine);
    // Both left are live: refuse rather than end one.
    expect(() =>
      store.mint({ userId: "u", hostId: 4, upstream: localUpstream(1) }),
    ).toThrow(SessionLimitError);
    expect(await store.use(live.token)).toBe(live);
    expect(await store.use(mine.token)).toBe(mine);
  });
});
