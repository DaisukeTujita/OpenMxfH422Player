import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const manifest = JSON.parse(await readFile(new URL("../libav/assets.json", import.meta.url), "utf8"));
const assetDirectory = resolve(process.argv[2] ?? fileURLToPath(new URL("../libav/dist", import.meta.url)));
for (const asset of manifest.assets) {
  const data = await readFile(resolve(assetDirectory, asset.name));
  const actual = createHash("sha256").update(data).digest("hex");
  if (actual !== asset.sha256) throw new Error(`${asset.name}: assets.json=${asset.sha256}, build=${actual}`);
  console.log(`${actual}  ${asset.name}`);
}
