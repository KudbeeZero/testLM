#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ ! -f host-rust/target/release/host-rust ]; then
  (cd host-rust && cargo build --release)
fi

node ts-runner/strip.js examples/hello.ts build/hello.js

./host-rust/target/release/host-rust \
  --snapshot snapshots/init.bin \
  build/hello.js
