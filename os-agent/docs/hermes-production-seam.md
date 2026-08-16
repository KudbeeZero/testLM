# HERMES → MESH Production Seam (Phase 16)

Status: `LOCAL HERMES BRIDGE = PROVEN` · `PRODUCTION HERMES WORKER = NOT MODIFIED`

## What is proven

The local bridge (`os-agent/src/mesh/hermes-bridge.mjs`) provides a complete
structured execution seam:

- `validateHermesTask(task)` — rejects raw `command` / `shell` / `exec` /
  `script` / `process` / `cmd` / `environment` fields; requires `tool` +
  `arguments`.
- `runHermesTask(task)` — full lifecycle: validate contract → MESH →
  executor → evidence → evidence-backed learning. Malicious/malformed requests
  are denied before MESH and never crash the caller.
- `runHermesToolTask(task)` — direct MESH seam (backward-compatible).

There is exactly **one MESH authority** (os-agent `src/mesh/index.mjs`). The
bridge does not duplicate capability policy, executor logic, filesystem sandbox,
or audit.

## The production seam (design, not yet wired)

The production worker (`Kudbee-fuel-gage/worker.js`) is a separate git
submodule and cannot import os-agent modules directly without crossing repo
boundaries. The smallest safe adapter is a **localhost HTTP endpoint** on the
os-agent dashboard server:

```
POST /api/hermes/execute   (operator role, localhost, CSRF)
  { taskId, tool, arguments }
  -> { ok, decision, success, reason, evidence }
```

The worker would detect a structured tool task (a task carrying `tool` +
`arguments`, or `action === "tool"`) and POST it to this endpoint, then
return the structured result. This keeps ONE MESH authority and requires no
cross-repo import.

## Why production was not modified in Phase 16

- The submodule boundary makes direct import fragile.
- The worker runs against production Redis/DB; wiring it live here risks
  destabilizing production without a controlled deployment.
- The prompt explicitly allows "only an adapter/test exists" as an honest
  outcome and forbids architectural optimism in place of evidence.

## Required before production wiring

- A controlled deployment of the localhost MESH endpoint (or an in-repo
  adapter) into the worker's environment.
- A production task queue entry that carries the structured `tool` contract.
- A heartbeat + health check confirming the worker survives denied/failed
  tasks (the local bridge already survives them).
