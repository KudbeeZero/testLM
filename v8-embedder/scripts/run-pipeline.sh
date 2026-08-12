#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

node "$ROOT/ts-runner/strip.js" "$ROOT/examples/hello.ts" "$ROOT/build/hello.js"

if [ ! -f "$ROOT/host-rust/target/release/host-rust" ]; then
  (cd "$ROOT/host-rust" && cargo build --release)
fi

"$ROOT/host-rust/target/release/host-rust" "$ROOT/build/hello.js"
