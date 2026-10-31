#!/usr/bin/env bash
# Builds crates/oxty-wasm for the browser and copies it into the npm package.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
rustup target add wasm32-unknown-unknown >/dev/null 2>&1 || true
cargo build --manifest-path "$root/Cargo.toml" -p oxty-wasm --target wasm32-unknown-unknown --profile wasm
mkdir -p "$root/packages/oxty/dist"
cp "$root/target/wasm32-unknown-unknown/wasm/oxty_wasm.wasm" "$root/packages/oxty/dist/oxty.wasm"
cp "$root/packages/oxty/src/index.js" "$root/packages/oxty/src/index.d.ts" "$root/packages/oxty/dist/"
echo "packages/oxty/dist/oxty.wasm: $(wc -c < "$root/packages/oxty/dist/oxty.wasm") bytes"
