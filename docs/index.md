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
- has **no login, or an HTTP Basic login**. Form, OAuth or cookie logins in front of it aren't
  supported.

Every image built on
[linuxserver/docker-baseimage-selkies](https://github.com/linuxserver/docker-baseimage-selkies) does all
of this out of the box, such as [webtop](https://docs.linuxserver.io/images/docker-webtop/), and it's what
the plugin is tested against. Other Selkies servers work if they serve the same layout. The setup below
uses the linuxserver names.

## Set up a host

1. Edit the host in Termix and turn on **Selkies** under General.
2. Open the **Selkies** section:
   - **Protocol** and **Port**: the linuxserver images serve HTTPS on 3001 and plain HTTP on 3000.
     Keep HTTPS on 3001 unless something in front of the container already handles TLS.
   - **Reach the container**: **Directly from the Termix server**, or **Through this host's SSH
     connection**. Through SSH, the container's port can stay bound to `127.0.0.1` on the host
     (`127.0.0.1:3001:3001` in Docker), and Termix reaches it the same way you would with `ssh -L`.
   - **Path**: the container's `SUBFOLDER`, if it has one.
   - **Username** and **Password**: the container's `CUSTOM_USER` (usually `abc`) and `PASSWORD`.
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

## Start and stop Docker automatically

This optional setting is off by default. Set up a persistent Selkies container on the saved host first,
including its image, ports, login and volumes. In the host's Selkies section:

1. Turn on **Start and stop Docker automatically**.
2. Enter its **Docker container name or ID**, for example `webtop`.
3. Set **Stop after idle (minutes)**, from 1 to 1440 minutes (default 10).
4. Save the host, then open the desktop or press **Test connection**.

The plugin runs [`docker container start`](https://docs.docker.com/reference/cli/docker/container/start/)
through the host's saved SSH connection, then waits up to 60 seconds for Selkies to answer. Docker must
be installed on that host, and its SSH user must be able to run Docker without an interactive `sudo`
prompt. This SSH connection is needed even when **Reach the container** is set to **Directly from the
Termix server**. The plugin uses Termix's existing SSH credentials, host key checks, host access rules
and connect policy; it does not need access to the Termix server's Docker socket.

If Docker startup reports an untrusted or changed SSH host key, open a normal SSH terminal for
**the same host entry** in Termix. Verify its fingerprint before trusting the key, then reconnect to
Selkies. Trusting a different host entry for the same machine may not satisfy this check.

Idle means **no connected desktops through this plugin**, rather than no keyboard or mouse input.
All plugin users and tabs for that host share the timer. An open desktop stream or an active file
transfer keeps the container running. When the last connection ends, the idle timer starts; reconnecting
resets it. Cleanup runs every 15 seconds, so shutdown may happen up to 15 seconds after the timeout.
Test connection also starts the container and leaves it subject to this idle timer.

Shutdown runs [`docker container stop`](https://docs.docker.com/reference/cli/docker/container/stop/)
with a 30-second grace period. It stops the existing container without removing it or its volumes.
Save work before disconnecting: applications in the container exit when it stops. Old plugin session
links expire on shutdown; reopen or reconnect the Termix tab to start the container again.

Use one Termix host entry per managed container. Connections made outside the plugin, including
**Open in browser** links to the container's own address, cannot keep the idle timer alive. The mobile
app's **Open desktop** link goes through the plugin and does count. Turning automatic management off
or changing the container name leaves the previous container running for you to manage yourself.

While a managed container may still be running, the plugin asks Termix to keep its process running, so
the idle timer is not lost when Termix stops idle plugins. It also saves which containers it manages.
After a Termix restart the timer starts again from the restart, so a container left running is still
stopped. While the plugin is disabled in Termix, shutdown waits until it is enabled again. A failed
stop is logged and retried after another idle interval, using the last connecting user's permissions.
If that user loses SSH/connect access, stop the container yourself or reconnect as a user who still has
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

- **Docker startup is blocked**: follow the SSH host key instructions in the error. Docker control
  needs SSH even with the Direct desktop route. For other startup failures, test this host entry's
  normal SSH terminal, then check the container name and the SSH user's Docker permissions.
- **The container did not answer**: check the address, port and route with **Test
  connection**. With HTTPS, keep **Accept a self-signed certificate** on unless the container
  has a real certificate.
- **The container refused the login**: the username or password doesn't match the container's
  `CUSTOM_USER` and `PASSWORD`.
- **No sound**: click into the desktop once. Browsers start audio only after a click on the page.
