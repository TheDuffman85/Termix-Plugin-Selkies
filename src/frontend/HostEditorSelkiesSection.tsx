import { useEffect, useState, type ReactNode } from "react";
import { MonitorPlay, Shield } from "lucide-react";
import {
  HOST_PROTOCOL_SECRET_KEPT,
  useTranslation,
  type HostEditorSectionProps,
  type HostProtocolAuthForm,
} from "@termix-ssh/plugin-sdk/frontend";
import {
  Button,
  DocsLink,
  FakeSwitch,
  Input,
  PasswordInput,
  SectionCard,
  Select2,
} from "@termix-ssh/plugin-sdk/ui";
import {
  DEFAULT_PORT,
  PLUGIN_ID,
  probe,
  type SelkiesApiError,
} from "./selkies-api";

type Bag = Record<string, Record<string, unknown>>;
type Logins = Record<string, HostProtocolAuthForm>;

const EMPTY_LOGIN: HostProtocolAuthForm = {
  authType: "direct",
  credentialId: "",
  username: "",
  password: "",
  fields: {},
};

const SELECT_CLASS =
  "flex h-8 w-full border border-border bg-(--field) px-3 py-1 text-xs outline-none focus:ring-1 focus:ring-ring";

export interface SelkiesForm {
  port: number;
  scheme: string;
  path: string;
  route: string;
  ignoreCert: boolean;
  openInBrowser: boolean;
  publicUrl: string;
  manageContainer: boolean;
  manageType: string;
  containerName: string;
  serviceName: string;
  idleMinutes: number;
  login: HostProtocolAuthForm;
}

/** The section's fields, read from the host editor form. */
export function readForm(
  form: Record<string, unknown> | undefined,
): SelkiesForm {
  const mine = ((form?.pluginSettings as Bag | undefined)?.[PLUGIN_ID] ??
    {}) as Record<string, unknown>;
  const login = (form?.protocolAuth as Logins | undefined)?.[PLUGIN_ID];
  return {
    port:
      typeof mine.selkiesPort === "number" ? mine.selkiesPort : DEFAULT_PORT,
    scheme: mine.selkiesScheme === "http" ? "http" : "https",
    path: typeof mine.selkiesPath === "string" ? mine.selkiesPath : "/",
    route: mine.selkiesRoute === "ssh" ? "ssh" : "direct",
    ignoreCert: mine.selkiesIgnoreCert !== false,
    openInBrowser: mine.selkiesOpenInBrowser === true,
    publicUrl:
      typeof mine.selkiesPublicUrl === "string" ? mine.selkiesPublicUrl : "",
    manageContainer: mine.selkiesManageContainer === true,
    manageType:
      mine.selkiesManageType === "systemd-user" ||
      mine.selkiesManageType === "systemd-system"
        ? mine.selkiesManageType
        : "docker",
    containerName:
      typeof mine.selkiesContainerName === "string"
        ? mine.selkiesContainerName
        : "",
    serviceName:
      typeof mine.selkiesServiceName === "string"
        ? mine.selkiesServiceName
        : "",
    idleMinutes:
      typeof mine.selkiesIdleMinutes === "number"
        ? mine.selkiesIdleMinutes
        : 10,
    login: login ? { ...EMPTY_LOGIN, ...login } : EMPTY_LOGIN,
  };
}

/**
 * What "Open in browser" opens when no address is set: the host's address with
 * the section's protocol, port and path. Mirrors the backend's directUrl.
 */
export function defaultBrowserUrl(
  form: Record<string, unknown> | undefined,
  selkies: SelkiesForm,
): string {
  const ip = typeof form?.ip === "string" ? form.ip.trim() : "";
  if (!ip) return "";
  const bare = ip.replace(/^\[|\]$/g, "");
  const host = bare.includes(":") ? `[${bare}]` : bare;
  return `${selkies.scheme}://${host}:${selkies.port}${selkies.path}`;
}

/** A form patch that sets one of this plugin's host settings. */
export function patchSetting(
  current: Record<string, unknown>,
  key: string,
  value: unknown,
): Record<string, unknown> {
  const bag = (current.pluginSettings as Bag | undefined) ?? {};
  return {
    pluginSettings: {
      ...bag,
      [PLUGIN_ID]: { ...(bag[PLUGIN_ID] ?? {}), [key]: value },
    },
  };
}

/** A form patch that sets one part of the Selkies login. */
export function patchLogin(
  current: Record<string, unknown>,
  part: keyof Omit<HostProtocolAuthForm, "fields">,
  value: string,
): Record<string, unknown> {
  const logins = (current.protocolAuth as Logins | undefined) ?? {};
  const login = logins[PLUGIN_ID]
    ? { ...EMPTY_LOGIN, ...logins[PLUGIN_ID] }
    : EMPTY_LOGIN;
  return {
    protocolAuth: { ...logins, [PLUGIN_ID]: { ...login, [part]: value } },
  };
}

/** A form patch that sets one of the login's declared fields, like the token. */
export function patchLoginField(
  current: Record<string, unknown>,
  key: string,
  value: string,
): Record<string, unknown> {
  const logins = (current.protocolAuth as Logins | undefined) ?? {};
  const login = logins[PLUGIN_ID]
    ? { ...EMPTY_LOGIN, ...logins[PLUGIN_ID] }
    : EMPTY_LOGIN;
  return {
    protocolAuth: {
      ...logins,
      [PLUGIN_ID]: { ...login, fields: { ...login.fields, [key]: value } },
    },
  };
}

/**
 * Whether the editor holds Selkies settings that differ from the saved host.
 * Test connection uses the saved ones. The login isn't compared: a saved
 * password comes back masked, so it can't be told apart from a new one.
 */
export function hasUnsavedSettings(
  form: Record<string, unknown> | undefined,
  host: { pluginSettings?: unknown } | undefined,
): boolean {
  if (!host) return false;
  const { login: _edited, ...edited } = readForm(form);
  const { login: _saved, ...saved } = readForm({
    pluginSettings: host.pluginSettings,
  });
  return JSON.stringify(edited) !== JSON.stringify(saved);
}

/**
 * A whole number between min and max. Text that isn't one yet, like an empty
 * field while retyping, stays in the field without being saved, and leaving
 * the field shows the last valid number again.
 */
export function NumberInput({
  value,
  min,
  max,
  onCommit,
  placeholder,
  "aria-label": ariaLabel,
}: {
  value: number;
  min: number;
  max: number;
  onCommit: (value: number) => void;
  placeholder?: string;
  "aria-label"?: string;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  return (
    <Input
      type="number"
      min={min}
      max={max}
      placeholder={placeholder}
      aria-label={ariaLabel}
      value={text}
      onChange={(event) => {
        const raw = event.target.value;
        setText(raw);
        const parsed = Number(raw);
        if (
          raw.trim() !== "" &&
          Number.isInteger(parsed) &&
          parsed >= min &&
          parsed <= max
        ) {
          onCommit(parsed);
        }
      }}
      onBlur={() => setText(String(value))}
    />
  );
}

function Field({
  label,
  help,
  children,
}: {
  label: string;
  help?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
        {label}
      </label>
      {children}
      {help && <p className="text-[11px] text-muted-foreground">{help}</p>}
    </div>
  );
}

export function HostEditorSelkiesSection(props: HostEditorSectionProps) {
  const { t } = useTranslation();
  const form = readForm(props.form as Record<string, unknown> | undefined);
  const advanced = props.advanced !== false;
  const credentials = (props.credentials ?? []) as Array<{
    id: string | number;
    name: string;
  }>;
  const [test, setTest] = useState<{
    busy: boolean;
    text: string | null;
    ok: boolean;
  }>({
    busy: false,
    text: null,
    ok: false,
  });

  const setSetting = (key: string, value: unknown) =>
    props.updateForm((current) => patchSetting(current, key, value));
  const setLogin = (
    part: keyof Omit<HostProtocolAuthForm, "fields">,
    value: string,
  ) => props.updateForm((current) => patchLogin(current, part, value));

  const hostId = props.host?.id;
  const runTest = async () => {
    if (!hostId) {
      setTest({ busy: false, text: t("hosts.testSaveFirst"), ok: false });
      return;
    }
    setTest({ busy: true, text: null, ok: false });
    try {
      await probe(hostId);
      setTest({ busy: false, text: t("hosts.testOk"), ok: true });
    } catch (error) {
      setTest({
        busy: false,
        text: t("hosts.testFailed", {
          error: (error as SelkiesApiError).message,
        }),
        ok: false,
      });
    }
  };

  const unsaved = hasUnsavedSettings(
    props.form as Record<string, unknown> | undefined,
    props.host,
  );
  const passwordKept = form.login.password === HOST_PROTOCOL_SECRET_KEPT;
  const token = form.login.fields?.token ?? "";
  const tokenKept = token === HOST_PROTOCOL_SECRET_KEPT;
  const setToken = (value: string) =>
    props.updateForm((current) => patchLoginField(current, "token", value));
  const useCredential =
    form.login.authType === "credential" && credentials.length > 0;

  return (
    <>
      <SectionCard
        title={t("hosts.title")}
        icon={<MonitorPlay className="size-3.5" />}
        action={<DocsLink page="" />}
      >
        <div className="flex flex-col gap-4 py-3">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Field label={t("hosts.scheme")} help={t("hosts.schemeHelp")}>
              <Select2
                className={SELECT_CLASS}
                value={form.scheme}
                onChange={(event) => {
                  const scheme = event.target.value;
                  setSetting("selkiesScheme", scheme);
                  if (form.port === 3000 || form.port === 3001) {
                    setSetting("selkiesPort", scheme === "http" ? 3000 : 3001);
                  }
                }}
              >
                <option value="https">HTTPS</option>
                <option value="http">HTTP</option>
              </Select2>
            </Field>
            <Field label={t("hosts.port")}>
              <NumberInput
                aria-label={t("hosts.port")}
                min={1}
                max={65535}
                placeholder={String(DEFAULT_PORT)}
                value={form.port}
                onCommit={(value) => setSetting("selkiesPort", value)}
              />
            </Field>
          </div>
          <Field label={t("hosts.route")} help={t("hosts.routeHelp")}>
            <Select2
              className={SELECT_CLASS}
              value={form.route}
              onChange={(event) =>
                setSetting("selkiesRoute", event.target.value)
              }
            >
              <option value="direct">{t("hosts.routeDirect")}</option>
              <option value="ssh">{t("hosts.routeSsh")}</option>
            </Select2>
          </Field>
          <div className="flex items-start justify-between gap-4">
            <div className="flex flex-col gap-0.5">
              <span className="text-xs">{t("hosts.manageContainer")}</span>
              <span className="text-[11px] text-muted-foreground">
                {t("hosts.manageContainerHelp")}
              </span>
            </div>
            <FakeSwitch
              aria-label={t("hosts.manageContainer")}
              checked={form.manageContainer}
              onChange={(value) => setSetting("selkiesManageContainer", value)}
            />
          </div>
          {form.manageContainer && (
            <Field
              label={t("hosts.manageType")}
              help={t(
                form.manageType === "systemd-user"
                  ? "hosts.manageTypeSystemdUserHelp"
                  : form.manageType === "systemd-system"
                    ? "hosts.manageTypeSystemdSystemHelp"
                    : "hosts.manageTypeDockerHelp",
              )}
            >
              <Select2
                className={SELECT_CLASS}
                aria-label={t("hosts.manageType")}
                value={form.manageType}
                onChange={(event) =>
                  setSetting("selkiesManageType", event.target.value)
                }
              >
                <option value="docker">{t("hosts.manageTypeDocker")}</option>
                <option value="systemd-user">
                  {t("hosts.manageTypeSystemdUser")}
                </option>
                <option value="systemd-system">
                  {t("hosts.manageTypeSystemdSystem")}
                </option>
              </Select2>
            </Field>
          )}
          {form.manageContainer && (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {form.manageType === "docker" ? (
                <Field
                  label={t("hosts.containerName")}
                  help={t("hosts.containerNameHelp")}
                >
                  <Input
                    aria-label={t("hosts.containerName")}
                    placeholder="webtop"
                    value={form.containerName}
                    onChange={(event) =>
                      setSetting("selkiesContainerName", event.target.value)
                    }
                  />
                </Field>
              ) : (
                <Field
                  label={t("hosts.serviceName")}
                  help={t("hosts.serviceNameHelp")}
                >
                  <Input
                    aria-label={t("hosts.serviceName")}
                    placeholder="selkies.service"
                    value={form.serviceName}
                    onChange={(event) =>
                      setSetting("selkiesServiceName", event.target.value)
                    }
                  />
                </Field>
              )}
              <Field
                label={t("hosts.idleMinutes")}
                help={t("hosts.idleMinutesHelp")}
              >
                <NumberInput
                  aria-label={t("hosts.idleMinutes")}
                  min={1}
                  max={1440}
                  value={form.idleMinutes}
                  onCommit={(value) => setSetting("selkiesIdleMinutes", value)}
                />
              </Field>
            </div>
          )}
          {advanced && (
            <>
              <Field label={t("hosts.path")} help={t("hosts.pathHelp")}>
                <Input
                  placeholder="/"
                  value={form.path}
                  onChange={(event) =>
                    setSetting("selkiesPath", event.target.value)
                  }
                />
              </Field>
              {form.scheme === "https" && (
                <div className="flex items-start justify-between gap-4">
                  <div className="flex flex-col gap-0.5">
                    <span className="text-xs">{t("hosts.ignoreCert")}</span>
                    <span className="text-[11px] text-muted-foreground">
                      {t("hosts.ignoreCertHelp")}
                    </span>
                  </div>
                  <FakeSwitch
                    aria-label={t("hosts.ignoreCert")}
                    checked={form.ignoreCert}
                    onChange={(value) => setSetting("selkiesIgnoreCert", value)}
                  />
                </div>
              )}
              <div className="flex items-start justify-between gap-4">
                <div className="flex flex-col gap-0.5">
                  <span className="text-xs">{t("hosts.openInBrowser")}</span>
                  <span className="text-[11px] text-muted-foreground">
                    {t("hosts.openInBrowserHelp")}
                  </span>
                </div>
                <FakeSwitch
                  aria-label={t("hosts.openInBrowser")}
                  checked={form.openInBrowser}
                  onChange={(value) =>
                    setSetting("selkiesOpenInBrowser", value)
                  }
                />
              </div>
              {form.openInBrowser && (
                <Field
                  label={t("hosts.publicUrl")}
                  help={t("hosts.publicUrlHelp")}
                >
                  <Input
                    placeholder={
                      defaultBrowserUrl(
                        props.form as Record<string, unknown> | undefined,
                        form,
                      ) || "https://desktop.example.com/"
                    }
                    value={form.publicUrl}
                    onChange={(event) =>
                      setSetting("selkiesPublicUrl", event.target.value)
                    }
                  />
                </Field>
              )}
            </>
          )}
        </div>
      </SectionCard>

      <SectionCard
        title={t("hosts.login")}
        icon={<Shield className="size-3.5" />}
      >
        <div className="flex flex-col gap-4 py-3">
          {credentials.length > 0 && (
            <Field label={t("hosts.authMethod")}>
              <div className="flex gap-2">
                {(["direct", "credential"] as const).map((method) => (
                  <button
                    key={method}
                    type="button"
                    onClick={() => setLogin("authType", method)}
                    className={`border px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest transition-colors ${
                      (form.login.authType === "credential"
                        ? "credential"
                        : "direct") === method
                        ? "border-accent-brand/40 bg-accent-brand/10 text-accent-brand"
                        : "border-border text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {t(
                      method === "direct"
                        ? "hosts.authDirect"
                        : "hosts.authCredential",
                    )}
                  </button>
                ))}
              </div>
            </Field>
          )}
          {useCredential ? (
            <Field label={t("hosts.credential")}>
              <Select2
                className={SELECT_CLASS}
                value={String(form.login.credentialId ?? "")}
                onChange={(event) =>
                  setLogin("credentialId", event.target.value)
                }
              >
                <option value="">{t("hosts.selectCredential")}</option>
                {credentials.map((credential) => (
                  <option key={credential.id} value={String(credential.id)}>
                    {credential.name}
                  </option>
                ))}
              </Select2>
            </Field>
          ) : (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <Field label={t("hosts.username")} help={t("hosts.usernameHelp")}>
                <Input
                  placeholder="abc"
                  value={form.login.username}
                  onChange={(event) => setLogin("username", event.target.value)}
                />
              </Field>
              <Field label={t("hosts.password")} help={t("hosts.passwordHelp")}>
                <PasswordInput
                  className="h-8 pr-8 text-xs"
                  placeholder={
                    passwordKept ? t("hosts.passwordSaved") : "••••••••"
                  }
                  value={passwordKept ? "" : form.login.password}
                  onFocus={() => {
                    if (passwordKept) setLogin("password", "");
                  }}
                  onChange={(event) => setLogin("password", event.target.value)}
                />
              </Field>
            </div>
          )}
          {(advanced || token !== "") && (
            <Field label={t("hosts.token")} help={t("hosts.tokenHelp")}>
              <PasswordInput
                className="h-8 pr-8 text-xs"
                aria-label={t("hosts.token")}
                placeholder={tokenKept ? t("hosts.passwordSaved") : ""}
                value={tokenKept ? "" : token}
                onFocus={() => {
                  if (tokenKept) setToken("");
                }}
                onChange={(event) => setToken(event.target.value)}
              />
            </Field>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <Button
              size="sm"
              variant="outline"
              disabled={test.busy}
              onClick={() => void runTest()}
            >
              {test.busy ? t("hosts.testing") : t("hosts.test")}
            </Button>
            {unsaved && !test.text && (
              <span className="text-xs text-muted-foreground">
                {t("hosts.testUnsaved")}
              </span>
            )}
            {test.text && (
              <span
                className={`text-xs ${test.ok ? "text-accent-brand" : "text-destructive"}`}
              >
                {test.text}
              </span>
            )}
          </div>
        </div>
      </SectionCard>
    </>
  );
}
