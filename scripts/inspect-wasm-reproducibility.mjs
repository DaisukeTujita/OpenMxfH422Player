import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const wasmPath = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("usage: node scripts/inspect-wasm-reproducibility.mjs <file.wasm>");
const wasm = await readFile(wasmPath);
if (wasm.subarray(0, 8).toString("hex") !== "0061736d01000000") throw new Error(`${wasmPath}: invalid WebAssembly header`);

function varuint(offset) {
  let value = 0;
  let shift = 0;
  for (let index = offset; index < wasm.length; index++) {
    const byte = wasm[index];
    value |= (byte & 0x7f) << shift;
    if (!(byte & 0x80)) return { value, next: index + 1 };
    shift += 7;
    if (shift > 35) throw new Error(`${wasmPath}: invalid varuint`);
  }
  throw new Error(`${wasmPath}: truncated varuint`);
}

const customSections = [];
for (let offset = 8; offset < wasm.length;) {
  const id = wasm[offset++];
  const size = varuint(offset);
  offset = size.next;
  const end = offset + size.value;
  if (end > wasm.length) throw new Error(`${wasmPath}: truncated section`);
  if (id === 0) {
    const nameSize = varuint(offset);
    const nameEnd = nameSize.next + nameSize.value;
    if (nameEnd > end) throw new Error(`${wasmPath}: truncated custom section name`);
    customSections.push(wasm.subarray(nameSize.next, nameEnd).toString("utf8"));
  }
  offset = end;
}

const forbiddenSections = customSections.filter(name =>
  name === "name" || name === "sourceMappingURL" || name === "external_debug_info" || name.startsWith(".debug_"));
if (forbiddenSections.length) {
  throw new Error(`${wasmPath}: debug/source metadata custom sectionを含みます: ${forbiddenSections.join(", ")}`);
}

const printable = wasm.toString("latin1");
const embeddedPaths = [
  /\/home\/runner\/work\/[\x20-\x7e]+/g,
  /\/workspace\/[\x20-\x7e]+/g,
  /[A-Za-z]:\\[\x20-\x7e]+/g,
].flatMap(pattern => printable.match(pattern) ?? []);
if (embeddedPaths.length) throw new Error(`${wasmPath}: absolute build pathを含みます: ${embeddedPaths.join(", ")}`);

console.log(`${wasmPath}: custom sections = ${customSections.join(", ") || "none"}; debug sections and absolute build paths = none`);
