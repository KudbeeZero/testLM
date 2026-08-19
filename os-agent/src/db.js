import pg from "pg";
import { DATABASE_URL, AGENT_SCHEMA, PROVIDER } from "./config.js";

const { Pool } = pg;

let pool = null;

function getPool() {
  if (!pool) {
    pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
  }
  return pool;
}

/** The schema (per-agent DB) for the active provider. */
export function agentSchema() {
  return AGENT_SCHEMA[PROVIDER] || "agent_local";
}

/**
 * Store a list of learnings into the active agent's schema/table.
 * Each learning: { topic, insight, recommendation }
 */
export async function saveLearnings(learnings) {
  if (!DATABASE_URL) {
    console.warn("[db] No DATABASE_URL set — skipping DB write (JSON memory still updated).");
    return 0;
  }
  const schema = agentSchema();
  const client = getPool();
  let inserted = 0;
  for (const l of learnings) {
    if (!l.topic || !l.insight) continue;
    const res = await client.query(
      `INSERT INTO ${schema}.learnings (topic, insight, recommendation, provider) VALUES ($1,$2,$3,$4) RETURNING id`,
      [l.topic, l.insight, l.recommendation ?? null, PROVIDER]
    );
    inserted += res.rowCount;
  }
  console.log(`[db] Stored ${inserted} learning(s) in schema "${schema}".`);
  return inserted;
}

/** Fetch recent learnings for the active agent (for context / verification). */
export async function recentLearnings(limit = 5) {
  if (!DATABASE_URL) return [];
  const schema = agentSchema();
  const client = getPool();
  const res = await client.query(
    `SELECT topic, insight, recommendation, provider, date FROM ${schema}.learnings ORDER BY id DESC LIMIT $1`,
    [limit]
  );
  return res.rows;
}

export async function closeDb() {
  if (pool) await pool.end();
}

