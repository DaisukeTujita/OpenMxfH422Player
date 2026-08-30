import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

const [firstArgument, secondArgument] = process.argv.slice(2);
if (!firstArgument || !secondArgument) {
  throw new Error("usage: node scripts/compare-libav-assets.mjs <build-one> <build-two>");
}

const firstDirectory = resolve(firstArgument);
const secondDirectory = resolve(secondArgument);
const firstNames = (await readdir(firstDirectory)).sort();
const secondNames = (await readdir(secondDirectory)).sort();
if (JSON.stringify(firstNames) !== JSON.stringify(secondNames)) {
  throw new Error(`ビルド間でファイル一覧が異なります\n1回目: ${firstNames.join(", ")}\n2回目: ${secondNames.join(", ")}`);
}

for (const name of firstNames) {
  const [first, second] = await Promise.all([
    readFile(resolve(firstDirectory, name)),
    readFile(resolve(secondDirectory, name)),
  ]);
  const firstHash = createHash("sha256").update(first).digest("hex");
  const secondHash = createHash("sha256").update(second).digest("hex");
  if (firstHash !== secondHash) {
    throw new Error(`${name}: clean buildのSHA-256が一致しません (${firstHash} != ${secondHash})`);
  }
  console.log(`${firstHash}  ${name} (both clean builds)`);
}
