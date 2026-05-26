import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev server proxies /api -> the control-plane gateway (server/index.ts, port 8787).
// This keeps the browser bundle free of any node:http server code: the client
// only ever speaks fetch + EventSource to /api/*.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:8787",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
});
