import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, "..");          // os-agent/
export const WORKSPACE = path.resolve(ROOT, "..");          // testLM/ (workspace root)
export const AGENT_DIR = path.join(WORKSPACE, "agent");    // testLM/agent/
export const MEMORY_FILE = path.join(AGENT_DIR, "memory", "learnings.json");

// Runtime memory store directory. Overridable via KUDBEE_MEMORY_DIR so the
// test suite (which project.test runs) never mutates the real overnight stores.
export const MEMORY_DIR = process.env.KUDBEE_MEMORY_DIR
  ? path.resolve(process.env.KUDBEE_MEMORY_DIR)
  : path.join(AGENT_DIR, "memory");

// Load the workspace-root .env (where API keys live), then the os-agent .env.
config({ path: path.join(WORKSPACE, ".env") });
config({ path: path.join(ROOT, ".env") });

export const PROVIDER = (process.env.MODEL_PROVIDER || "local").toLowerCase();

export const LOCAL_MODEL = process.env.LOCAL_MODEL || "qwen/qwen3-1.7b";
// The @lmstudio/sdk connects over WebSocket, not HTTP.
export const LM_STUDIO_BASE_URL = process.env.LM_STUDIO_BASE_URL || "ws://localhost:1234";

// Accept the common misspelling "GEMENI_API_KEY" as a fallback.
export const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GEMENI_API_KEY || "";
// Cheapest best thinking models. Use gemini-flash-latest (a rolling alias) so
// agent jobs keep working as Google rotates point releases; gemini-2.5-flash is
// retired for new users (404). grok-4.x = cheapest general reasoning on xAI.
export const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-flash-latest";

export const XAI_API_KEY = process.env.XAI_API_KEY || "";
export const GROK_MODEL = process.env.GROK_MODEL || "grok-4.3";

export const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || "";
export const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || "deepseek-v4-flash";
export const DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";

export const LIGHTNING_API_KEY = process.env.LIGHTNING_API_KEY || "";
export const LIGHTNING_USER_ID = process.env.LIGHTNING_USER_ID || "";

// Neon serverless Postgres (connection string + REST API).
export const DATABASE_URL = process.env.DATABASE_URL || "";
export const DATABASE_API = process.env.DATABASE_API_PRODUCTION || "";

// Upstash (Redis cache/state, Vector memory, QStash messaging).
export const UPSTASH_REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || "";
export const UPSTASH_REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "";
export const UPSTASH_VECTOR_URL = process.env.UPSTASH_VECTOR_REST_URL || "";
export const UPSTASH_VECTOR_TOKEN = process.env.UPSTASH_VECTOR_REST_TOKEN || "";
export const UPSTASH_BOX_API_KEY = process.env.UPSTASH_BOX_API_KEY || "";
export const QSTASH_URL = process.env.QSTASH_URL || "";
export const QSTASH_TOKEN = process.env.QSTASH_TOKEN || "";

// Map each provider to its own agent schema/database in Postgres.
export const AGENT_SCHEMA = {
  local: process.env.PG_DB_LOCAL || "agent_local",
  gemini: process.env.PG_DB_GEMINI || "agent_gemini",
  grok: process.env.PG_DB_GROK || "agent_grok",
  deepseek: process.env.PG_DB_DEEPSEEK || "agent_deepseek",
};

export const MODEL_TTL_SECONDS = Number(process.env.MODEL_TTL_SECONDS || 600);

// --- Level 0-4 Mayor routing configuration ---
export const ROUTER_ENABLED = String(process.env.ROUTER_ENABLED || "false") === "true";
export const PHI4_ENABLED = String(process.env.PHI4_ENABLED || "true") === "true";
export const PHI4_MAX_CONTEXT = Number(process.env.PHI4_MAX_CONTEXT || 8192);
export const PHI4_TIMEOUT_MS = Number(process.env.PHI4_TIMEOUT_MS || 60000);
export const PHI4_MAX_INPUT = Number(process.env.PHI4_MAX_INPUT || 4000);
export const PHI4_ESCALATION_ENABLED = String(process.env.PHI4_ESCALATION_ENABLED || "true") === "true";
export const ROUTER_DEFAULT_LEVEL = Number(process.env.ROUTER_DEFAULT_LEVEL || 1);

// --- Redis resource guard (Upstash ~500K monthly request quota) ---
// Caps detailed telemetry writes so observability cannot consume the quota.
export const TELEMETRY_MAX_WRITES = Number(process.env.TELEMETRY_MAX_WRITES || 100000);
export const TELEMETRY_FLUSH_EVERY = Number(process.env.TELEMETRY_FLUSH_EVERY || 20);

// Optional per-token pricing (USD). Unknown providers stay null (not fabricated).
export const PRICING = {
  gemini: { inPer1k: Number(process.env.GEMINI_IN_PER_1K || 0), outPer1k: Number(process.env.GEMINI_OUT_PER_1K || 0) },
  grok: { inPer1k: Number(process.env.GROK_IN_PER_1K || 0), outPer1k: Number(process.env.GROK_OUT_PER_1K || 0) },
  deepseek: { inPer1k: Number(process.env.DEEPSEEK_IN_PER_1K || 0), outPer1k: Number(process.env.DEEPSEEK_OUT_PER_1K || 0) },
  local: { inPer1k: 0, outPer1k: 0 },
};

// Monthly LLM spend budget (USD). Mirrors the Kudbee MONTHLY_BUDGET_USD pattern.
export const MONTHLY_BUDGET_USD = Number(process.env.MONTHLY_BUDGET_USD || 50);

// Rate limiting: max API requests allowed per minute for cloud providers
// (Gemini / Grok). Protects against hitting provider rate limits / costs.
export const RATE_LIMIT_PER_MINUTE = Number(process.env.RATE_LIMIT_PER_MINUTE || 30);

// Cloud escalation cost gate. Default: UNKNOWN cloud cost => NO escalation.
// Only an explicit flag enables escalation when cloud cost is unknown.
export const ALLOW_UNKNOWN_CLOUD_COST = String(process.env.ALLOW_UNKNOWN_CLOUD_COST || "false") === "true";

export function providerLabel() {
  return { local: "local (LM Studio)", gemini: "Gemini", grok: "Grok (xAI)", deepseek: "DeepSeek" }[PROVIDER] || PROVIDER;
}

