#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE="${LIBAVJS_SOURCE:-$ROOT/.cache/libav.js}"
VERSION="${LIBAVJS_VERSION:-v6.10.9.0}"
if [[ ! -d "$SOURCE/.git" ]]; then
  mkdir -p "$(dirname "$SOURCE")"
  git clone --depth 1 --branch "$VERSION" https://github.com/Yahweasel/libav.js.git "$SOURCE"
fi
(
  cd "$SOURCE/configs"
  node ./mkconfig.js h422 "$(cat "$ROOT/libav/config.json")"
)
make -C "$SOURCE" build-h422
mkdir -p "$ROOT/libav/dist"
cp "$SOURCE"/dist/libav-h422.mjs "$ROOT/libav/dist/"
cp "$SOURCE"/dist/libav-*-h422.wasm.{mjs,wasm} "$ROOT/libav/dist/"
echo "Custom h422 runtime created in libav/dist"
