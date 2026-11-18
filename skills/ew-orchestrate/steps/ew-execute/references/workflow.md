# Workflow: Execute

Wave-based parallel execution with checkpoint resume, optional atomic commits (`--auto-commit`), and a scoped smoke self-check handing off to `ew-review`.

## Iron Law

Never mark a task completed without running its convergence criteria, verifying outputs match the task definition, and recording reproducible evidence.

---

## Step 0: Plan Availability & Degradation Routing

Resolve `current-plan`, `latest-review`, and `latest-debug` via the Run packet's `upstream_aliases`:
- **Plan present with incomplete tasks (or explicit `--task <TASK-ID>`)**: proceed to Step 1.
- **Plan absent, OR `current-plan` has zero incomplete tasks while unaddressed `latest-review` / `latest-debug` findings exist (and no `--task` override)**: follow the Degradation Routing table in [preparation](prepare.md). Exit via `evolve run cancel` or `evolve run transition <run_id> blocked` per `evolve skill workflows show session-run` (do NOT call `run complete` as a no-op), documenting reason, available upstream, and target command in `report.md` `next`/`concerns`. **Never proceed to Step 1+ without active tasks from a plan.**

## Step 1: Parse Execution Options

Apply explicit CLI flags first: `--task <TASK-ID>` (restrict execution to the specified task ID or comma-separated task IDs plus prerequisite checks), `--executor <tool>` (set `defaultExecutor` to `agent|codex|agy|claude|omp` without prompting), `--method <agent|cli|auto>`, `--auto-commit`, and `-y`.
If `-y` is set (skipping all interactive prompts) or `plan` already specifies remaining execution settings, use defaults. Otherwise resolve via structured prompt (`ask_question` or host equivalent; OMP `ask`) across enabled tools (`agent` / `codex` / `agy` / `claude` / `omp`):
- `executionMethod` (`auto` | `agent` | `cli` | tool) and `domainRouting` (`{frontend, backend, default: "agent"}`)
- `codeReviewTool` (optional post-execution diff review tool or `Skip`)
- `verificationTool` (smoke self-check tool or `Skip`)

## Step 2: Load & Normalize Plan

Read `current-plan`:
- If `plan.source_format == "pi-markdown"`, derive tasks, explicit/sequential dependencies, waves, and acceptance checks in memory from `plan.markdown` without overwriting `current-plan` or requiring `task_ids`/`wave_ids`.
- Otherwise load structured waves/tasks directly.

Resolve `executionMethod`, `defaultExecutor` (honoring `--executor` when provided), and `domainRouting`. **Task filter & checkpoint resume**: if `--task <TASK-ID>` is set, validate that the task exists (or `W001`) and execute only the targeted task(s) once dependencies are met; otherwise scan persisted task statuses (or `current-execution`/checkpoint records for `pi-markdown`) and start from the first wave containing incomplete tasks. If zero incomplete tasks exist and `latest-review`/`latest-debug` is bound, return to Step 0 Degradation Routing rather than completing as a no-op.

## Step 3: Load Project Rules

Complete the Run Knowledge Gate (`evolve skill workflows show session-run`): reuse bound `session-priors` for covered `coding` Wiki scope, and query `evolve search "<query>" --mode context` + `evolve kb get <id>` (with CLI `--reads`) for additional paths/categories, passing resolved constraints into each Step 4 task prompt.

When a concrete problem warrants cross-project research, optionally run `evolve experience status`, then search personal experience with a domain and versioned stack verified from the current project (for example `evolve experience search python python@3.12 "<problem>"`). Use non-sensitive query terms. Check applicability and conflicts before using a result. These references never override project rules or enter the required Knowledge Gate.

## Step 4: Wave Parallel Execution

- **Executor routing** (priority: task assignment > explicit `--executor` / `--method` > auto domain routing):
  - `frontend` (`.tsx/.jsx/.vue/.css/.html` or UI scope), `backend` (`.go/.rs/.java/.py/.sql/.proto` or API/DB scope), `general` (mixed, `.ts/.js`, config, tests). Log before dispatch: `TASK-001 [frontend] -> <executor>`.
- **Prompt skeleton**: include `PURPOSE`, `TASK`, `MODE: write`, `CONTEXT`, `EXPECTED`, `CONSTRAINTS` (task files + specs), task definition (`Files`, `Read First`, `Implementation`, `Convergence Criteria`), prior wave summaries, and resolved Wiki constraints.
- **Execution loop** (serial across waves, parallel per independent task inside each wave — never merge unrelated tasks into one delegate call; join all spawned subagents before ending a wave):
  - **`agent` path**: launch executor subagent (`workflow-executor` / `workflow_executor`, via `invoke_subagent` or host subagent with fresh context; fall back to inline role instructions when absent; OMP hosts use native `task` or eval `agent()`, batching independent items with shared `context` + `tasks[]`, and join/cancel all children before ending the wave without polling) to implement -> verify convergence -> auto-fix (<=3 attempts) -> commit only if `--auto-commit` -> write `evidence/summaries/${task.id}.md` -> report status/checkpoint.
  - **`cli` path**: run `evolve agent exec "${prompt}" --to ${executor} --mode write` (supports `codex|agy|claude|omp`; include `--session ${session_id} --run ${run_id}` when `--to codex` or `--to omp`; `--to agy` runs standalone without `--session`/`--run`), verify convergence criteria against disk, write `evidence/summaries/${task.id}.md`, and commit only if `--auto-commit`. For OMP, `--role` selects a model only, `--model` overrides it, and `--timeout` is milliseconds; neither grants permission nor enters Plan mode.
- **Failure handling**: up to 3 focused retries (for CLI retries, narrow prompt then fall back to a subagent). After 3 failures, mark `blocked` with checkpoint `{attempt: 3, last_error, partial_files, executor}` and mark unmet downstream dependents `upstream_blocked`. Between waves, prompt only if a task blocked and `-y` is unset.

## Step 5: Post-Wave Validation

1. Check completed tasks have `evidence/summaries/${task.id}.md` (`missing_summary` warning).
2. Cross-check task statuses vs wave results (mismatch = critical).
3. Scan changed files against spec `allowed_languages`/`disallowed_imports` (hit = critical `tech_stack_violation`).
4. Optional CLI diff check via `evolve agent exec "<review changed files for cycles/dead code/breaking changes>" --to codex|agy|claude|omp --mode analysis`; bind Codex/OMP with both `--session`/`--run`. For OMP, this is the one-shot restricted worker. For an independent second opinion explicitly select an authorized different model (OMP `--model <selector>`), not a same-model child.

Any critical failure marks the run `blocked` with recorded violations.

## Step 6: Optional Diff Review

Unless `codeReviewTool == "Skip"`, run `evolve agent exec "<review git diff>" --to ${codeReviewTool} --mode analysis` and record summary findings.

## Step 7: Scoped Smoke Self-Check

Unless `verificationTool == "Skip"` or zero tasks completed, run one scoped smoke pass (narrowest build/test suites covering changed files + convergence evidence and quick sanity checks; formal static anti-pattern scanning belongs to `ew-verify` and untracked residual audit to `ew-review`) and write `outputs/self-check.json` (`overall: "passed"|"gaps_found"`). Note: `gaps_found` does **not** fail `self-check-passed`; record concerns for `ew-verify` and formal acceptance in `ew-review`.

## Step 8: Write Outputs & `report.md`

Write `outputs/execution.json` (`_meta: { kind: "artifact", schema: "artifacts/1.0", role: "primary", alias: "current-execution" }`, `plan_ref`, `status: completed|partial|blocked`, `waves[]`, `completed_tasks[]`, `blocked_tasks[]`), `outputs/task-results.json`, `outputs/change-manifest.json`, plus `outputs/self-check.json` (each JSON carrying matching `_meta`).

Write `report.md` with fixed sections (`Summary`, `Conclusion/Verdict`, `Discussion/Retrospective`, `Artifacts`, `Handoff/Next`), inline GateRecords for `execution-complete` and `self-check-passed`, and frontmatter:
- `verdict`: `ready` (all succeeded -> seal `--verdict done`), `ready_with_concerns` (non-critical blocked or smoke gaps -> seal `--verdict done_with_concerns`), `blocked` (critical failure -> `run transition ... blocked`, do NOT call `run complete`), `failed` (execution errored -> `run transition ... failed`, do NOT call `run complete`).
- `next`: `[{ command: ew-verify, reason: implementation complete; structural verification before formal ew-review acceptance, needs: [current-execution] }]`.

## Step 9: Knowledge Staging & Seal

Inspect `evidence/summaries/*.md`, deduplicate new patterns/pitfalls against Step 3 rules, and stage reusable findings through `report.md` frontmatter (`constraints`/`decisions`) for closeout via `ew-knowledge` (`evolve skill workflows show ew-knowledge`). When execution resolves a non-obvious build/API/runtime pitfall, record a concise lesson via `evolve kb add --kind episodic "<lesson>" --type verified_fix --scene execute --session <session_id>`. Never write Wiki files directly.
Seal or transition the Run per `evolve skill workflows show session-run` with exit gates `--gate execution-complete --gate self-check-passed` (mapping `report.md` `verdict` per Step 8 and `session-run`).

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
