# Pre-flight: ew-execute

Verify plan availability, upstream compatibility, and execution invariants before running [workflow](workflow.md).

## Degradation Routing (when `current-plan` is absent or already completed with unaddressed findings)

Never proceed to Step 1+ without active incomplete tasks, and never fabricate a plan artifact or silently skip bound `latest-review`/`latest-debug` findings when all tasks in `current-plan` are already completed (unless re-running a specific `--task`). Inspect injected upstreams and route:

| Condition & available upstream | Scope | Action |
|---|---|---|
| `current-plan` absent + `latest-review` | `<= 3` findings, each `<= 2` files (single concern) | Cancel/transition Run -> Evolve internal `ew-companion` route with `latest-review` |
| `current-plan` absent + `latest-review` | `> 3` findings or cross-module | Cancel/transition Run -> `ew-plan --gaps` (or `ew-odyssey-planex`) |
| `current-plan` 100% completed + unaddressed `latest-review` (no `--task`) | Any actionable finding | Do NOT complete as a no-op -> Cancel/transition Run -> `ew-companion` (`<= 3` findings, `<= 2` files) or `ew-plan --gaps` |
| `current-plan` absent (or 100% completed) + `latest-debug` (`latest-fix-directions`) | `<= 2` files vs `> 2` files | `ew-companion` if `<= 2` files; `ew-plan --gaps` (or `ew-odyssey-planex`) otherwise |
| `current-plan` absent + no usable upstream | — | Report `E001`, transition Run `blocked` / cancel, require `ew-plan` first |

Never call `run complete` without real executed work and `outputs/execution.json` — exit degradation via `evolve run cancel` (or `evolve run transition ... blocked`) per `evolve skill workflows show session-run` and record the re-route reason in `report.md` (`concerns`/`next`).

## Artifact Compatibility Recovery

For an incompatible sealed input, inspect it via `evolve run read artifact`, cancel the attempt with current revision fences, insert a producer step ahead of the pending consumer to republish a derived compatibility artifact + receipt, verify publication, and dispatch via `evolve run create`. Never bypass with chain skip, Run rebind, registry mutation, or mutating the source artifact.

## Execution Invariants

- **Plan interpretation**: handle `source_format: pi-markdown` by deriving ordered tasks, dependencies, and acceptance checks from `markdown` without writing back over `current-plan`.
- **Same-wave safety & commits**: parallelize only non-colliding `files[]` per wave; atomic git commits run only when `--auto-commit` is enabled.
- **Evidence & smoke scope**: record real per-task commands, files, and convergence checks (<=3 fix attempts before `blocked` checkpoint + `upstream_blocked` propagation). `self-check` is only a scoped build/test smoke before `ew-verify` (structural/coverage + canonical static anti-pattern scan) and `ew-review` (formal multi-dimensional acceptance) — `gaps_found` does not block completion.
- **Incremental learnings & issues**: track `issue_id` resolution (`open`/`registered` -> `analyzed` -> `planned` -> `resolved`) in `outputs/execution.json`/`task-results.json`, and update an external issue tracker ONLY with explicit user authorization (confirm unless previously authorized; `-y` alone does not grant external write authorization); hand off candidate staging to `ew-knowledge` (`evolve skill workflows show ew-knowledge`) at wrap-up without writing Wiki files directly.
