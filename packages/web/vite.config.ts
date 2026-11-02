import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Served by the cairnmcp server at /app (D-033). In development, `pnpm dev`
// proxies the API and sign-in routes to a server on :8080.
const server = process.env["CAIRNMCP_DEV_SERVER"] ?? "http://localhost:8080";

export default defineConfig({
  base: "/app/",
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: {
    proxy: {
      "/app/api": server,
      "/app/login": server,
      "/app/callback": server,
    },
  },
  // The app bundle (React, Radix, Shiki core) is about 230 kB gzipped: fine for an admin console.
  build: { outDir: "dist", emptyOutDir: true, sourcemap: false, chunkSizeWarningLimit: 1000 },
});
