import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@openmxf/h422-player": fileURLToPath(new URL("../../src/index.ts", import.meta.url)),
    },
  },
});
