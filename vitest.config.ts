import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "flingit/runtime/migrate": path.resolve(
        __dirname,
        "node_modules/flingit/dist/runtime/migrate.js",
      ),
    },
  },
  test: {
    include: ["src/worker/**/*.test.ts"],
    // The worker tests share one local SQLite DB, so files must not run in
    // parallel (each file's beforeEach truncates the shared tables).
    fileParallelism: false,
  },
});
