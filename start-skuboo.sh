#!/bin/bash
export SHOPIFY_API_KEY=REDACTED_SHOPIFY_CLIENT_ID
export SHOPIFY_API_SECRET=REDACTED_SHOPIFY_API_SECRET
export SCOPES=read_inventory,read_locations,read_products,write_products
export SHOPIFY_APP_URL=https://skuboo.com
export SESSION_SECRET=REDACTED_SESSION_SECRET
npm run start
