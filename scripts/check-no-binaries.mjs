import { execFileSync } from "node:child_process";

const names = execFileSync("git", ["ls-files", "-z"]).toString().split("\0").filter(Boolean);
const forbidden = names.filter((name) => /\.(?:wasm|data|mxf)$/i.test(name));
if (forbidden.length) {
  console.error(`Binary runtime/sample files must not be tracked:\n${forbidden.join("\n")}`);
  process.exit(1);
}
console.log(`Checked ${names.length} tracked files; no .wasm, .data, or .mxf files are tracked.`);
