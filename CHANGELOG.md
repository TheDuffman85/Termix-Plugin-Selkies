# Changelog

## 0.1.0

### Added

- Selkies desktops in WebSocket mode (webtop and other docker-baseimage-selkies images) in a Termix tab, with desktop audio
- Reaches the container directly or through the host's SSH connection
- The container's login is kept by Termix and added on the server, never sent to the browser
- Open in browser, for microphone, gamepads and fullscreen, turned on per host (off by default)
- Test connection in the host editor
- Shows in the Termix mobile app, opened from a host; the desktop opens in the phone's browser

### Fixed

- Test connection and launch use Selkies' HTTP readiness probe so that the browser's WebSocket can connect immediately
- Closed sessions disconnect the browser WebSocket through Termix's sandbox bridge
- HTTPS through SSH verifies the certificate against the saved host address
- Requires Plugin API 2.7 for shell state in web frames

### Security

- Rechecks Termix host access and connect policy, and closes active desktop streams when access ends
- Caps the size of decompressed desktop HTML
