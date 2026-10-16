import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { fileURLToPath } from "node:url";

// API_PORT lets a second dev client (another worktree) proxy to its own server.
const api = `http://localhost:${process.env.API_PORT ?? "8080"}`;

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg", "apple-touch-icon.png"],
      manifest: {
        name: "CGwF - Card Games with Friends",
        short_name: "CGwF",
        description: "A private virtual card table for playing with friends.",
        start_url: "/",
        scope: "/",
        display: "standalone",
        orientation: "any",
        background_color: "#101918",
        theme_color: "#101918",
        icons: [
          { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        // The app shell works offline; API and images are fetched live (images cache separately).
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/api\//, /^\/img\//],
        globPatterns: ["**/*.{js,css,html,svg,png,jpg,woff2}"],
        runtimeCaching: [
          {
            urlPattern: /^\/img\//,
            handler: "CacheFirst",
            options: {
              cacheName: "card-images",
              expiration: { maxEntries: 1500, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [200] },
            },
          },
        ],
      },
    }),
  ],
  resolve: {
    alias: { "@cgwf/shared": fileURLToPath(new URL("../shared/src/index.ts", import.meta.url)) },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: api, ws: true },
      "/img": api,
    },
  },
  build: { outDir: "dist", sourcemap: false },
});
