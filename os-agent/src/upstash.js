import { Redis } from "@upstash/redis";
import { Index } from "@upstash/vector";
import {
  UPSTASH_REDIS_URL, UPSTASH_REDIS_TOKEN,
  UPSTASH_VECTOR_URL, UPSTASH_VECTOR_TOKEN,
  PROVIDER,
} from "./config.js";

// Upstash Redis (state / cache)
const redis = (UPSTASH_REDIS_URL && UPSTASH_REDIS_TOKEN)
  ? new Redis({ url: UPSTASH_REDIS_URL, token: UPSTASH_REDIS_TOKEN })
  : null;

// Upstash Vector (vector memory). The index is 1536-dim (DOT_PRODUCT).
const vector = (UPSTASH_VECTOR_URL && UPSTASH_VECTOR_TOKEN)
  ? new Index({ url: UPSTASH_VECTOR_URL, token: UPSTASH_VECTOR_TOKEN })
  : null;

const agentKey = (suffix) => `agent:${PROVIDER}:${suffix}`;

/** Store agent state in Redis (e.g. last run, counters). */
export async function setState(key, value) {
  if (!redis) { console.warn("[upstash] Redis not configured."); return; }
  await redis.set(agentKey(key), JSON.stringify(value));
}

/** Read agent state from Redis. */
export async function getState(key) {
  if (!redis) return null;
  const raw = await redis.get(agentKey(key));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { /* no-op */ /* no-op */ return raw; }
}

/**
 * Store a learning as a vector in Upstash Vector for semantic memory.
 * NOTE: the index is 1536-dim; embeddings must match that dimension.
 * Provide `embedding` (array of numbers) or `embeddingText` + an embedder.
 */
export async function upsertVector(id, metadata, embedding) {
  if (!vector) { console.warn("[upstash] Vector not configured."); return; }
  if (!embedding || embedding.length === 0) {
    console.warn("[upstash] No embedding provided — skipping vector write (needs 1536-dim embedding).");
    return;
  }
  await vector.upsert({
    id,
    vector: embedding,
    metadata: { provider: PROVIDER, ...metadata },
  });
}

/** Query similar vectors (semantic recall). */
export async function queryVector(vectorQuery, topK = 5) {
  if (!vector) return [];
  const res = await vector.query({ vector: vectorQuery, topK, includeMetadata: true });
  return res || [];
}

export { redis, vector };


