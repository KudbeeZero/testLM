#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -d v8 ]; then
  echo "Cloning V8..."
  fetch v8
fi

cd v8
gclient sync
tools/dev/v8gen.py x64.release
ninja -C out.gn/x64.release v8_monolith

echo "V8 built at: $(pwd)/out.gn/x64.release/libv8_monolith.a"
