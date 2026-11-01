# belmo-node

Personal VLESS over WebSocket node template for a PaaS web service
such as Belmo. The platform terminates TLS at the edge, so the proxy
itself runs plain WebSocket internally.

Configuration comes only from environment variables. No secrets are
stored in this repo.

- `UUID`: the VLESS user id, required. Set it in the platform dashboard.
- `WS_PATH`: WebSocket path, default `/vless`.
- `PORT`: the port the platform routes to. The Node launcher defaults
  to 3000 when unset; the Docker start script defaults to 8080.

Health check: `GET /` answers 200 with `ok`. The proxy lives at
`WS_PATH` over WebSocket. Clients use type ws, security tls, with the
platform domain as SNI and host.

## Free tier path (Node)

`package.json` plus `launcher.js` (Node standard library only, no
dependencies). The launcher downloads Xray on first start, writes its
config from the environment, spawns it, and proxies WebSocket upgrades
to it. This path needs no Dockerfile build.

## Docker path (needs a paid tier on Belmo)

`Dockerfile` plus `start.sh` run Caddy in front of Xray. Belmo
requires its Pro plan for Dockerfile builds, so this path is not used
on the free tier.
