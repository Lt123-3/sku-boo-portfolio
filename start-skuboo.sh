#!/bin/bash
# NOTE: real secret values redacted for the `review` branch — placeholders only.
# See .env.example for what each variable is. Fill these in locally; never commit real values.
export SHOPIFY_API_KEY=YOUR_SHOPIFY_API_KEY
export SHOPIFY_API_SECRET=shpss_YOUR_SHOPIFY_API_SECRET
export SCOPES=read_inventory,read_locations,read_products,write_products
export SHOPIFY_APP_URL=https://skuboo.com
export SESSION_SECRET=YOUR_SESSION_SECRET
npm run start
