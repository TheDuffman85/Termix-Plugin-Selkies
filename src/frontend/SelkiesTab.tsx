import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react";
import {
  useShell,
  useTranslation,
  type TabHandle,
} from "@termix-ssh/plugin-sdk/frontend";
import {
  Button,
  LoadingState,
  ToolbarBand,
  useConfirm,
} from "@termix-ssh/plugin-sdk/ui";
import {
  closeSession,
  launch,
  restart,
  sessionUrl,
  stop,
  type SelkiesApiError,
} from "./selkies-api";

const ERROR_KEYS: Record<string, string> = {
  disabled: "tab.errors.disabled",
  "not-enabled": "tab.errors.notEnabled",
  "not-selkies": "tab.errors.notSelkies",
  unreachable: "tab.errors.unreachable",
  unauthorized: "tab.errors.unauthorized",
  "token-required": "tab.errors.tokenRequired",
  "websocket-mode-inactive": "tab.errors.websocketModeInactive",
  "too-many-sessions": "tab.errors.tooManySessions",
  "access-denied": "tab.errors.forbidden",
  "access-required": "tab.errors.forbidden",
  "not-managed": "tab.errors.notManaged",
};

/**
 * Passed to the desktop's frame. Termix only lets its plugin views use the
 * clipboard today, so the rest waits for a future core; the browser window
 * from "Open in browser" has all of them.
 */
export const FRAME_ALLOW =
  "autoplay; clipboard-read; clipboard-write; fullscreen; microphone; gamepad; keyboard-map; display-capture";

type State =
  | { status: "loading"; action?: "restart" | "stop" }
  | { status: "failed"; message: string; directUrl: string | null }
  | { status: "disconnected" }
  | { status: "stopped" }
  | { status: "ready"; token: string; url: string; directUrl: string | null };

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

function openInBrowser(url: string): void {
  window.open(url, "_blank", "noopener,noreferrer");
}

/**
 * Whether this view may frame the desktop page. The Termix mobile app runs
 * plugin views in a page whose policy forbids frames (frame-src 'none') and
 * has no shell, so useShell() is null there. As a fallback, a frame the
 * page's policy blocks switches the tab over too.
 */
function useFramesAllowed(): boolean {
  const shell = useShell();
  const [blocked, setBlocked] = useState(false);
  useEffect(() => {
    const onViolation = (event: SecurityPolicyViolationEvent) => {
      const directive = event.effectiveDirective || event.violatedDirective;
      if (directive.startsWith("frame-src") || directive === "child-src") {
        setBlocked(true);
      }
    };
    document.addEventListener("securitypolicyviolation", onViolation);
    return () =>
      document.removeEventListener("securitypolicyviolation", onViolation);
  }, []);
  return shell !== null && !blocked;
}

export interface SelkiesTabProps {
  hostId?: string | number;
  isVisible?: boolean;
  handleRef?: Ref<unknown>;
}

export function SelkiesTab({
  hostId,
  isVisible = true,
  handleRef,
}: SelkiesTabProps) {
  const { t } = useTranslation();
  // Read through a ref: t changes with the language, and that must not
  // restart the desktop.
  const tRef = useRef(t);
  tRef.current = t;
  const framesAllowed = useFramesAllowed();
  const [state, setState] = useState<State>({ status: "loading" });
  const [generation, setGeneration] = useState(0);
  const frame = useRef<HTMLIFrameElement>(null);
  const token = useRef<string | null>(null);
  const run = useRef(0);
  const confirm = useConfirm();
  // Whether the host has automatic startup on, from the last launch's answer.
  const [managed, setManaged] = useState(false);

  const release = useCallback(() => {
    if (token.current) closeSession(token.current);
    token.current = null;
  }, []);

  const start = useCallback(async () => {
    const current = ++run.current;
    release();
    setState({ status: "loading" });
    if (hostId === undefined || hostId === null || hostId === "") {
      setState({
        status: "failed",
        message: tRef.current("tab.noHost"),
        directUrl: null,
      });
      return;
    }
    try {
      const result = await launch(hostId);
      if (current !== run.current) {
        closeSession(result.token);
        return;
      }
      token.current = result.token;
      setManaged(result.managed === true);
      setState({
        status: "ready",
        token: result.token,
        url: sessionUrl(result.token),
        directUrl: result.directUrl ?? null,
      });
      setGeneration((value) => value + 1);
    } catch (error) {
      if (current !== run.current) return;
      const failure = error as SelkiesApiError;
      const key = failure.code ? ERROR_KEYS[failure.code] : undefined;
      setManaged(failure.managed === true);
      setState({
        status: "failed",
        message: key
          ? tRef.current(key)
          : failure.message || tRef.current("tab.errors.generic"),
        directUrl: null,
      });
    }
  }, [hostId, release]);

  /**
   * Restarts the host's container or service, for a desktop that logged out
   * or hangs, then opens the new desktop. Or stops it, until the next start.
   */
  const manage = useCallback(
    async (action: "restart" | "stop") => {
      if (hostId === undefined || hostId === null || hostId === "") return;
      const confirmed = await confirm({
        title: tRef.current(`tab.${action}.title`),
        description: tRef.current(`tab.${action}.description`),
        confirmLabel: tRef.current(`tab.${action}.confirm`),
        destructive: true,
      });
      if (!confirmed) return;
      const current = ++run.current;
      release();
      setState({ status: "loading", action });
      try {
        await (action === "restart" ? restart(hostId) : stop(hostId));
      } catch (error) {
        if (current !== run.current) return;
        const failure = error as SelkiesApiError;
        const key = failure.code ? ERROR_KEYS[failure.code] : undefined;
        setManaged(failure.managed === true);
        setState({
          status: "failed",
          message: key
            ? tRef.current(key)
            : failure.message || tRef.current(`tab.errors.${action}Failed`),
          directUrl: null,
        });
        return;
      }
      if (current !== run.current) return;
      if (action === "restart") await start();
      else setState({ status: "stopped" });
    },
    [hostId, confirm, release, start],
  );

  useEffect(() => {
    void start();
    return () => {
      run.current++;
      release();
    };
  }, [start, release]);

  useImperativeHandle(
    handleRef as Ref<TabHandle>,
    (): TabHandle => ({
      reconnect: () => void start(),
      disconnect: () => {
        run.current++;
        release();
        setState({ status: "disconnected" });
      },
      isConnected: () => state.status === "ready",
      focus: () => frame.current?.focus(),
    }),
    [start, release, state.status],
  );

  useEffect(() => {
    if (isVisible && state.status === "ready") frame.current?.focus();
  }, [isVisible, state.status]);

  if (state.status === "loading") {
    return (
      <LoadingState
        label={t(
          state.action === "restart"
            ? "tab.restarting"
            : state.action === "stop"
              ? "tab.stopping"
              : "tab.connecting",
        )}
      />
    );
  }

  if (state.status === "stopped") {
    return (
      <Centered>
        <p className="max-w-lg">{t("tab.stopped")}</p>
        <Button size="sm" variant="outline" onClick={() => void start()}>
          {t("tab.startDesktop")}
        </Button>
      </Centered>
    );
  }

  const size = state.status === "ready" ? "xs" : "sm";
  const manageButtons = managed && (
    <>
      <Button
        size={size}
        variant="ghost"
        onClick={() => void manage("restart")}
      >
        {t("tab.restart.button")}
      </Button>
      <Button size={size} variant="ghost" onClick={() => void manage("stop")}>
        {t("tab.stop.button")}
      </Button>
    </>
  );

  if (state.status === "failed" || state.status === "disconnected") {
    return (
      <Centered>
        <p className="max-w-lg">
          {state.status === "failed" ? state.message : t("tab.disconnected")}
        </p>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => void start()}>
            {t("tab.reconnect")}
          </Button>
          {manageButtons}
        </div>
      </Centered>
    );
  }

  const { directUrl } = state;

  if (!framesAllowed) {
    // Plain links: the mobile app hands them to the phone's browser after
    // asking. The session link still goes through Termix, so it works
    // wherever the app does, and it ends when this tab closes.
    return (
      <Centered>
        <p className="font-medium text-foreground">{t("tab.app.title")}</p>
        <p className="max-w-sm">{t("tab.app.hint")}</p>
        <a
          href={state.url}
          target="_blank"
          rel="noopener noreferrer"
          className="border border-accent-brand/40 px-4 py-2 text-xs font-medium text-accent-brand hover:bg-accent-brand/10"
        >
          {t("tab.app.open")}
        </a>
        <div className="flex gap-2">
          <Button size="xs" variant="ghost" onClick={() => void start()}>
            {t("tab.reconnect")}
          </Button>
          {manageButtons}
          {directUrl && (
            <a
              href={directUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
            >
              {t("tab.openInBrowser")}
            </a>
          )}
        </div>
      </Centered>
    );
  }

  return (
    <div className="flex h-full w-full flex-col">
      <ToolbarBand className="justify-end gap-2">
        {directUrl && (
          <span className="mr-auto truncate text-xs text-muted-foreground">
            {t("tab.browserHint")}
          </span>
        )}
        <Button size="xs" variant="ghost" onClick={() => void start()}>
          {t("tab.reconnect")}
        </Button>
        {manageButtons}
        {directUrl && (
          <Button
            size="xs"
            variant="ghost"
            onClick={() => openInBrowser(directUrl)}
          >
            {t("tab.openInBrowser")}
          </Button>
        )}
      </ToolbarBand>
      <iframe
        key={generation}
        ref={frame}
        title={t("tab.title")}
        src={state.url}
        allow={FRAME_ALLOW}
        allowFullScreen
        referrerPolicy="no-referrer"
        className="min-h-0 w-full flex-1 border-0 bg-black"
      />
    </div>
  );
}
