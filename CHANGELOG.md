# Changelog

## 0.1.0

### Added

- Optional per-host Docker startup over SSH and shutdown after a configurable idle time with no connected desktops
- Selkies desktops in WebSocket mode (webtop and other docker-baseimage-selkies images) in a Termix tab, with desktop audio
- Reaches the container directly or through the host's SSH connection
- The container's login is kept by Termix and added on the server, never sent to the browser
- Open in browser, for microphone, gamepads and fullscreen, turned on per host (off by default)
- Test connection in the host editor
- Shows in the Termix mobile app, opened from a host; the desktop opens in the phone's browser

### Fixed

- Docker idle shutdown keeps running when Termix would stop the idle plugin process, and resumes after a Termix restart
- Docker startup errors explain SSH host key verification and Docker access requirements, including with the Direct desktop route
- Test connection and launch use Selkies' HTTP readiness probe so that the browser's WebSocket can connect immediately
- Closed sessions disconnect the browser WebSocket through Termix's sandbox bridge
- HTTPS through SSH verifies the certificate against the saved host address
- Requires Plugin API 2.7 for shell state in web frames
- A Docker stop that fails because the connecting user can't be acted as anymore is retried after the idle interval instead of every 15 seconds
- Launch stops waiting for the container, and opens no session, once the browser has dropped the request
- The desktop stream answers 504 when the container doesn't answer its WebSocket upgrade within 30 seconds
- Queries reach the container exactly as the client wrote them, and file downloads keep their size
- Desktop HTML in an encoding the proxy can't read is refused instead of sent garbled
- Port and idle minutes in the host editor only save whole numbers in range
- Disconnect shows that the desktop is disconnected rather than an error, and switching language no longer reconnects it
- The host editor notes when Test connection would use saved settings that differ from the form

### Security

- Rechecks Termix host access and connect policy, and closes active desktop streams when access ends
- Caps the size of decompressed desktop HTML
- Refuses escaped slashes and empty path segments, so refused Selkies routes can't be reached under another spelling
- Each user has at most 20 open desktops, and a new desktop never ends another user's live one
