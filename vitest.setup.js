// vitest.setup.js
//
// Runs once per test worker before any test file (see vitest.config.js's
// `setupFiles`). crypto.server.js's getKey() requires
// AI_SETTINGS_ENCRYPTION_KEY to be a base64 string that decodes to exactly
// 32 bytes (AES-256). Provide a fixed throwaway key here so the
// encrypt/decrypt tests don't depend on a real .env value.

import { Buffer } from "node:buffer";

process.env.AI_SETTINGS_ENCRYPTION_KEY = Buffer.alloc(32, 0x2a).toString("base64");
