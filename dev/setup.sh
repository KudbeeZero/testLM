#!/usr/bin/env bash
#
# Dev environment setup + verification workflow.
# Runs from Git Bash on Windows (no PowerShell dependency).
# Reads the real source of truth: dev/dependencies.json.
#
# Usage:
#   bash dev/setup.sh check          # only verify installed tools
#   bash dev/setup.sh install        # install missing tools/project deps
#   bash dev/setup.sh up             # build + run the dev container
#   bash dev/setup.sh all            # install + verify + up
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MANIFEST="$ROOT/dev/dependencies.json"

# --- helpers -------------------------------------------------------------
red()   { printf '\033[31m%s\033[0m\n' "$1"; }
green() { printf '\033[32m%s\033[0m\n' "$1"; }
yellow(){ printf '\033[33m%s\033[0m\n' "$1"; }

need() { command -v "$1" >/dev/null 2>&1; }

check_os() {
  if need bash && [[ "$(uname -s)" != *CYGWIN* && "$(uname -s)" != *MINGW* && "$(uname -s)" != *MSYS* ]]; then
    : # not Windows Git Bash; still fine
  fi
}

# --- step 1: verify tools ------------------------------------------------
verify_tools() {
  echo "==> Checking required tools"
  for tool in git node npm rust cargo docker; do
    if need "$tool"; then
      green "  [ok] $tool: $("$tool" --version 2>&1 | head -1)"
    else
      red   "  [MISSING] $tool"
    fi
  done
  echo "==> Optional tools"
  for tool in kubectl kind; do
    if need "$tool"; then
      green "  [ok] $tool: $("$tool" version --client 2>&1 | head -1)"
    else
      yellow "  [optional] $tool not installed"
    fi
  done
}

# --- step 2: install missing tools ---------------------------------------
install_tools() {
  echo "==> Installing missing tools (winget on Windows)"
  local missing=0
  for tool in git node npm; do
    if need "$tool"; then :; continue; fi
    missing=1
    yellow "  installing $tool..."
    case "$tool" in
      git)  winget install --id Git.Git -e --accept-package-agreements --accept-source-agreements ;;
      node) winget install --id OpenJS.NodeJS -e --accept-package-agreements --accept-source-agreements ;;
    esac
  done
  if need node && ! need npm; then
    yellow "  npm missing; reinstalling Node.js"
    winget install --id OpenJS.NodeJS -e --accept-package-agreements --accept-source-agreements
  fi
  if ! need rust; then
    missing=1
    yellow "  installing Rust (rustup)..."
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
    export PATH="$HOME/.cargo/bin:$PATH"
  fi
  if ! need docker; then
    missing=1
    yellow "  installing Docker Desktop..."
    winget install --id Docker.DockerDesktop -e --accept-package-agreements --accept-source-agreements
    yellow "  NOTE: reopen your terminal after Docker Desktop install so PATH refreshes."
  fi
  if [[ "$missing" -eq 1 ]]; then
    yellow "==> Some tools were just installed. Reopen your terminal, then rerun: dev/setup.sh check"
  fi
}

# --- step 3: git identity ------------------------------------------------
configure_git() {
  echo "==> Ensuring git identity"
  if [[ -z "$(git config --global user.name 2>/dev/null)" ]]; then
    git config --global user.name "Kudbee"
  fi
  if [[ -z "$(git config --global user.email 2>/dev/null)" ]]; then
    git config --global user.email "dominick.ziola@gmail.com"
  fi
  green "  user: $(git config --global user.name) <$(git config --global user.email)>"
}

# --- step 4: project dependencies ----------------------------------------
install_project_deps() {
  echo "==> Installing os-agent npm dependencies"
  if need npm; then
    ( cd "$ROOT/os-agent" && npm ci ) || yellow "  npm ci failed; try: cd os-agent && npm install"
  else
    red "  npm not available; install Node.js first"
  fi

  echo "==> Building Rust V8 host (if sources present)"
  if need cargo && [[ -f "$ROOT/v8-embedder/host-rust/Cargo.toml" ]]; then
    ( cd "$ROOT/v8-embedder/host-rust" && cargo build --release )
  else
    yellow "  skipping Rust build (cargo missing or no Cargo.toml)"
  fi
}

# --- step 5: dev container ------------------------------------------------
container_up() {
  echo "==> Bringing up dev container"
  if need docker; then
    docker compose -f "$ROOT/dev/compose.yml" up --build -d
    docker compose -f "$ROOT/dev/compose.yml" ps
  else
    red "  docker not available"
    exit 1
  fi
}

# --- dispatch -------------------------------------------------------------
check_os
case "${1:-check}" in
  check)    verify_tools                             ;;
  install)  install_tools; configure_git; install_project_deps ;;
  up)       container_up                            ;;
  all)      install_tools; configure_git; install_project_deps; verify_tools; container_up ;;
  *)        echo "usage: dev/setup.sh {check|install|up|all}" >&2; exit 2 ;;
esac
