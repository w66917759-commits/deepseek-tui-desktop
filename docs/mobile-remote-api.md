# Mobile Remote API

DeepSeek TUI Desktop remains the runtime host. The Mac keeps running Electron, the harness, PTY, and DeepSeek TUI; mobile clients only observe progress and, when explicitly allowed, send control commands to the desktop session.

For public mobile use, phones do not connect to `127.0.0.1` or a user-provided public Bridge URL. The desktop connects outbound to DeepSeek TUI Relay over WebSocket, and the phone connects to the same Relay over HTTPS. The local HTTP Bridge remains available for development and LAN diagnostics only.

## Security Model

- V1 pairing uses only a six digit pairing code. Email/account id is legacy metadata and is not required for pairing.
- Pairing codes are one-time, valid for ten minutes, and stored as hashes before they are sent to Relay.
- Successful pairing returns a long-lived `deviceToken` to the phone. The desktop and Relay store only token hashes.
- Read-only status and remote control remain separate: paired devices can refresh status, but session start/stop/input requires `mobileRemoteControlEnabled`.
- The desktop never exposes API keys to Relay or mobile clients. Mobile-started sessions use saved desktop settings and process environment.

## Relay API

### Desktop Connect

```http
WSS /desktop/connect?desktopId=<desktop-id>&secret=<relay-secret>
```

The desktop sends:

```json
{
  "type": "desktop.hello",
  "desktopId": "desktop_xxx",
  "secret": "local-relay-secret",
  "status": {}
}
```

When the user generates a pairing code, the desktop sends:

```json
{
  "type": "pairing.start",
  "desktopId": "desktop_xxx",
  "relaySessionId": "relay_xxx",
  "codeHash": "sha256-hex",
  "codePreview": "123 456",
  "expiresAt": "2026-05-20T10:10:00.000Z",
  "createdAt": "2026-05-20T10:00:00.000Z"
}
```

Relay replies to the desktop with `device.paired` after the phone pairs. The payload includes public device metadata and a device-token hash, never the raw token.

### Pair Phone

```http
POST /api/v1/pair
content-type: application/json

{
  "pairingCode": "123456",
  "deviceName": "West iPhone",
  "platform": "web",
  "clientDeviceId": "web-installation-id"
}
```

Returns:

```json
{
  "ok": true,
  "deviceToken": "phone-secret-token",
  "deviceId": "device_xxx",
  "desktopId": "desktop_xxx",
  "relaySessionId": "relay_xxx"
}
```

### Status And Commands

Phone requests use:

```http
Authorization: Bearer <device-token>
```

Endpoints:

- `GET /api/v1/status`
- `POST /api/v1/session/start`
- `POST /api/v1/session/stop`
- `POST /api/v1/terminal/input`

Relay forwards command messages to the paired desktop WebSocket and returns the desktop result. Relay does not execute DeepSeek TUI.

## Desktop Local Bridge

The local bridge still exposes development endpoints such as:

- `GET /api/v1/status`
- `GET /api/v1/events`
- `POST /api/v1/auth/pairing/start`
- `POST /api/v1/auth/pair`
- `POST /api/v1/session/start`
- `POST /api/v1/session/stop`
- `POST /api/v1/terminal/input`

These endpoints are token-protected and are intended for same-machine or same-LAN testing. Public mobile UX should use Relay and should not ask users to paste `127.0.0.1`, LAN IPs, or HTTPS tunnel URLs.

## Local Storage

Desktop `remote-auth.json` stores:

- `desktopId`
- `activePairing`
- `devices[]`
- `relaySecret`
- `lastRelayState`
- optional legacy `account`

Phone local storage stores:

- `relayUrl`
- `deviceToken`
- `deviceId`
- `desktopId`
- `deviceName`
- `clientDeviceId`

## Phone App Flow

1. User enables mobile control in the desktop `远程` panel.
2. Desktop connects to Relay and shows Relay status.
3. User generates a six digit pairing code.
4. Phone opens the mobile page and enters only the pairing code plus device name.
5. Relay validates the code hash, binds the phone to the desktop session, returns `deviceToken`, and notifies the desktop with the token hash.
6. Phone refreshes status through Relay.
7. If desktop remote control is enabled, the phone can start/stop sessions and send terminal input through Relay.
