# Termix Plugin: Selkies

A [Termix](https://github.com/Termix-SSH/Termix) plugin that opens [Selkies](https://docs.selkies.io/)
remote desktops in a Termix tab. It works with Selkies servers in WebSocket mode: every image built on
[linuxserver/docker-baseimage-selkies](https://github.com/linuxserver/docker-baseimage-selkies), such as
[webtop](https://docs.linuxserver.io/images/docker-webtop/), [Selkies' own](https://github.com/selkies-project/selkies)
server and images, and other servers with the same layout. Its defaults match the linuxserver images.

- Video, desktop audio, keyboard, mouse, clipboard and file transfer in the tab
- Reaches the container directly from the Termix server, or through the host's SSH connection, so the
  container can stay bound to `127.0.0.1`
- The container's login stays in Termix and is added on the server; the browser never sees it. That
  includes a Selkies access token for servers in secure mode
- **Open in browser** for the microphone, gamepads and fullscreen, which Termix doesn't allow inside plugin
  tabs. Off by default; turn it on per host
- Works from the Termix mobile app too, which opens the desktop in the phone's browser
- Optional startup on connect and shutdown after a configurable time with no connected desktops, for a
  Docker container or a systemd service on the machine, with **Restart desktop** and **Stop desktop** in the tab

See [docs/index.md](docs/index.md) for setup and recommended container settings.

## Requirements

- Termix 26.11.2 or newer with Plugin API 2.7 or newer in the 2.x series
- A Selkies server in WebSocket mode (the default) that serves its web client at its base path and the
  stream at `api/websockets` below it, with no login, an HTTP Basic login or an access token. See
  [docs/index.md](docs/index.md#requirements) for details

## Install

Once released, an admin installs it from **Plugins → Browse** with the community registry turned on. To try
a build before that, turn on Plugin developer mode in Termix (Settings, General), then either:

```bash
npm install
npm run build && npm run pack   # install the .tmxplug from Plugins, Install from file
# or
npx termix-plugin dev --server http://localhost:8080 --key tmx_...
```

[dev/docker-compose.yml](dev/docker-compose.yml) starts a local Termix and a webtop desktop to try it
against.

## Development

```bash
npm test             # backend and frontend tests
npm run typecheck
npm run validate     # manifest, docs, changelog
npm run build
npm run format
```

## License

Apache-2.0
