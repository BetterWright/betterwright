import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    coverage: {
      include: ["src/**/*.ts", "public/viewer-crypto.js"],
      reporter: ["text", "json-summary"],
    },
  },
});
