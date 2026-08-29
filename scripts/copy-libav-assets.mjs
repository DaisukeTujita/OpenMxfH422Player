import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "node_modules/@libav.js/variant-webcodecs/dist");
const target = resolve(root, process.argv[2] ?? "public/libav");
const assets = [
  "libav-6.10.9.0-webcodecs.wasm.mjs",
  "libav-6.10.9.0-webcodecs.wasm.wasm",
];

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
for (const asset of assets) await cp(join(source, asset), join(target, asset));
console.log(`Copied ${assets.length} libav.js runtime assets to ${target}`);
