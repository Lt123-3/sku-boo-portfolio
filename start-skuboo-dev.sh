#!/bin/bash
set -e

cd "$(dirname "$0")"

TUNNEL_CONFIG="$HOME/.cloudflared/dev-config.yml"
TUNNEL_LOG="/tmp/skuboo-dev-tunnel.log"

if ! pgrep -f "cloudflared tunnel --config $TUNNEL_CONFIG" > /dev/null; then
  echo "Starting dev.skuboo.com tunnel in background..."
  nohup cloudflared tunnel --config "$TUNNEL_CONFIG" run skuboo-dev > "$TUNNEL_LOG" 2>&1 &
  disown
  sleep 5
else
  echo "dev.skuboo.com tunnel already running."
fi

echo "Starting Shopify dev server pointed at https://dev.skuboo.com:3000 ..."
npm run dev -- --tunnel-url https://dev.skuboo.com:3000
