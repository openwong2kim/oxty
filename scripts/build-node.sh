#!/usr/bin/env bash
# Builds the N-API binding for this machine and places it at crates/oxty-node/oxty.node.
# (Publishing per-platform prebuilds via @napi-rs/cli is a later step.)
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cargo build --manifest-path "$root/Cargo.toml" -p oxty-node --release
case "$(uname -s)" in
  Darwin) lib="liboxty_node.dylib" ;;
  MINGW*|MSYS*|CYGWIN*) lib="oxty_node.dll" ;;
  *) lib="liboxty_node.so" ;;
esac
cp "$root/target/release/$lib" "$root/crates/oxty-node/oxty.node"
echo "crates/oxty-node/oxty.node: $(wc -c < "$root/crates/oxty-node/oxty.node") bytes"
