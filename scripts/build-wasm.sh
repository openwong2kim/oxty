#!/usr/bin/env bash
# Builds crates/oxtty-wasm for the browser and copies it into the npm package.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
rustup target add wasm32-unknown-unknown >/dev/null 2>&1 || true
cargo build --manifest-path "$root/Cargo.toml" -p oxtty-wasm --target wasm32-unknown-unknown --profile wasm
mkdir -p "$root/packages/oxtty/dist"
cp "$root/target/wasm32-unknown-unknown/wasm/oxtty_wasm.wasm" "$root/packages/oxtty/dist/oxtty.wasm"
cp "$root/packages/oxtty/src/index.js" "$root/packages/oxtty/src/index.d.ts" "$root/packages/oxtty/dist/"
echo "packages/oxtty/dist/oxtty.wasm: $(wc -c < "$root/packages/oxtty/dist/oxtty.wasm") bytes"
