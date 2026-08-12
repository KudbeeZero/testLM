# Windows + WSL2 Development Environment Setup

## Overview

This guide completes a Windows 10/11 workstation for **Rust**, **V8 embedding**, **Node.js**, and **Docker/Kubernetes** development.

Current machine state:
- **WSL2 + Ubuntu**: already installed and working
- **WSL git**: available (`git` works in Ubuntu)
- **Missing on Windows host**: `git`, `node`, `docker` are not on PATH
- **Docker Desktop**: not installed

All host-side package installs use `winget` with verified package IDs.

---

## Prerequisites

- Windows 10 2004+ or Windows 11
- BIOS virtualization enabled (Intel VT-x / AMD-V)
- Administrator access
- Internet connection

---

## Phase 1: Verify WSL2 + Ubuntu

This workstation already has WSL2. Run this in **PowerShell** to confirm:

```powershell
# Verify WSL2 + Ubuntu distro
wsl --list --verbose
```

Expected output:

```
  NAME      STATE           VERSION
* Ubuntu    Running         2
```

If Ubuntu is not listed or VERSION is `1`, run:

```powershell
wsl --set-default-version 2
```

Update WSL kernel:

```powershell
wsl --update
```

---

## Phase 2: Install Windows Host Tooling

Run these in an **Administrator** PowerShell session:

```powershell
# Update winget sources
winget source update

# Core tooling
winget install --id Git.Git -e --source winget
winget install --id Microsoft.VisualStudioCode -e --source winget
winget install --id Docker.DockerDesktop -e --source winget

# Windows Terminal (recommended)
winget install --id Microsoft.WindowsTerminal -e --source winget
```

### Post-install: refresh environment

```powershell
# Refresh PATH for current session
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")

# Verify installs
git --version
code --version
docker --version
```

If `git` still isn’t found, add its install dir to PATH manually:

```powershell
[Environment]::SetEnvironmentVariable("Path", $env:Path + ";C:\Program Files\Git\cmd", "User")
```

Close and reopen PowerShell after PATH changes.

---

## Phase 3: Docker Desktop + WSL2 Integration

### First-run setup

1. Open **Docker Desktop** from the Start menu
2. Accept the service install prompt
3. Go to **Settings** → **Resources** → **WSL Integration**
4. Enable integration with **Ubuntu**
5. Click **Apply & Restart**

### Verify Docker from WSL2

Open **Ubuntu** and run:

```bash
docker --version
docker run --rm hello-world
```

Expected output:

```
Hello from Docker!
This message shows that your installation appears to be working correctly.
```

### Enable Kubernetes in Docker Desktop

1. Docker Desktop → **Settings** → **Kubernetes**
2. Check **Enable Kubernetes**
3. Click **Apply & Restart**
4. Wait 1-2 minutes, then verify:

```bash
kubectl version --client
kubectl get nodes
```

---

## Phase 4: WSL2 Ubuntu Development Tools

Open **Ubuntu** from the Start menu, then:

```bash
# Update packages
sudo apt update && sudo apt upgrade -y

# Core build dependencies for Rust/V8
sudo apt install -y \
  build-essential \
  curl \
  git \
  python3 \
  python3-pip \
  cmake \
  ninja-build \
  pkg-config \
  libssl-dev \
  clang \
  lld

# Install Rust via rustup
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
source ~/.cargo/env

# Verify Rust
rustc --version
cargo --version
```

### Install Node.js in WSL2

```bash
# Using nvm (recommended for version switching)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash

# Reload shell config
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

# Install LTS
nvm install --lts
nvm use --lts

# Verify
node --version
npm --version
```

### Install kubectl + kind in WSL2

```bash
# kubectl
curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"
chmod +x kubectl
sudo mv kubectl /usr/local/bin/

# kind
go install sigs.k8s.io/kind@latest

# Verify
kubectl version --client
kind --version
```

---

## Phase 5: Configure Git Identity + GitHub Auth

### Set identity in WSL2 Ubuntu

```bash
git config --global user.name "Your Name"
git config --global user.email "you@example.com"
git config --list --global
```

### Authenticate with GitHub

**Option A: HTTPS + Personal Access Token (recommended for this machine)**

```bash
# Store PAT securely (you will be prompted once)
git config --global credential.helper store
```

Then when you push, use your GitHub username and PAT as password. Git will save it to `~/.git-credentials`.

**Option B: SSH key**

```bash
ssh-keygen -t ed25519 -C "you@example.com"
cat ~/.ssh/id_ed25519.pub
# Add the output to GitHub: Settings → SSH and GPG keys → New SSH key
```

### Verify GitHub access

```bash
git ls-remote https://github.com/KudbeeZero/testLM.git
```

---

## Phase 6: Clone and Build Workspace

```bash
# Clone your repo
git clone https://github.com/KudbeeZero/testLM.git
cd testLM

# Install Node dependencies for os-agent
cd os-agent && npm ci && cd ..

# Build Rust V8 host
cd v8-embedder/host-rust
cargo build --release
cd ../..

# Create V8 snapshot
bash scripts/create-snapshot.sh
```

---

## Phase 7: VS Code Integration

1. Open VS Code
2. Install the **Remote - WSL** extension
3. Open the workspace folder from WSL:

```bash
cd ~/testLM
code .
```

Or from Windows:

```
File → Open Folder... → \\wsl.localhost\Ubuntu\home\<your-user>\testLM
```

---

## Verification Checklist

| Component | Command | Expected |
|---|---|---|
| Windows git | `git --version` | `git version 2.xx.x` |
| WSL2 distro | `wsl --list --verbose` | Ubuntu, VERSION 2 |
| Rust | `rustc --version` | `rustc 1.xx.x` |
| Cargo | `cargo --version` | `cargo 1.xx.x` |
| Node | `node --version` | `v20.x.x` or `v22.x.x` |
| npm | `npm --version` | `10.x.x` |
| Docker | `docker --version` | `Docker version 24.x.x` |
| Docker hello-world | `docker run --rm hello-world` | Success message |
| kubectl | `kubectl version --client` | Client version output |
| kind | `kind --version` | `kind version 0.xx.x` |
| GitHub remote | `git ls-remote origin HEAD` | commit hash |

---

## Troubleshooting

### Git not found after install
Restart PowerShell, or add `C:\Program Files\Git\cmd` to your user PATH manually.

### Docker fails in WSL2
Ensure WSL2 integration is enabled in Docker Desktop settings and the distro is running:

```powershell
wsl --status
wsl --list --verbose
```

### Rust build is slow
First `cargo build` downloads and compiles V8 via `rusty_v8`. Subsequent builds use incremental compilation. Ensure WSL2 has at least 4 GB RAM allocated:

```powershell
# In PowerShell as Administrator
wsl --shutdown
# Edit %USERPROFILE%\.wslconfig
[wsl]
memory=6GB
swap=4GB
```

Then restart WSL:

```powershell
wsl
```

### GitHub push asks for password every time
Run `git config --global credential.helper store` once, then push with your PAT. Git will save it to `~/.git-credentials`.

---

## Quick Reference

| Task | Command |
|---|---|
| Start WSL2 | `wsl` |
| Stop WSL2 | `wsl --shutdown` |
| Open workspace in VS Code | `cd ~/testLM && code .` |
| Build Rust host | `cd v8-embedder/host-rust && cargo build --release` |
| Create snapshot | `bash scripts/create-snapshot.sh` |
| Run warm script | `bash scripts/run-warm.sh` |
