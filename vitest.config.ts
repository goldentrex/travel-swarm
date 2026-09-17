// Pure-logic tests: no DOM, no network. Every provider is stubbed at the
// fetch boundary, so `npm test` runs offline and needs no API keys.
import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "html", "lcov"],
      // Include untested implementation files too; do not report only the
      // modules loaded by a passing test. Authorship is a separate claim.
      include: ["src/**/*.ts", "workers/**/*.ts"],
      exclude: ["**/*.test.ts", "**/__tests__/**", "**/*.d.ts"],
    },
  },
});
