# belmo-node

Personal VLESS over WebSocket node template for a PaaS web service
such as Belmo. The platform terminates TLS at the edge, so the proxy
itself runs plain WebSocket internally.

Configuration comes only from environment variables. No secrets are
stored in this repo.

- `UUID`: the VLESS user id, required. Set it in the platform dashboard.
- `WS_PATH`: WebSocket path, default `/vless`.
- `PORT`: the port the platform routes to, default `8080`.

Health check: `GET /` answers 200 with `ok`. The proxy lives at
`WS_PATH` over WebSocket. Clients use type ws, security tls, with the
platform domain as SNI and host.
