import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
    base: process.env["VITE_BASE"] || "/",
    plugins: [tailwindcss(), react()],
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
        },
    },
});
