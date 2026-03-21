# Realtime Deploy

`paratui` now has a standalone realtime service for discovery and WebRTC signaling.

## Current Shape

- `paratui-signal` runs as its own systemd service.
- It listens on `127.0.0.1:8788`.
- Caddy proxies `http://paratui.slopstation.ai` to that local port.
- `coturn` runs on `3478` for TURN and STUN.
- `slopstation.ai -> localhost:8090` is unchanged.
- `sharkey` on `8080` is unchanged.

## Why This Is Separate

- `slopstation` and `kidcomp` stay isolated from `paratui` chat experiments.
- The signaling server can evolve without touching the KidShell binary.
- TURN can be managed independently from the TUI app itself.

## Auth Mode

The deployed droplet currently uses **development bearer tokens** from:

- `/opt/paratui-signal/dev-tokens.json`

This is intentional for now. The local reference test server supports bearer introspection through `/api/profile`, but the live `slopstation` stack does not expose the same contract yet.

When `parascene` or another upstream identity service exposes a stable bearer introspection endpoint, switch the signal service to:

- `PARATUI_SIGNAL_AUTH_BASE_URL=https://...`

and remove the dev token file.

## Runtime Files

- service unit: `/etc/systemd/system/paratui-signal.service`
- env file: `/opt/paratui-signal/paratui-signal.env`
- caddy config: `/etc/caddy/Caddyfile`
- coturn config: `/etc/turnserver.conf`

## Verification

Local integration coverage:

- bearer auth over websocket
- room presence
- direct chat relay
- offer relay for WebRTC signaling
- TURN credential minting
- probe script against a live server

Useful checks:

```bash
npm test
```

```bash
curl --resolve paratui.slopstation.ai:80:165.227.95.55 http://paratui.slopstation.ai/health
```

```bash
ssh root@165.227.95.55 'systemctl status paratui-signal coturn slopstation sharkey --no-pager'
```

Useful TUI commands:

```text
/realtime/connect room=noir
/realtime/room/chat text="hello room"
/realtime/dm/send @crosshj text="quiet ping"
/realtime/signal/send @crosshj type=offer payload="mock-sdp" call=call-1
/realtime/disconnect
```

## Next Upgrade

The next clean step is to point DNS for `paratui.slopstation.ai` at the droplet and switch the Caddy block from `http://paratui.slopstation.ai` to a normal HTTPS site block so Caddy can issue a public cert.
