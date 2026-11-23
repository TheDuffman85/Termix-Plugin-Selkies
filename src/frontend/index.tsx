import { MonitorPlay } from "lucide-react";
import type { Ref } from "react";
import type {
  PluginHostRecord,
  StandaloneViewProps,
  TabProps,
  TermixApp,
} from "@termix-ssh/plugin-sdk/frontend";
import { HostEditorSelkiesSection } from "./HostEditorSelkiesSection";
import { SelkiesTab } from "./SelkiesTab";
import {
  DEFAULT_PORT,
  ENABLE_KEY,
  PLUGIN_ID,
  PORT_KEY,
  selkiesEnabled,
  setApp,
} from "./selkies-api";

const ORDER = 120;

function SelkiesHostTab({ host, isVisible, handleRef }: TabProps) {
  return (
    <SelkiesTab
      hostId={host?.id}
      isVisible={isVisible}
      handleRef={handleRef as Ref<unknown>}
    />
  );
}

function SelkiesStandalone({ hostId }: StandaloneViewProps) {
  return <SelkiesTab hostId={hostId} />;
}

export function activate(app: TermixApp): void {
  setApp(app);
  app.onDispose(() => setApp(null));

  const when = (host: PluginHostRecord) => selkiesEnabled(host);

  app.registerTab(PLUGIN_ID, SelkiesHostTab, {
    icon: MonitorPlay,
    titleKey: "tab.title",
    requiresHost: true,
    noHostMessageKey: "tab.noHost",
    persistent: true,
    session: true,
    restore: when,
    activityTypes: [PLUGIN_ID],
    standalone: SelkiesStandalone,
  });

  app.registerHostProtocol({
    id: PLUGIN_ID,
    settingKey: ENABLE_KEY,
    portKey: PORT_KEY,
    defaultPort: DEFAULT_PORT,
    titleKey: "hosts.title",
    descriptionKey: "hosts.description",
    icon: MonitorPlay,
    order: ORDER,
  });

  app.registerHostAction({
    id: PLUGIN_ID,
    titleKey: "tab.title",
    icon: MonitorPlay,
    kind: "connect",
    priority: 30,
    order: ORDER,
    tabType: PLUGIN_ID,
    copyUrlView: PLUGIN_ID,
    when,
  });

  app.registerPaletteEntry({
    id: `${PLUGIN_ID}.open`,
    titleKey: "tab.palette",
    icon: MonitorPlay,
    keywords: ["selkies", "desktop", "webtop"],
    scope: "host",
    when: (host) => !!host && when(host),
    run: (shell, host) => {
      if (host) shell.openTab(host, PLUGIN_ID);
    },
  });

  app.registerHostEditorSection({
    id: PLUGIN_ID,
    group: "top",
    titleKey: "hosts.title",
    icon: MonitorPlay,
    order: ORDER / 5,
    visible: (protocols) => !!protocols[ENABLE_KEY],
    simple: true,
    component: HostEditorSelkiesSection,
  });
}
