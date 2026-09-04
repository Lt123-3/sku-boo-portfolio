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

# NOTE: real secret values redacted for the `review` branch — placeholders only.
# See .env.example for what each variable is.
export SHOP_DOMAIN=your-dev-store.myshopify.com
export ESP_API_TOKEN=YOUR_DEV_ESP_API_TOKEN
export SHIPPO_API_KEY=shippo_test_YOUR_SHIPPO_TEST_KEY
export SHIP_FROM_NAME="Shipping Desk"
export SHIP_FROM_STREET1="123 Example St"
export SHIP_FROM_CITY="Anytown"
export SHIP_FROM_STATE=CA
export SHIP_FROM_ZIP=00000

# ESP32 shipping-desk relay — same as production's copy in start-skuboo.sh,
# just pointed at the dev store via SHOP_DOMAIN above.
node esp-server.js &
ESP_PID=$!
trap "kill $ESP_PID 2>/dev/null" EXIT

echo "Starting Shopify dev server pointed at https://dev.skuboo.com:3000 ..."
npm run dev -- --tunnel-url https://dev.skuboo.com:3000
