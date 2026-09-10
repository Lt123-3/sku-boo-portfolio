// app/config.js

// ── SKU Metafield ─────────────────────────────────────────────────────────────
export const METAFIELD_NAMESPACE = "custom";
export const METAFIELD_KEY = "next_sku";

// ── Product Defaults ──────────────────────────────────────────────────────────
export const DEFAULT_SKU_START = 1000;
export const DEFAULT_PRICE = "19.99";
export const DEFAULT_VENDOR = "0";
export const PRODUCT_HANDLE_PREFIX = "item-";

// ── App Settings ──────────────────────────────────────────────────────────────
export const LOG_PAGE_SIZE = 50;
export const REFRESH_ROUTE = "/app?index";

// app constants / validation checks

export const SKU_STATUS = {
  FREE:     "free",
  ACTIVE:   "active",
  RESERVED: "reserved",
  PROBLEM:  "problem",
  DELETED:  "deleted",
}

export const ACCESS_ROLES = {
  VIEWER:   "viewer",
  OPERATOR: "operator",
  ADMIN:    "admin",
}

export const SKU_PROBLEMS = {
  NO_SKU:        "no_sku",        // no valid 6-digit SKU
  NO_TITLE:      "no_title",      // no title at all
  NO_TITLE_SKU:  "no_title_sku",  // has title body but missing number prefix
  NO_TITLE_BODY: "no_title_body", // has number prefix but no body (unused SKU?)
  NO_PIC:        "no_pic",        // 0 image-type media
  LOW_PIC:       "low_pic",       // 1–2 image-type media
  NO_PREP:       "no_prep",
}