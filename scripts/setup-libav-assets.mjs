import { createHash } from "node:crypto";
import { readFile, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultManifest = join(root, "libav/assets.json");

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

export async function ensureLibavAssets(options = {}) {
  const manifestPath = resolve(options.manifestPath ?? process.env.LIBAV_ASSET_MANIFEST ?? defaultManifest);
  const destination = resolve(options.destination ?? join(root, "libav/dist"));
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const baseUrl = process.env.LIBAV_ASSET_BASE_URL ?? manifest.baseUrl;
  const missing = [];

  for (const asset of manifest.assets) {
    const target = join(destination, asset.name);
    try {
      if (sha256(await readFile(target)) === asset.sha256) continue;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    missing.push({ ...asset, target });
  }
  if (!missing.length) return;

  await mkdir(destination, { recursive: true });
  for (const asset of missing) {
    const url = `${baseUrl.replace(/\/$/, "")}/${encodeURIComponent(asset.name)}`;
    const temporary = `${asset.target}.download`;
    try {
      const response = await fetch(url, { redirect: "follow" });
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
      const data = Buffer.from(await response.arrayBuffer());
      const actual = sha256(data);
      if (actual !== asset.sha256) throw new Error(`SHA-256 が一致しません (期待値 ${asset.sha256}, 実際 ${actual})`);
      await writeFile(temporary, data);
      await rm(asset.target, { force: true });
      await rename(temporary, asset.target);
      console.log(`libav.js ${manifest.version}: ${asset.name} を取得しました`);
    } catch (error) {
      await rm(temporary, { force: true });
      throw new Error(
        `カスタム libav.js のダウンロードに失敗しました。\nURL: ${url}\n` +
        `ネットワークと GitHub Release (${manifest.version}) を確認し、\`npm run setup:libav\` を再実行してください。\n` +
        `社内ミラーを使う場合は LIBAV_ASSET_BASE_URL を設定できます。\n原因: ${error.message}`,
        { cause: error },
      );
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await ensureLibavAssets();
}
