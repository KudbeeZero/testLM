/**
 * audit.mjs — MESH audit trail.
 *
 * Every tool invocation records a structured, append-only audit line. Secret
 * values are never written — only tool, agent, capability, risk, decision,
 * success, and a short reason.
 */
import { appendFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUDIT_FILE = path.join(__dirname, "..", "..", "dashboard", "mesh-audit.log");

/**
 * @param {object} e
 * @param {string} e.id
 * @param {string} e.tool
 * @param {string} e.agentId
 * @param {string} [e.capability]
 * @param {string} [e.risk]
 * @param {string} e.decision   allow | deny | approval_required
 * @param {boolean} [e.success]
 * @param {string} [e.reason]
 * @param {number} [e.durationMs]
 */
export async function meshAudit(e) {
  const reason = String(e.reason || "").replace(/[\r\n]+/g, " ").slice(0, 160);
  const line = [
    new Date().toISOString(),
    e.id || "-",
    e.tool || "-",
    e.agentId || "-",
    e.capability || "-",
    e.risk || "-",
    e.decision || "-",
    e.success === undefined ? "-" : String(e.success),
    reason,
  ].join(" | ");
  try {
    await appendFile(AUDIT_FILE, line + "\n");
  } catch {
    // Audit failure must never crash the executor.
  }
}
