import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const manifest = JSON.parse(await readFile(new URL("../libav/assets.json", import.meta.url), "utf8"));
for (const asset of manifest.assets) {
  const data = await readFile(new URL(`../libav/dist/${asset.name}`, import.meta.url));
  const actual = createHash("sha256").update(data).digest("hex");
  if (actual !== asset.sha256) throw new Error(`${asset.name}: assets.json=${asset.sha256}, build=${actual}`);
  console.log(`${actual}  ${asset.name}`);
}
