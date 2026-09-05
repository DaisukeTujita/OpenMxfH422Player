import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const rootPackageJson = JSON.parse(readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8")) as { version: string };

function gitCommitHash(): string {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: fileURLToPath(new URL("../..", import.meta.url)) }).toString().trim();
  } catch {
    return "unknown";
  }
}

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@openmxf/h422-player": fileURLToPath(new URL("../../src/index.ts", import.meta.url)),
    },
  },
  define: {
    __APP_VERSION__: JSON.stringify(rootPackageJson.version),
    __GIT_COMMIT__: JSON.stringify(gitCommitHash()),
  },
});
