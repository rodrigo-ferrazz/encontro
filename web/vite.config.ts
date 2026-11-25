import { defineConfig } from "vite";

// Em desenvolvimento, /api/* vai para a API Python (`uv run encontro serve`).
export default defineConfig({
  server: {
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8000",
        rewrite: (p) => p.replace(/^\/api/, ""),
      },
    },
  },
  test: {
    environment: "node",
  },
});
