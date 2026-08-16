/**
 * workspace.mjs — MESH filesystem sandbox.
 *
 * Enforces a single allowed workspace root and denies access to secret /
 * credential material. All path resolution in the tool executor routes
 * through here so the model can never escape the workspace or read secrets.
 */
import path from "node:path";
import { WORKSPACE } from "../config.js";

const WORKSPACE_ROOT = path.resolve(WORKSPACE);

// Deny-list for secret / credential material regardless of location.
const DENY_PATTERNS = [
  /(^|[\\/])\.env([\\/]|$)/i, // .env or .env.* (exact filename)
  /\.pem$/i, // any file ending in .pem
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /\.p8$/i,
  /\.crt$/i,
  /\.cer$/i,
  /(^|[\\/])credentials/i,
  /(^|[\\/])secrets/i,
  /(^|[\\/])\.aws([\\/]|$)/i,
  /(^|[\\/])\.ssh([\\/]|$)/i,
  /\.npmrc$/i,
  /\.gitconfig$/i,
  /\.netrc$/i,
  /\.bash_history$/i,
  /\.zsh_history$/i,
];

/** True if `p` resolves inside the workspace root (no ../ or absolute escape). */
export function isPathInsideWorkspace(p) {
  const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(WORKSPACE_ROOT, p);
  const rel = path.relative(WORKSPACE_ROOT, abs);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** True if `p` matches the secret / credential deny-list. */
export function isDeniedPath(p) {
  const norm = path.resolve(p).replace(/\\/g, "/");
  return DENY_PATTERNS.some((re) => re.test(norm));
}

/**
 * Resolve a user-supplied path to an absolute path inside the workspace.
 * Throws if it escapes the workspace or hits a denied path.
 */
export function resolveWorkspacePath(p) {
  const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(WORKSPACE_ROOT, p);
  if (!isPathInsideWorkspace(abs)) throw new Error("path outside workspace");
  if (isDeniedPath(abs)) throw new Error("path denied (secret/credential material)");
  return abs;
}

export function workspaceRoot() {
  return WORKSPACE_ROOT;
}
