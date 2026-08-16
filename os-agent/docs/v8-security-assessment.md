# V8 Embedder — Security & Design Assessment (Phase 14)

Status: `V8_STATUS = PRESENT` · `V8_INTEGRATION = NOT_INTEGRATED` (deferred)

This is a READ-ONLY assessment of the existing `v8-embedder/` project. It is
**not** integrated into MESH or the overnight runner. No native code was
compiled and no untrusted code was executed during this assessment.

## What exists

- Rust `V8Host` built on `rusty_v8` (no manual V8 build).
- A single V8 `Isolate` with a configurable heap limit (`--max-heap-mb`, default 128 MB).
- `src/main.rs` CLI: run a JS file, create a snapshot, or load a snapshot (warm start).
- `src/host/mod.rs`: isolate wrapper — compiles and runs a script from a file path.
- SWC TypeScript→JS stripper (`ts-runner/strip.ts`) feeding the host.
- Snapshot warm-start path (`snapshots/init_blob.bin`).

## Host bindings exposed to JavaScript

Based on inspection of `src/host/mod.rs` and `src/main.rs`:

| Capability | Exposed to JS? |
|---|---|
| Filesystem | **No** — no host binding registered |
| Network | **No** |
| Process / child processes | **No** |
| Environment variables | **No** |
| Native modules / N-API | **No** |
| Timers | **No** |
| Dynamic imports / module loader | **No** (bare `Script::compile`/`run`) |

The JS runs as a bare compute sandbox with **no host functions registered**.
This is a relatively clean boundary for pure computation.

## Enforcement gaps (must be closed before any integration)

| Control | Status |
|---|---|
| Memory limit | ✅ `max_old_space_size` heap cap (default 128 MB) |
| CPU / execution timeout | ❌ **Not enforced** — no `terminate_execution` / interrupt hook; an infinite loop would consume CPU indefinitely |
| Execution termination / kill | ❌ Not implemented |
| Promise / microtask runaway | ⚠️ No external event loop drives it, but no explicit termination either |
| Timer survival | N/A — no timer API exposed |
| Exception escape | ✅ `TryCatch` catches exceptions and returns them as errors (does not crash the host) |
| Native code reachability | ✅ None exposed to JS |
| `unsafe` Rust | ⚠️ Present (raw isolate pointer) — standard for `rusty_v8`, but must be reviewed for the intended trust boundary |

## How MESH would authorize V8 execution (design only)

- A `v8.run` tool would be added to the MESH capability registry, gated by
  capability + risk + workspace boundary + approval, exactly like every other tool.
- The host would expose **only explicitly allowlisted host functions** (none today).
- A hard **CPU timeout** and **terminate_execution** hook must be added before
  untrusted code is ever run.
- Heap limit, single-isolate lifecycle, and a kill mechanism must be verified.
- The JS would only be able to call back into host functions that MESH permits.

## Recommendation

Do **not** integrate V8 into the overnight runner or MESH yet. The current
embedder has no CPU/termination enforcement and no host-function capability
gate. It is a promising future execution substrate, but it requires a separate
security validation pass (timeout + termination + capability-gated host
functions) before it could be a MESH execution backend.
