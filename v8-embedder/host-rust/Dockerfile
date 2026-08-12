FROM rust:1.72-slim AS builder
WORKDIR /workspace
COPY host-rust/Cargo.toml host-rust/Cargo.lock ./
RUN mkdir src
RUN echo "fn main() { println!(\"dummy\"); }" > src/main.rs
RUN cargo build --release || true

COPY host-rust/ ./host-rust/
WORKDIR /workspace/host-rust
RUN cargo build --release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=builder /workspace/host-rust/target/release/host-rust /usr/local/bin/host
WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/host"]
