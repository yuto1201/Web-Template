import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      include: ["tools/**/*.mjs"],
      reporter: ["text", "json", "html"],
    },
    include: ["tests/**/*.test.mjs"],
  },
});
