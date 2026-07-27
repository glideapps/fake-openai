import { defineConfig, type Plugin } from "vite";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Keeps `src/worker/readme-generated.ts` in sync with `README.md`.
 *
 * The worker serves /docs as server-rendered HTML, and Cloudflare Workers can't
 * read files at runtime — so the README is embedded into the worker bundle as a
 * generated TS module. This plugin regenerates it on every `vite build` (which
 * `fling it` runs) and whenever the dev server starts or README.md changes, so
 * editing README.md and redeploying is all that's needed. Never edit the
 * generated file by hand.
 */
function readmePlugin(): Plugin {
  const readmePath = resolve(__dirname, "README.md");
  const outPath = resolve(__dirname, "src/worker/readme-generated.ts");

  const generate = () => {
    const md = readFileSync(readmePath, "utf8");
    const body =
      "// GENERATED FILE — do not edit. Produced from README.md by the\n" +
      "// readme plugin in vite.config.ts. Edit README.md instead.\n\n" +
      `export const README_MARKDOWN = ${JSON.stringify(md)};\n`;
    // Avoid rewriting (and retriggering watchers) when nothing changed.
    try {
      if (readFileSync(outPath, "utf8") === body) return;
    } catch {
      /* file does not exist yet */
    }
    writeFileSync(outPath, body);
  };

  return {
    name: "fake-openai-readme",
    buildStart: generate,
    configureServer(server) {
      generate();
      server.watcher.add(readmePath);
      server.watcher.on("change", (file) => {
        if (resolve(file) === readmePath) generate();
      });
    },
  };
}

export default defineConfig({
  base: process.env["VITE_BASE"] || "/",
  plugins: [readmePlugin(), tailwindcss(), react()],
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
  },
  server: {
    port: parseInt(process.env["FLING_VITE_PORT"] || "5173", 10),
    strictPort: true,
    watch: {
      ignored: ["**/.fling/**"],
    },
    proxy: {
      "/api": {
        target: `http://localhost:${process.env["FLING_DEV_PORT"] || "3210"}`,
        changeOrigin: true,
      },
      // /docs is a server-rendered worker page, not an SPA route.
      "/docs": {
        target: `http://localhost:${process.env["FLING_DEV_PORT"] || "3210"}`,
        changeOrigin: true,
      },
    },
  },
});
