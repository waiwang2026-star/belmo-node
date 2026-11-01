#!/bin/sh
set -eu
PORT="${PORT:-8080}"
UUID="${UUID:-}"
WS_PATH="${WS_PATH:-/vless}"
if [ -z "$UUID" ]; then echo "UUID env is required" >&2; exit 1; fi
cat > /tmp/xray.json <<EOF
{
  "inbounds": [
    {
      "port": 10000,
      "listen": "127.0.0.1",
      "protocol": "vless",
      "settings": {
        "clients": [{ "id": "$UUID" }],
        "decryption": "none"
      },
      "streamSettings": {
        "network": "ws",
        "wsSettings": { "path": "$WS_PATH" }
      }
    }
  ],
  "outbounds": [{ "protocol": "freedom" }]
}
EOF
cat > /tmp/Caddyfile <<EOF
:$PORT {
	handle / {
		respond "ok" 200
	}
	handle $WS_PATH* {
		reverse_proxy 127.0.0.1:10000
	}
	handle {
		respond 404
	}
}
EOF
/usr/local/bin/xray run -c /tmp/xray.json &
exec caddy run --config /tmp/Caddyfile --adapter caddyfile
