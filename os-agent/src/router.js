import { generate } from "./providers.js";
import {
  ROUTER_ENABLED, PHI4_ENABLED, PHI4_MAX_INPUT, PHI4_ESCALATION_ENABLED,
  ROUTER_DEFAULT_LEVEL, LOCAL_MODEL, GEMINI_MODEL, GROK_MODEL,
} from "./config.js";

/**
 * Level 0-4 Mayor routing.
 *
 *   Level 0  deterministic / cache / existing memory  → NO model call
 *   Level 1  Phi-4 local/free routine worker
 *   Level 2  Gemini Mayor (orchestration / interpretation)
 *   Level 3  XAI specialist (Inception lives in the Fuel Gauge monorepo)
 *   Level 4  Gemini deep reasoning / synthesis / learning
 *
 * DeepSeek is NEVER selected here (application routing = ZERO).
 *
 * Every routed call produces a machine-readable `reason` for telemetry.
 */

const ROUTINE_TYPES = ["classification", "extraction", "summarization", "prioritization", "compression", "normalization"];
const MAYOR_TYPES = ["reasoning", "learning_synthesis", "orchestration", "governance", "security"];
const SPECIALIST_TYPES = ["tool_workflow", "streaming", "structured"];

/** Central task classification (keyword heuristic, extended from app terminology). */
export function classifyTask(prompt) {
  const p = String(prompt || "").toLowerCase();
  if (/classif|category|benign|suspicious|malicious|sentiment/.test(p)) return "classification";
  if (/normaliz|schema/.test(p)) return "normalization";
  if (/extract|fields|envelope|json/.test(p)) return "extraction";
  if (/summariz/.test(p)) return "summarization";
  if (/priorit/.test(p)) return "prioritization";
  if (/compress|dedup|digest/.test(p)) return "compression";
  if (/learn|digest|lesson/.test(p)) return "learning_synthesis";
  if (/reason|think|synthes|analyze|decide/.test(p)) return "reasoning";
  if (/orchestr|route|plan/.test(p)) return "orchestration";
  if (/tool|github|aws|execute|shell/.test(p)) return "tool_workflow";
  return "unknown";
}

/** Level 0 — conservative deterministic no-call (exact/status lookups only). */
function level0Resolve(prompt) {
  const p = String(prompt || "").trim().toLowerCase();
  if (/^(status|version|health|ping|uptime)\b/.test(p)) {
    return "ok";
  }
  return null;
}

/** Deterministic validation for normalization output (required envelope fields). */
function validateNormalization(content) {
  const strip = s => s.replace(/```json/, "").replace(/```/g, "").trim();
  try {
    const j = JSON.parse(strip(content));
    const required = ["event_id", "timestamp", "source", "event_type", "severity", "resource",
      "correlation_id", "evidence_location", "integrity_hash", "schema_version", "ingested_at"];
    return required.every(k => (k in j) && j[k] !== null && j[k] !== "");
  } catch { /* no-op */
    return false;
  }
}

async function escalate(prompt, taskType, reason) {
  return generate(prompt, { provider: "gemini", taskType, reason });
}

/**
 * Route a task through the Level 0-4 hierarchy. Returns the content string
 * (compatible with the legacy generate() contract). When ROUTER_ENABLED is
 * false, this simply calls generate() with the configured default provider.
 */
export async function route(prompt) {
  if (!ROUTER_ENABLED) return generate(prompt);

  const taskType = classifyTask(prompt);
  const decision = {
    provider: null, model: null, level: 0, taskType,
    reason: null, escalate: false, fallbackAllowed: true,
    estimatedCost: null, requiresValidation: false,
  };

  // Level 0 — no model call.
  const l0 = level0Resolve(prompt);
  if (l0 !== null) {
    decision.reason = "level0_deterministic_result";
    return l0;
  }

  // Level 1 — Phi-4 routine worker (bounded input).
  if (PHI4_ENABLED && ROUTINE_TYPES.includes(taskType) && String(prompt || "").length <= PHI4_MAX_INPUT) {
    decision.provider = "local";
    decision.model = LOCAL_MODEL;
    decision.level = 1;
    decision.requiresValidation = taskType === "normalization" || taskType === "compression";
    decision.reason = `phi4_routine_${taskType}`;
    try {
      const content = await generate(prompt, { provider: "local", taskType, reason: decision.reason });
      if (taskType === "normalization" && !validateNormalization(content) && PHI4_ESCALATION_ENABLED) {
        decision.escalate = true;
        decision.reason = "phi4_schema_failure_escalation";
        return escalate(prompt, taskType, decision.reason);
      }
      return content;
    } catch (e) {
      if (PHI4_ESCALATION_ENABLED) {
        decision.escalate = true;
        decision.reason = e.message.toLowerCase().includes("timeout")
          ? "phi4_timeout_escalation"
          : "phi4_error_escalation";
        return escalate(prompt, taskType, decision.reason);
      }
      throw e;
    }
  }

  // Level 2 / 4 — Gemini Mayor.
  if (MAYOR_TYPES.includes(taskType) || ROUTER_DEFAULT_LEVEL >= 2) {
    decision.provider = "gemini";
    decision.model = GEMINI_MODEL;
    decision.level = MAYOR_TYPES.includes(taskType) ? 4 : 2;
    decision.reason = taskType === "learning_synthesis"
      ? "gemini_mayor_learning"
      : `gemini_mayor_${taskType}`;
    return generate(prompt, { provider: "gemini", taskType, reason: decision.reason });
  }

  // Level 3 — specialists (XAI in os-agent; Inception lives in the monorepo).
  if (SPECIALIST_TYPES.includes(taskType)) {
    decision.provider = "grok";
    decision.model = GROK_MODEL;
    decision.level = 3;
    decision.reason = `xai_specialist_${taskType}`;
    return generate(prompt, { provider: "grok", taskType, reason: decision.reason });
  }

  // Fallback — configured default provider.
  decision.level = ROUTER_DEFAULT_LEVEL;
  decision.reason = "router_default";
  return generate(prompt);
}

/**
 * Dry-run routing decision WITHOUT executing any model or tool.
 * Returns the decision object (level/provider/model/reason) for observability.
 */
export function dryRun(prompt) {
  const taskType = classifyTask(prompt);
  const decision = {
    provider: null, model: null, level: 0, taskType,
    reason: null, escalate: false, fallbackAllowed: true,
  };
  const l0 = level0Resolve(prompt);
  if (l0 !== null) { decision.reason = "level0_deterministic_result"; return decision; }
  if (PHI4_ENABLED && ROUTINE_TYPES.includes(taskType) && String(prompt || "").length <= PHI4_MAX_INPUT) {
    decision.provider = "local"; decision.model = LOCAL_MODEL; decision.level = 1;
    decision.reason = `phi4_routine_${taskType}`; return decision;
  }
  if (MAYOR_TYPES.includes(taskType) || ROUTER_DEFAULT_LEVEL >= 2) {
    decision.provider = "gemini"; decision.model = GEMINI_MODEL;
    decision.level = MAYOR_TYPES.includes(taskType) ? 4 : 2;
    decision.reason = taskType === "learning_synthesis" ? "gemini_mayor_learning" : `gemini_mayor_${taskType}`;
    return decision;
  }
  if (SPECIALIST_TYPES.includes(taskType)) {
    decision.provider = "grok"; decision.model = GROK_MODEL; decision.level = 3;
    decision.reason = `xai_specialist_${taskType}`; return decision;
  }
  decision.level = ROUTER_DEFAULT_LEVEL; decision.reason = "router_default";
  return decision;
}

