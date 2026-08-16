# KUDBEE — 8-Hour Autonomous Run Plan

## Objective
Close the P0/P1 continuous-learning loop and harden the system, in small
committed PRs, with the router OFF and DeepSeek ZERO. Every layer is tested,
CI-verified, documented, and recorded into engineering memory.

## Current state (committed)
- `f982325` feat(router) — L0–L4 router + spend telemetry + Redis guard
- `3aff59d` feat(learning) — provenance + no-call
- `96d2fe0` feat(ops) — operator-verify + cache telemetry + bounded retry
- `13e2710` feat(learning) — canonical lifecycle (PR-2)
- Fuel Gauge `feature/phase4g-docs-reconciliation`: `77b608d` (PR-1) + `01b5269` (contracts)

## Remaining PR stack (dependency-aware)
- **PR-4 — Memory/provenance integration**: connect os-agent learnings to the
  canonical knowledge index / THINK tokens via IDs (no duplication).
- **PR-5 — Closed-loop feedback**: bounded, event/schedule-driven re-evaluation
  that reads `recordSpend`/outcome evidence and updates learning status
  (CONFIRM / STALE / SUPERSEDED). No-call first.
- **PR-6 — Learning→test generation**: validated learnings produce test specs.
- **PR-7 — Regression knowledge**: verified failures become regression records/tests.
- **PR-8 — Controlled live routing** (DEFERRED — only after all gates pass).

## Supporting work (interleaved)
- **Operator verification**: extend `operator-verify.mjs` to cover every layer.
- **CI gates**: run `verify:crypto`, `verify:secrets`, `verify-config-vars`,
  `typecheck`, `lint`, `bun test`, `build`, `knowledge:audit` after each PR.
- **Documentation**: reconcile README + ENVIRONMENT + roadmap to implementation.
- **Engineering memory**: record WHAT/WHY/EVIDENCE/TESTS/RISKS/ROLLBACK per PR.

## Resource budget (hard limits)
- **Redis**: ≤500K monthly ops. Telemetry batched + capped (`TELEMETRY_MAX_WRITES`).
- **Models**: no-call before Phi-4 before specialist before Gemini. Local Phi-4 = $0.
- **AWS**: no new infrastructure, no GPU, no Lambda, no EC2 changes.
- **Postgres**: existing pool only, no connection-per-task.

## Guardrails (non-negotiable)
- Router OFF (`ROUTER_ENABLED=false`) until PR-8 approved.
-- DeepSeek ZERO.
- No destructive commands, no `git reset --hard`/`clean -fd`/`rm -rf`.
- No secret exposure (presence-only in all output).
- No autonomous production mutation; every change is a small reviewed commit.
-- No unbounded model/Redis/database behavior.

## What I need to sustain an 8-hour run
- Approval to commit on the feature branch and push stacked PRs (not merge).
- Approval to run CI gates (read-only; no model tokens).
- Periodic checkpoint: after each PR, confirm before the next.
- LM Studio available if live Phi-4 verification is needed (else skip live tests).
- AWS CLI auth for operator-verify (read-only).
