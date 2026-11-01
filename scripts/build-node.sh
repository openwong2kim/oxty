#!/usr/bin/env bash
# Builds the N-API binding for this machine and places it at crates/oxtty-node/oxtty.node.
# (Publishing per-platform prebuilds via @napi-rs/cli is a later step.)
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cargo build --manifest-path "$root/Cargo.toml" -p oxtty-node --release
case "$(uname -s)" in
  Darwin) lib="liboxtty_node.dylib" ;;
  MINGW*|MSYS*|CYGWIN*) lib="oxtty_node.dll" ;;
  *) lib="liboxtty_node.so" ;;
esac
cp "$root/target/release/$lib" "$root/crates/oxtty-node/oxtty.node"
echo "crates/oxtty-node/oxtty.node: $(wc -c < "$root/crates/oxtty-node/oxtty.node") bytes"
