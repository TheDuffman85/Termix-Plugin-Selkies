# Selkies

Opens Selkies remote desktops in a Termix tab. Desktop audio, keyboard, mouse, clipboard and file
transfer all work in the tab.

## Requirements

The plugin doesn't look for a particular image. It needs a Selkies server that:

- streams in **WebSocket mode**. WebRTC mode can't go through the Termix proxy (see
  [How it works](#how-it-works)).
- serves its web client at its base path (`/`, or the subfolder you set as **Path**) and the stream
  socket at `api/websockets` below it. A plain HTTP GET to that stream path must return `204` when
  WebSocket mode is active.
- has **no login, an HTTP Basic login, or Selkies' secure mode with an access token** (see
  [Other Selkies servers](#other-selkies-servers)). Form, OAuth or cookie logins in front of it aren't
  supported.

Every image built on
[linuxserver/docker-baseimage-selkies](https://github.com/linuxserver/docker-baseimage-selkies) does all
of this out of the box, such as [webtop](https://docs.linuxserver.io/images/docker-webtop/), and it's what
the plugin is tested against. So does [Selkies' own server](https://github.com/selkies-project/selkies),
run from its images, packages or `pip install selkies`. The setup below uses the linuxserver names and
defaults; [Other Selkies servers](#other-selkies-servers) lists what differs.

## Set up a host

1. Edit the host in Termix and turn on **Selkies** under General.
2. Open the **Selkies** section:
   - **Protocol** and **Port**: the linuxserver images serve HTTPS on 3001 and plain HTTP on 3000.
     Keep HTTPS on 3001 unless something in front of the container already handles TLS.
   - **Reach the container**: **Directly from the Termix server**, or **Through this host's SSH
     connection**. Through SSH, the container's port can stay bound to `127.0.0.1` on the host
     (`127.0.0.1:3001:3001` in Docker), and Termix reaches it the same way you would with `ssh -L`.
   - **Path**: the container's `SUBFOLDER`, if it has one.
   - **Username** and **Password**: the container's `CUSTOM_USER` (usually `abc`, used when the field is
     empty) and `PASSWORD`.
3. Save, then press **Test connection**.

Test connection uses the container's HTTP readiness probe to check that WebSocket mode is active.
Open the desktop from the host's connect button, its context menu or the command palette.

**Accept a self-signed certificate** is on by default, because the linuxserver images make their own
certificate. With it on, Termix doesn't check who answers, and it sends the container's login to that
server. On the Direct route, anyone who can intercept traffic between the Termix server and the container
could read that login. Use the SSH route, or give the container a real certificate and turn the setting
off, when that network isn't trusted.

For HTTPS through SSH with certificate verification enabled, the certificate must match the saved host
address. The SSH forward still connects to the container on the host's loopback interface.

## Recommended container settings

```yaml
environment:
  - CUSTOM_USER=abc
  - PASSWORD=change-me # protects the container itself
  - SELKIES_AUDIO_ENABLED=true # desktop audio (on by default)
  - SELKIES_MICROPHONE_ENABLED=true # for Open in browser, see below
ports:
  - "127.0.0.1:3001:3001" # with "Through this host's SSH connection"
```

## Other Selkies servers

Selkies' own server serves the same web client and stream as the linuxserver images, so only the
settings differ. For its
[desktop images](https://github.com/selkies-project/selkies#readme), such as
`ghcr.io/selkies-project/selkies/desktop`:

- **Protocol** and **Port**: HTTPS on `8080`. A server you run yourself serves plain HTTP on `8080`
  unless it was started with `--enable-https`. With HTTPS and its own certificate, keep **Accept a
  self-signed certificate** on.
- **Username** and **Password**: its Basic login, `ubuntu` and the `PASSWD` you set (`mypasswd` unless
  changed). The server takes the user from `CUSTOM_USER`, `USERNAME` or `USER`, and the password from
  `SELKIES_BASIC_AUTH_PASSWORD`, `PASSWORD` or `PASSWD`. Type the username: an empty one means `abc`.
- **Path**: `/` unless something in front of it serves it under a path.
- **Reach the container**: the server listens on `localhost` only unless it was started with `--public`
  (or an address in `SELKIES_ADDR`). Choose **Through this host's SSH connection** to reach it there
  without opening it to the network.

### Secure mode and access tokens

A Selkies server with `SELKIES_MASTER_TOKEN` set runs in secure mode: its stream and other `api/`
routes want a session token. Put one in **Access token** in the host's Selkies login (under Advanced).
Use a session token from the server's token table, from `--tokens-file` or `POST /api/tokens`, not the
master token itself. Give it the `controller` role to use keyboard and mouse.

Termix adds the token on the server, to the container's `api/` requests and the stream, so the browser
never sees it. A Basic login, if the server also has one, is sent as well. **Open in browser** doesn't go
through Termix, so it needs its own token in the address, such as `https://desk.example/#token=...`.

Test connection reports a server in secure mode without a token, or with Basic login off and a wrong
one. With Basic login on, Selkies accepts the page without a token, and a wrong token only shows when
the desktop disconnects.

### WebRTC mode

The plugin needs Selkies' WebSocket mode, the default. A server in WebRTC mode (`--mode webrtc`) answers
Test connection with "not in WebSocket mode". Switch it back to WebSocket mode.

## Start and stop Selkies automatically

This optional setting is off by default. The plugin can start Selkies when you connect and stop it after
no desktop has been connected for a while. It manages one of these per host:

- **Docker container**: an existing container, such as webtop
- **systemd user service**: a unit run by the SSH user's own systemd instance (`systemctl --user`)
- **systemd system service**: a unit run by the host's system systemd instance (`systemctl`)

Set up Selkies on the saved host first, including its ports, login and storage. Then, in the host's
Selkies section:

1. Turn on **Start and stop Selkies automatically**.
2. Choose what **Selkies runs as**.
3. Enter the **Docker container name or ID**, for example `webtop`, or the **systemd service**, for
   example `selkies.service`.
4. Set **Stop after idle (minutes)**, from 1 to 1440 minutes (default 10).
5. Save the host, then open the desktop or press **Test connection**.

The plugin runs the start command through the host's saved SSH connection, then waits up to 60 seconds
for Selkies to answer. This SSH connection is needed even when **Reach the container** is set to
**Directly from the Termix server**. The plugin uses Termix's existing SSH credentials, host key checks,
host access rules and connect policy; it does not need access to the Termix server's Docker socket.
Names are checked before use and are never run as shell code, so the plugin only accepts plain container
names and IDs, and plain unit names (letters, digits and `:_.@-`, not starting with `-`).

If startup reports an untrusted or changed SSH host key, open a normal SSH terminal for **the same host
entry** in Termix. Verify its fingerprint before trusting the key, then reconnect to Selkies. Trusting a
different host entry for the same machine may not satisfy this check.

### Docker container

The plugin runs [`docker container start`](https://docs.docker.com/reference/cli/docker/container/start/)
and, when idle, [`docker container stop`](https://docs.docker.com/reference/cli/docker/container/stop/)
with a 30-second grace period. It stops the existing container without removing it or its volumes.
Docker must be installed on the host, and its SSH user must be able to run Docker without an interactive
`sudo` prompt.

### systemd service

Use this for Selkies installed directly on the machine. Put whatever starts your desktop session and
Selkies into a unit, so `systemctl start` brings it up and `systemctl stop` shuts it down. The plugin runs
`systemctl --user start <unit>` or `systemctl --no-ask-password start <unit>`, and the matching `stop`
when idle. `systemctl stop` waits for the unit's own stop timeout (`TimeoutStopSec`, 90 seconds by
default); the plugin gives the command up to 120 seconds.

A **systemd user service** runs as the SSH user. Turn on lingering for that user, so its systemd instance
and the service keep running after the plugin's SSH command ends:

```bash
sudo loginctl enable-linger <ssh-user>
```

A minimal user unit, in `~/.config/systemd/user/selkies.service`:

```ini
[Unit]
Description=Selkies remote desktop

[Service]
# The command or script you use to start your desktop session and Selkies.
ExecStart=/home/<ssh-user>/bin/start-selkies
Restart=on-failure

[Install]
WantedBy=default.target
```

Run `systemctl --user daemon-reload` after adding it. It doesn't need to be enabled, since the plugin
starts it.

A **systemd system service** is started with `systemctl` as the SSH user, never with a password prompt.
That works when the SSH user is `root`, or when a polkit rule lets it manage this one unit. For example,
in `/etc/polkit-1/rules.d/50-selkies.rules`:

```js
polkit.addRule(function (action, subject) {
  if (
    action.id == "org.freedesktop.systemd1.manage-units" &&
    action.lookup("unit") == "selkies.service" &&
    subject.user == "<ssh-user>"
  ) {
    return polkit.Result.YES;
  }
});
```

### Idle shutdown

Idle means **no connected desktops through this plugin**, rather than no keyboard or mouse input.
All plugin users and tabs for that host share the timer. An open desktop stream or an active file
transfer keeps Selkies running. When the last connection ends, the idle timer starts; reconnecting
resets it. Cleanup runs every 15 seconds, so shutdown may happen up to 15 seconds after the timeout.
Test connection also starts Selkies and leaves it subject to this idle timer.

Save work before disconnecting: applications in the desktop exit when it stops. Old plugin session
links expire on shutdown; reopen or reconnect the Termix tab to start Selkies again.

Use one Termix host entry per managed container or service. Connections made outside the plugin,
including **Open in browser** links to Selkies' own address, cannot keep the idle timer alive. The mobile
app's **Open desktop** link goes through the plugin and does count. Turning automatic management off,
or changing what Selkies runs as or its name, leaves the previous container or service running for you
to manage yourself.

While a managed container or service may still be running, the plugin asks Termix to keep its process
running, so the idle timer is not lost when Termix stops idle plugins. It also saves what it manages.
After a Termix restart the timer starts again from the restart, so Selkies left running is still
stopped. While the plugin is disabled in Termix, shutdown waits until it is enabled again. A failed
stop is logged and retried after another idle interval, using the last connecting user's permissions.
If that user loses SSH/connect access, stop Selkies yourself or reconnect as a user who still has
access.

## Microphone, gamepads and fullscreen

Termix runs plugin views in a locked-down frame and allows no microphone, gamepads, fullscreen
or pointer lock there. The tab has video, desktop audio, keyboard, mouse and clipboard. For the
rest, turn on **Open in browser** in the host's Selkies section (it's off by default, under
Advanced). The tab then has an **Open in browser** button that opens the container's own page in a
new browser tab, where the Selkies client has everything.

That page doesn't go through Termix. Your browser connects to the container itself and you sign in
with the container's login, so it only works where your browser can reach the container: on the same
network, or over a VPN. The Termix tab has no such limit, because only the Termix server talks to the
container. Leave **Address for Open in browser** empty to use the host's address with the section's
protocol, port and path. Set it when your browser reaches the container under another address, like a
reverse proxy or a VPN name.

## Mobile app

The Termix Android and iOS apps show the Selkies tab too: open it from a host with Selkies turned on.
The app can't show the desktop inside itself, so the tab has an **Open desktop** button that opens it in
your phone's browser. The browser needs to be able to reach your Termix server and plays audio through
the same proxy. Anyone with the link can use it while the session is active. The link stops working
when you close the tab in the app or press **Reconnect**. Set up
hosts in the web or desktop app, since the mobile app has no host editor for plugins.

## How it works

The Termix server proxies the container's web client and its stream, and adds the container's
login on the way, so the password never reaches the browser. Each opened tab gets its own
random session link. It ends when the tab closes, after 10 minutes without use, or at most
after 12 hours. Each user can have up to 20 desktops open; opening another ends their oldest. If the
server's limit of 500 is reached, a new desktop only replaces one with no open stream, and is
refused when every desktop is in use. Termix's own login never reaches the container: the desktop page always runs
sandboxed, even opened on its own.

Termix rechecks the user who opened the desktop. A new WebSocket connection gets a fresh check.
HTTP requests reuse the last successful check for up to 15 seconds, and active streams are checked
every 15 seconds. If the user loses permission to connect, a connect-policy approval expires or is
revoked, or Selkies is turned off for that host, the plugin closes the session and its streams. The
`users:impersonate` capability lets the plugin run these audited checks as the original user.

The stream is Selkies' WebSocket mode, the default for the linuxserver images. WebRTC mode
sends media straight between the browser and the container, which the Termix proxy can't
carry, so use WebSocket mode with this plugin.

## Troubleshooting

- **Docker or systemd startup is blocked**: follow the SSH host key instructions in the error. Automatic
  startup needs SSH even with the Direct desktop route. For other startup failures, test this host
  entry's normal SSH terminal, then check the container or unit name and the SSH user's permissions:
  Docker access, lingering for a systemd user service, or root or a polkit rule for a system service.
- **The container did not answer**: check the address, port and route with **Test
  connection**. With HTTPS, keep **Accept a self-signed certificate** on unless the container
  has a real certificate.
- **The container refused the login**: the username or password doesn't match the container's
  `CUSTOM_USER` and `PASSWORD`. On Selkies' own images, the username is `ubuntu`, not the empty default.
- **Secure mode wants an access token**: the server has a master token. Set **Access token** as in
  [Secure mode and access tokens](#secure-mode-and-access-tokens).
- **Not in WebSocket mode**: the server streams over WebRTC, which the Termix proxy can't carry. See
  [WebRTC mode](#webrtc-mode).
- **No sound**: click into the desktop once. Browsers start audio only after a click on the page.
