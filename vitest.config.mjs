import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "server-only": path.join(repositoryRoot, "tests", "server-only-stub.ts"),
      "@": path.join(repositoryRoot, "src"),
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["tests/setup.ts"],
    testTimeout: 20_000,
    coverage: {
      include: ["src/**/*.{ts,tsx}", "tools/**/*.mjs"],
      reporter: ["text", "json", "html"],
    },
    include: ["tests/**/*.test.{mjs,ts,tsx}"],
  },
});
