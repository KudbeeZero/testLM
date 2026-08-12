# V8 TypeScript Embedder — Rust Version

## Why Rust?
- **No manual V8 build**: `cargo build` pulls and builds V8 automatically via `rusty_v8`
- **Memory safety**: Rust's ownership model prevents common embedder bugs
- **Fast iteration**: `cargo check` is instant for type errors
- **Production ready**: LTO, stripping, single binary output

## Prerequisites (WSL2 Ubuntu)
```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source ~/.cargo/env
rustc --version
cargo --version
```

## Pipeline
```
examples/hello.ts  --(SWC)-->  build/hello.js  --(host)-->  stdout
                              |
                              +--snapshot--> snapshots/init_blob.bin
```

## Commands

### 1. Strip TS → JS
```bash
cd ts-runner && npm ci
node strip.js ../examples/hello.ts ../build/hello.js
```

### 2. Build host
```bash
cd .. && cargo build --release
# Binary at: target/release/v8-host
```

### 3. Run stateless
```bash
./target/release/v8-host build/hello.js
```

### 4. Create snapshot + warm run
```bash
./target/release/v8-host --create-snapshot build/hello.js
./target/release/v8-host --snapshot snapshots/init_blob.bin build/hello.js
```

## Files
- `Cargo.toml` — Rust deps (`rusty_v8`, `clap`)
- `src/main.rs` — CLI entrypoint
- `src/host/mod.rs` — V8 isolate wrapper (stateless + snapshot)
- `ts-runner/strip.ts` — SWC TS→JS stripper
- `examples/hello.ts` — sample plugin
- `docker/Dockerfile` — Linux container build

## Notes
- First `cargo build` downloads + builds V8 (~10-30 min depending on CPU)
- Subsequent builds use incremental compilation (~seconds)
- Release binary is ~5-10MB static-linked
