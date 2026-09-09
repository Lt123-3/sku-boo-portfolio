import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";
import react from "@vitejs/plugin-react";

// Deliberately separate from vite.config.js: that config's reactRouter()
// plugin pulls in SSR / route-manifest machinery Vitest has no need for.
//
// Default environment stays "node" for the lib server-helper tests. Tests that
// need a DOM (the hook tests under app/hooks/) opt in with a
// `// @vitest-environment jsdom` docblock at the top of the file.
export default defineConfig({
  plugins: [tsconfigPaths(), react()],
  test: { environment: "node", setupFiles: ["./vitest.setup.js"] },
});
