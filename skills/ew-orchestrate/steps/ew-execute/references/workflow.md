# Workflow: Execute

Wave-based parallel execution with checkpoint resume, optional atomic commits (`--auto-commit`), and a scoped smoke self-check handing off to `ew-review`.

## Iron Law

Never mark a task completed without running its convergence criteria, verifying outputs match the task definition, and recording reproducible evidence.

---

## Step 0: Plan Availability & Degradation Routing

Resolve `current-plan` via the Run packet's `upstream_aliases`:
- **Plan present**: proceed to Step 1.
- **Plan absent**: follow the Degradation Routing table in [preparation](prepare.md). Use `evolve run cancel` or `evolve run transition <run_id> blocked` with `--session`, `--actor`, `--expected-orchestration-revision`, and `--expected-run-revision`, documenting reason, available upstream, and target command in `report.md` `next`/`concerns`. **Never proceed to Step 1+ without a plan.**

## Step 1: Parse Execution Options

If `-y` is set (skipping all interactive prompts) or `plan` already specifies execution settings, use defaults. Otherwise resolve via structured prompt (`ask_question` or host equivalent; OMP `ask`) across enabled tools (`agent` / `codex` / `agy` / `omp`), preserving existing defaults:
- `executionMethod` (`auto` | `agent` | `cli` | tool) and `domainRouting` (`{frontend, backend, default: "agent"}`)
- `codeReviewTool` (optional post-execution diff review tool or `Skip`)
- `verificationTool` (smoke self-check tool or `Skip`)

## Step 2: Load & Normalize Plan

Read `current-plan`:
- If `plan.source_format == "pi-markdown"`, derive tasks, explicit/sequential dependencies, waves, and acceptance checks in memory from `plan.markdown` without overwriting `current-plan` or requiring `task_ids`/`wave_ids`.
- Otherwise load structured waves/tasks directly.

Resolve `executionMethod`, `defaultExecutor`, and `domainRouting`. **Checkpoint resume**: scan persisted task statuses (or `current-execution`/checkpoint records for `pi-markdown`) and start from the first wave containing incomplete tasks.

## Step 3: Load Project Rules

Reuse bound `session-priors` for covered `coding` Wiki scope. Query `wiki_context` + `wiki_reference` (or CLI fallback `evolve context "<query>" --session <session> --include-memory --reads "<run-dir>/knowledge-reads.json"` with `--from-search`) for additional paths/categories, and pass resolved constraints into each Step 4 task prompt.

## Step 4: Wave Parallel Execution

- **Executor routing** (priority: task assignment > explicit method > auto domain routing):
  - `frontend` (`.tsx/.jsx/.vue/.css/.html` or UI scope), `backend` (`.go/.rs/.java/.py/.sql/.proto` or API/DB scope), `general` (mixed, `.ts/.js`, config, tests). Log before dispatch: `TASK-001 [frontend] -> <executor>`.
- **Prompt skeleton**: include `PURPOSE`, `TASK`, `MODE: write`, `CONTEXT`, `EXPECTED`, `CONSTRAINTS` (task files + specs), task definition (`Files`, `Read First`, `Implementation`, `Convergence Criteria`), prior wave summaries, and resolved Wiki constraints.
- **Execution loop** (serial across waves, parallel per independent task inside each wave — never merge unrelated tasks into one delegate call; join all spawned subagents before ending a wave):
  - **`agent` path**: launch executor subagent (`invoke_subagent` / host subagent with fresh context; OMP `task` agent via native `task` or eval `agent()`, batching independent items with shared `context` + `tasks[]`) to implement -> verify convergence -> auto-fix (<=3 attempts) -> commit only if `--auto-commit` -> write `evidence/summaries/${task.id}.md` -> report status/checkpoint. OMP results auto-deliver; join/cancel all children before ending the wave, never poll.
  - **`cli` path**: run `evolve delegate "${prompt}" --to ${executor} --mode write` (include `--session ${session_id} --run ${run_id}` for Codex/OMP; Agy stays standalone), verify convergence criteria against disk, write `evidence/summaries/${task.id}.md`, and commit only if `--auto-commit`. OMP optional `--role` selects a model only; `--model` overrides it, never grants permission or enters Plan mode.
- **Failure handling**: up to 3 focused retries (for CLI retries, narrow prompt then fall back to a subagent). After 3 failures, mark `blocked` with checkpoint `{attempt: 3, last_error, partial_files, executor}` and mark unmet downstream dependents `upstream_blocked`. Between waves, prompt only if a task blocked and `-y` is unset.

## Step 5: Post-Wave Validation

1. Check completed tasks have `evidence/summaries/${task.id}.md` (`missing_summary` warning).
2. Cross-check task statuses vs wave results (mismatch = critical).
3. Scan changed files against spec `allowed_languages`/`disallowed_imports` (hit = critical `tech_stack_violation`).
4. Optional CLI diff check via `evolve delegate "<review changed files for cycles/dead code/breaking changes>" --to codex|agy|omp --mode analysis`; bind Codex/OMP with both `--session`/`--run`. For an independent second opinion explicitly select an authorized different model (OMP `--model <selector>`), not a same-model child.

Any critical failure marks the run `blocked` with recorded violations.

## Step 6: Optional Diff Review

Unless `codeReviewTool == "Skip"`, run `evolve delegate "<review git diff>" --to ${codeReviewTool} --mode analysis` and record summary findings.

## Step 7: Scoped Smoke Self-Check

Unless `verificationTool == "Skip"` or zero tasks completed, run one scoped smoke pass (narrowest build/test suites covering changed files + convergence evidence, existence, substance, wiring, and anti-pattern scan for `TODO`/`FIXME`/disabled tests) and write `outputs/self-check.json` (`overall: "passed"|"gaps_found"`). Note: `gaps_found` does **not** fail `self-check-passed`; record concerns for formal acceptance in `ew-review`.

## Step 8: Write Outputs & `report.md`

Write `outputs/execution.json` (`_meta: { kind: "artifact", schema: "artifacts/1.0", role: "primary", alias: "current-execution" }`, `plan_ref`, `status: completed|partial|blocked`, `waves[]`, `completed_tasks[]`, `blocked_tasks[]`), `outputs/task-results.json`, `outputs/change-manifest.json`, plus `outputs/self-check.json` (each JSON carrying matching `_meta`).

Write `report.md` with fixed sections (`Summary`, `Conclusion/Verdict`, `Discussion/Retrospective`, `Artifacts`, `Handoff/Next`), inline GateRecords for `execution-complete` and `self-check-passed`, and frontmatter:
- `verdict`: `ready` (all succeeded), `ready_with_concerns` (non-critical blocked or smoke gaps), `blocked` (critical failure), `failed` (execution errored).
- `next`: `[{ command: ew-verify, reason: implementation complete, needs: [current-execution] }]`.

## Step 9: Knowledge Staging & Seal

Inspect `evidence/summaries/*.md`, deduplicate new patterns/pitfalls against Step 3 rules, and stage reusable findings through `report.md` frontmatter (`constraints`/`decisions`) for closeout via `ew-knowledge` (`evolve workflows show knowledge`). Never write Wiki files directly.
Seal via fenced `evolve run complete <run_id> --session <session> --actor <actor> --expected-orchestration-revision <rev> --expected-run-revision <rev> --gate execution-complete --gate self-check-passed --summary "<summary>" --verdict done|done_with_concerns` (recover blocked/failed attempts via `evolve run check` + `evolve run transition`).

---

## Error Codes

| Code | Condition | Recovery |
|------|-----------|----------|
| `E001` | No plan and no usable upstream | Run `ew-plan` first or route per Step 0 |
| `E002` | Entire wave blocked | Stop execution, mark dependents `upstream_blocked`, report checkpoint |
| `W001` | Task definition missing | Record error, skip task, continue wave |
| `W002` | Subagent dispatch failed | Retry once, mark `blocked` if still failing |
| `W003` | Delegate failed | Retry with narrowed prompt or subagent (max 3), then checkpoint `blocked` |
| `W004` | `--auto-commit` failed | Record warning; do not claim commit completion |
