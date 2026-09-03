#!/bin/bash
# NOTE: real secret values redacted for the `review` branch — placeholders only.
# See .env.example for what each variable is. Fill these in locally; never commit real values.
export SHOPIFY_API_KEY=YOUR_SHOPIFY_API_KEY
export SHOPIFY_API_SECRET=shpss_YOUR_SHOPIFY_API_SECRET
export SCOPES=write_products,read_products,read_locations,read_inventory,write_files,read_orders,read_customers,write_inventory
export SHOPIFY_APP_URL=https://skuboo.com
export SHOP_DOMAIN=your-store.myshopify.com
export SESSION_SECRET=YOUR_SESSION_SECRET
export EXTENSION_API_TOKEN=YOUR_EXTENSION_API_TOKEN
export ESP_API_TOKEN=YOUR_ESP_API_TOKEN
# Test key — no real charges, swap for a shippo_live_... key when ready.
export SHIPPO_API_KEY=shippo_test_YOUR_SHIPPO_TEST_KEY
export SHIP_FROM_NAME="Shipping Desk"
export SHIP_FROM_STREET1="123 Example St"
export SHIP_FROM_CITY="Anytown"
export SHIP_FROM_STATE=CA
export SHIP_FROM_ZIP=00000

# ESP32 shipping-desk relay — LAN-only WebSocket server, separate process
# from the main app (see esp-server.js for why). Killed automatically when
# this script exits, so it never lingers as an orphaned process.
node esp-server.js &
ESP_PID=$!
trap "kill $ESP_PID 2>/dev/null" EXIT

npm run start
