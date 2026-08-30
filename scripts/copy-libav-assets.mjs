import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureLibavAssets } from "./setup-libav-assets.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "libav/dist");
const target = resolve(root, process.argv[2] ?? "public/libav");
await ensureLibavAssets();
const assets = (await readdir(source)).filter(name => name === "libav-h422.mjs" || /-h422\.wasm\.(?:mjs|wasm)$/.test(name));
if (!assets.length) throw new Error("カスタム libav.js のファイルがありません。`npm run setup:libav` を再実行してください。");
await rm(target, { recursive: true, force: true }); await mkdir(target, { recursive: true });
for (const asset of assets) await cp(join(source, asset), join(target, asset));
console.log(`Copied ${assets.length} custom libav.js runtime assets to ${target}`);
