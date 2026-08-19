/**
 * shell.js — cross-shell spawn helper.
 *
 * Resolves a working shell executable. Prefers PowerShell; if it is missing
 * (e.g. uninstalled, or an unprivileged context), falls back to Git Bash's
 * bash.exe, which is bundled with Git for Windows.
 *
 * All execute paths in os-agent route through here so the agent keeps working
 * regardless of whether PowerShell is present.
 */
import { spawn, execFileSync } from "node:child_process";

const CANDIDATES = {
  powershell: [
    "powershell.exe",
    "pwsh.exe",
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  ],
  gitbash: [
    "bash.exe",
    "C:\\Program Files\\Git\\bin\\bash.exe",
  ],
};

/** Resolve the first executable on the system for a given shell family. */
function resolveShell(family) {
  for (const exe of CANDIDATES[family]) {
    try {
      execFileSync(exe, ["-NoProfile", "-Command", "exit"], { stdio: "ignore" });
      return exe;
    } catch { /* no-op */
      // try next candidate
    }
  }
  return null;
}

let _powershell = null;
let _bash = null;

export function hasPowerShell() {
  if (_powershell === null) _powershell = resolveShell("powershell");
  return !!_powershell;
}

export function hasBash() {
  if (_bash === null) _bash = resolveShell("gitbash");
  return !!_bash;
}

/**
 * Build a spawn tuple [exe, args] that runs `command` on the best available
 * shell. Returns null if no shell is available.
 */
export function shellCommand(command, { interactive = false } = {}) {
  if (hasPowerShell()) {
    const args = ["-NoProfile", "-ExecutionPolicy", "Bypass"];
    if (interactive) {
      args.push("-Command", "-");
    } else {
      args.push("-NonInteractive", "-Command", command);
    }
    return { exe: _powershell, args };
  }
  if (hasBash()) {
    // Git Bash: interactive runs a login bash reading stdin; one-shot uses -c.
    const args = interactive ? [] : ["-lc", command];
    return { exe: _bash, args };
  }
  return null;
}

/** spawn() a command through the resolved shell. */
export function spawnShell(command, opts = {}) {
  const resolved = shellCommand(command, opts);
  if (!resolved) throw new Error("No usable shell found (PowerShell missing and no Git Bash).");
  const p = spawn(resolved.exe, resolved.args, {
    stdio: opts.interactive ? ["inherit", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
    ...opts.spawn,
  });
  return p;
}

