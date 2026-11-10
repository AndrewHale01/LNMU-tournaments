import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const repositoryName = process.env.GITHUB_REPOSITORY?.split("/")[1];
const isUserSite = repositoryName?.endsWith(".github.io") ?? false;
const base = process.env.GITHUB_ACTIONS === "true" && repositoryName && !isUserSite
  ? `/${repositoryName}/`
  : "/";

export default defineConfig({
  base,
  plugins: [react()],
  server: {
    proxy: {
      "/api": "http://127.0.0.1:8000",
    },
  },
  build: {
    rollupOptions: {
      input: {
        public: "index.html",
        admin: "admin.html",
      },
    },
  },
});
