# KUDBEE — Training & Execution Roadmap

> The plan we will follow. Each phase is a small, tested, committed PR that
> closes a link in the learning loop. Router stays OFF; DeepSeek stays ZERO.
> Checkpoint after every phase before the next.

## The loop we are building (train → validate → teach → test → improve)

```
OBSERVE → RECORD → EVALUATE → LEARN → VALIDATE → TEACH → TEST → IMPROVE
   ↑                                                                  │
   └──────────────────────── FEEDBACK ← MEASURE ← OUTCOME ─────────────┘
```

Every phase must keep this loop **bounded, auditable, cache-efficient,
cost-aware, fault-tolerant, secure, and human-governed.**

## Roadmap (dependency-aware)

### PHASE 0 — Foundation (DONE, committed)
- L0–L4 router + spend telemetry + Redis guard (`f982325`)
- Learning provenance + no-call (`3aff59d`)
- Operator-verify + cache telemetry + bounded retry (`96d2fe0`)
- Canonical learning lifecycle (`13e2710`)
- AGENTS.md reconciliation + Mayor/Router/Phi-4 contracts (Fuel Gauge branch)

### PHASE 1 — Memory/Provenance Integration (PR-4)
- Connect os-agent learnings to canonical knowledge/THINK via IDs (no duplication)
- Register learnings through the canonical engine (deterministic, 0 model calls)
- `knowledge:audit` PASS
- **Accept:** provenance traceable end-to-end; no parallel memory system

### PHASE 2 — Closed-Loop Feedback (PR--5)
- Bounded re-evaluation reading `recordSpend`/outcome evidence
- Update learning status: CONFIRM / STALE / SUPERSEDED (no-call first)
- **Accept:** outcomes re-evaluate learning; no unbounded loop

### PHASE 3 — Learning→Test Generation (PR-6) (DONE, committed)
- `generate-tests.mjs`: bounded, deduped test specs for VALIDATED/ACTIVE only
- `learning.test.mjs` coverage (5 tests pass)
- **Accept:** each validated learning → ≤N tests; no duplicate tests

### PHASE 4 — Regression Knowledge (PR-7) (DONE, committed)
- `record-regression.mjs`: append-only regression log (never relearn a failure)
- **Accept:** a failure never needs relearning

### PHASE 5 — Controlled Live Routing (PR-8 — DEFERRED)
- Only after all gates pass + explicit human approval
- Start with classification/extraction/sumarization/prioritization → Phi--4
- **Accept:** telemetry shows calls/tokens/dollars avoided

### PHASE  (continuous) — Operator Verification + Docs + Engineering Memory
- Extend `operator-verify.mjs` to cover every layer
- Reconcile README/ENVIRONMENT/roadmap to implementation
- Record WHAT/WHY/EVIDENCE/TESTS/RISKS/ROLLBACK per PR

## CI gates (after every phase)
`verify:crypto` · `verify:secrets` · `verify-config-vars` · `typecheck` · `lint` ·
`bun test` · `build` · `knowledge:audit`

## Resource budget (hard limits)
- Redis ≤500K monthly ops (batched + capped telemetry)
- No-call → Phi-4 → specialist → Gemini; Phi--4 = $0
- AWS: no new infra, no GPU, no Lambda, no EC2 changes
- Postgres: existing pool only

## Guardrails ( non-negotiable
- Router OFF until PR-8 approved · DeepSeek ZERO
- No destructive commands · no secret exposure · no autonomous mutation
- No unbounded model/Redis/database behavior
- Checkpoint after every phase before the next

## Checkpoint protocol
At each phase boundary: report what changed, CI results, resource impact, risks,
and the exact next phase. Wait for approval before continuing.
