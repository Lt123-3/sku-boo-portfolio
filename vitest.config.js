import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

// Deliberately separate from vite.config.js: that config's reactRouter()
// plugin pulls in SSR / route-manifest machinery Vitest has no need for.
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: { environment: "node", setupFiles: ["./vitest.setup.js"] },
});
