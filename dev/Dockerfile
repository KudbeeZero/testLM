# Dev container for the testLM stack: Node.js + Rust (+ V8 via rusty_v8).
# Provides a reproducible environment that always works, regardless of host issues.
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates gnupg git build-essential \
    python3 python3-pip cmake ninja-build pkg-config \
    libssl-dev clang lld \
    && rm -rf /var/lib/apt/lists/*

# Node.js 22 LTS
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && corepack enable \
    && npm install -g npm@latest \
    && rm -rf /var/lib/apt/lists/*

# Rust via rustup
ENV RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo PATH=/usr/local/cargo/bin:$PATH
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal \
    && rustup component add rustfmt clippy

# Docker client (so the container can talk to the host Docker daemon)
RUN curl -fsSL https://download.docker.com/linux/static/stable/x86_64/docker-27.3.1.tgz | tar -xz \
    && mv docker/docker /usr/local/bin/docker \
    && rm -rf docker

WORKDIR /workspace

# Default command: keep the container alive and ready for interactive work
CMD ["sleep", "infinity"]
