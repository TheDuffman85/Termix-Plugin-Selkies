import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { MOVED_HEADERS_PARAM, SHIM_SOURCE } from "../../src/backend/shim.js";

const TOKEN = "T".repeat(43);
const PAGE = `https://termix.example/base/plugin-api/selkies/s/${TOKEN}/`;

/** A sandboxed frame as far as the shim can tell: storage and cookies throw. */
function fakeWindow(href = PAGE) {
  const url = new URL(href);
  const opened: Array<{ url: string; protocols?: unknown }> = [];
  const posted: Array<{ message: unknown; target: unknown }> = [];
  const workers: string[] = [];

  class FakeWebSocket {
    static CONNECTING = 0;
    url: string;
    constructor(target: string, protocols?: unknown) {
      this.url = target;
      opened.push({ url: target, protocols });
    }
  }
  class FakeBlob {
    parts: unknown[];
    type: string;
    constructor(parts: unknown[] = [], options: { type?: string } = {}) {
      this.parts = parts;
      this.type = options.type ?? "";
    }
  }
  class FakeWorker {
    constructor(target: string) {
      workers.push(target);
    }
  }
  const blobs = new Map<string, FakeBlob>();
  let blobId = 0;
  const URLWithBlobs = Object.assign(
    function (input: string, base?: string) {
      return new URL(input, base);
    },
    {
      createObjectURL: (blob: FakeBlob) => {
        const id = `blob:null/${++blobId}`;
        blobs.set(id, blob);
        return id;
      },
      revokeObjectURL: () => undefined,
    },
  );
  URLWithBlobs.prototype = URL.prototype;

  const xhrCalls: Array<[string, ...unknown[]]> = [];
  class FakeXHR {
    withCredentials = true;
    open(...args: unknown[]) {
      xhrCalls.push(["open", ...args]);
    }
    setRequestHeader(...args: unknown[]) {
      xhrCalls.push(["header", ...args]);
    }
    send(...args: unknown[]) {
      xhrCalls.push(["send", this.withCredentials, ...args]);
    }
  }

  const win: Record<string, unknown> = {
    location: {
      pathname: url.pathname,
      host: url.host,
      protocol: url.protocol,
      href,
    },
    WebSocket: FakeWebSocket,
    Blob: FakeBlob,
    Worker: FakeWorker,
    XMLHttpRequest: FakeXHR,
    URL: URLWithBlobs,
    URLSearchParams,
    JSON,
    Object,
    Array,
    String,
    btoa: (s: string) => Buffer.from(s, "binary").toString("base64"),
    unescape,
    encodeURIComponent,
    postMessage(message: unknown, target: unknown) {
      posted.push({ message, target });
    },
  };
  Object.defineProperty(win, "localStorage", {
    configurable: true,
    get() {
      throw new Error("SecurityError");
    },
  });
  Object.defineProperty(win, "sessionStorage", {
    configurable: true,
    get() {
      throw new Error("SecurityError");
    },
  });
  const document = {};
  Object.defineProperty(document, "cookie", {
    configurable: true,
    get() {
      throw new Error("SecurityError");
    },
  });
  win.document = document;
  win.window = win;
  win.self = win;
  const context = vm.createContext(win);
  vm.runInContext(SHIM_SOURCE, context);
  return {
    win,
    context,
    opened,
    posted,
    workers,
    blobs,
    xhrCalls,
    FakeWebSocket,
  };
}

describe("shim", () => {
  it("moves the stream socket to the plugin's socket route", () => {
    const { context, opened } = fakeWindow();
    vm.runInContext(
      `new WebSocket("wss://termix.example/base/plugin-api/selkies/s/${TOKEN}/api/websockets?role=viewer", ["a"]);
       new WebSocket("wss://elsewhere.example/socket");`,
      context,
    );
    expect(opened[0].url).toBe(
      `wss://termix.example/base/plugin-ws/selkies/stream?t=${TOKEN}&p=websockets&role=viewer`,
    );
    expect(opened[0].protocols).toEqual(["a"]);
    expect(opened[1].url).toBe("wss://elsewhere.example/socket");
  });

  it("keeps instanceof and the state constants", () => {
    const { context } = fakeWindow();
    expect(
      vm.runInContext(
        `var s = new WebSocket("wss://x.example/"); [s instanceof WebSocket, WebSocket.OPEN, WebSocket.CLOSED]`,
        context,
      ),
    ).toEqual([true, 1, 3]);
  });

  it("gives every script blob the socket fix, so worker sockets move too", () => {
    const { context, blobs } = fakeWindow();
    const parts = vm.runInContext(
      `var b = new Blob(["'use strict';\\nnew WebSocket(self.target);"], { type: "text/javascript" });
       var other = new Blob(["plain"], { type: "text/plain" });
       [b.parts, other.parts, b instanceof Blob]`,
      context,
    ) as [string[], string[], boolean];
    expect(parts[1]).toEqual(["plain"]);
    expect(parts[2]).toBe(true);
    expect(parts[0][0]).toBe("'use strict';\n");
    expect(blobs.size).toBe(0);

    // Run the blob's code as a worker would, with its own WebSocket.
    const workerOpened: string[] = [];
    const worker: Record<string, unknown> = {
      URL,
      URLSearchParams,
      WebSocket: class {
        constructor(target: string) {
          workerOpened.push(target);
        }
      },
      target: `wss://termix.example/base/plugin-api/selkies/s/${TOKEN}/api/websockets`,
    };
    worker.self = worker;
    vm.runInContext(parts[0].join(""), vm.createContext(worker));
    expect(workerOpened).toEqual([
      `wss://termix.example/base/plugin-ws/selkies/stream?t=${TOKEN}&p=websockets`,
    ]);
  });

  it("starts workers from a URL through a blob", () => {
    const { context, workers, blobs } = fakeWindow();
    vm.runInContext(
      `new Worker("worker.js"); new Worker("blob:null/x");`,
      context,
    );
    expect(workers[0]).toMatch(/^blob:null\//);
    const blob = blobs.get(workers[0])!;
    expect((blob.parts as string[]).join("")).toContain(
      `importScripts("https://termix.example/base/plugin-api/selkies/s/${TOKEN}/worker.js")`,
    );
    expect(workers[1]).toBe("blob:null/x");
  });

  it("replaces storage and cookies that throw", () => {
    const { context } = fakeWindow();
    expect(
      vm.runInContext(
        `localStorage.setItem("a", 1); sessionStorage.setItem("b", "2");
         document.cookie = "x=1";
         [localStorage.getItem("a"), localStorage.length, sessionStorage.getItem("b"), localStorage.getItem("none"), document.cookie]`,
        context,
      ),
    ).toEqual(["1", 1, "2", null, ""]);
  });

  it("lets the client message itself at its opaque origin", () => {
    const { context, posted } = fakeWindow();
    vm.runInContext(
      `window.postMessage({ a: 1 }, "null"); window.postMessage({ b: 2 }, "https://x.example");
       window.postMessage({ c: 3 }, { targetOrigin: "null" });`,
      context,
    );
    expect(posted.map((entry) => entry.target)).toEqual([
      "*",
      "https://x.example",
      { targetOrigin: "*" },
    ]);
  });

  it("moves upload headers into the query and drops credentials", () => {
    const { context, xhrCalls } = fakeWindow();
    vm.runInContext(
      `var x = new XMLHttpRequest();
       x.open("POST", "api/upload", true);
       x.setRequestHeader("X-Upload-Path", "/config/a b.txt");
       x.setRequestHeader("Content-Type", "application/octet-stream");
       x.send("body");`,
      context,
    );
    const opens = xhrCalls.filter((call) => call[0] === "open");
    expect(opens).toHaveLength(2);
    const moved = new URL(opens[1][2] as string);
    expect(moved.pathname).toBe(
      `/base/plugin-api/selkies/s/${TOKEN}/api/upload`,
    );
    const headers = JSON.parse(
      Buffer.from(
        moved.searchParams.get(MOVED_HEADERS_PARAM)!,
        "base64",
      ).toString("utf8"),
    );
    expect(headers).toEqual({ "x-upload-path": "/config/a b.txt" });
    const sent = xhrCalls
      .filter((call) => call[0] === "header")
      .map((call) => call[1]);
    expect(sent).toEqual(["Content-Type", "Content-Type"]);
    expect(xhrCalls.at(-1)).toEqual(["send", false, "body"]);
  });

  it("does nothing outside a session page", () => {
    const { win, FakeWebSocket } = fakeWindow("https://termix.example/other/");
    expect(win.WebSocket).toBe(FakeWebSocket);
  });
});
