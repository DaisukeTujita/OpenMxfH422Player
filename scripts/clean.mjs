import { rm } from "node:fs/promises";
import { resolve } from "node:path";

for (const path of process.argv.slice(2)) await rm(resolve(path), { recursive: true, force: true });
