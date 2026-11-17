# Workflow: Plan

5-step pipeline: Context Collection -> Clarification -> Planning -> Plan Checking & Collision -> Confirmation.

Produces `outputs/plan.json` + `outputs/tasks/TASK-{NNN}.json` + `outputs/waves.json`, `outputs/dependency-graph.json`, `outputs/collision-report.json` (plus `outputs/plan-check.json` when checked).

## Modes & Topology

```
Create (default): Step 1 -> Step 2 -> Step 3 -> Step 4 -> Step 4.5 -> Step 5
--tdd:            Step 1 -> Step 2 -> Step 3 (TDD chain) -> Step 4 -> Step 4.5 -> Step 5
--revise:         Load existing plan -> apply targeted diff -> Step 4 -> Step 4.5 -> Confirm
--check <dir>:    Step 4 only (read-only)
```

- **Scope selection**: `--from <alias>` uses upstream `implementation_scope`; `--gaps` plans issue/review/verification/debug gap fixes (skipping Step 1 exploration); numeric arg / active milestone targets milestone scope; otherwise use latest `ew-analyze` findings or fail `E001`.
- **Agent topology**: <=3 modules -> 1 planner subagent (<=8 tasks); >3 modules -> 2+1 (2 parallel planners <=8 tasks each + 1 synthesis subagent, <=16 tasks total). Always join/await all spawned subagents before advancing.

## Blocking Step Gates (Create mode)

| Gate | Requirement to advance |
|------|------------------------|
| `context-collected` (1 -> 2) | Upstream context/exploration and codebase/Wiki rules loaded (`E001` if zero context) |
| `plan-generated` (3 -> 4) | Planner subagent produced `outputs/plan.json` + `outputs/tasks/TASK-*.json` (inline planning forbidden) |
| `plan-checked` (4 -> 5) | Plan checker passed (zero unresolved criticals), boundary grill + 5-dim confidence + >=1 pressure pass completed, UI waves cover `[UI-observable]` |
| `plan-confirmed` (5 -> wrap-up) | User confirmed (`-y` auto-confirms) before registering/reporting completion |

---

## Process

### Step 1: Context Collection

1. **Upstream decisions** (via injected aliases):
   - `current-analysis`: treat `decisions[class=locked]` as hard constraints, `[free]` as implementer discretion, `[deferred]` as excluded; map `implementation_scope` 1:1 to tasks when present (skipping parallel exploration).
   - `latest-review`: normalize BLOCK findings (`finding_id`, `affected_files`, `location = file:line`) and cluster shared root causes within normal task guardrails.
   - `current-blueprint` / optional `current-roadmap`: extract seed requirements and milestone boundaries.
   - `architecture_template_evidence`: inherit read-only from `current-analysis`, `blueprint`/`brainstorm` `references[]`, or upstream research findings — never re-search.
2. **Project knowledge & codebase**: apply bound `session-priors`. When adding new task paths/categories, inspect Wiki/Memory via Run MCP (`wiki_context` + `wiki_reference`, `memory_search` + `memory_get`) or CLI-only fallback (`evolve context "<query>" --session <session> --include-memory --reads "<run-dir>/knowledge-reads.json"` + `--from-search`). Run `evolve code search "<keywords>"` after the Knowledge Gate.
3. **Design tokens (UI)**: load `design-ref/MASTER.md` if present and include token/layout refs in UI tasks' `read_first[]`.
4. **Parallel exploration** (skip if `--gaps` or upstream `implementation_scope` exists): launch 1-4 exploration subagents (`invoke_subagent` / host subagent; OMP `scout` via native `task`/eval `agent()`, shared `context` + `tasks[]`; join/cancel before continuing, never poll) covering architecture, implementation, integration, and risk -> write `evidence/exploration-{angle}.json`. Optionally run `evolve delegate "<patterns/dependencies/collisions>" --to codex|omp --mode analysis --session <session> --run <run>` (or `--to agy --mode analysis` outside Run binding). Strict OMP analysis requires this separate CLI process.
5. **Gap mode (`--gaps`)**: merge sources by priority — issue tracker (`registered`/`diagnosed`, mark `planning`) -> `latest-review` -> `verification.json` -> `uat.md` Gaps -> `latest-debug`. Deduplicate by ID then root cause + files, cluster to respect task limits, and error `E001` if empty.

### Step 2: Clarification (skip if `-y`)

Deduplicate blocking/important `clarification_needs[]`, clarify via structured prompt (`ask_question` or host equivalent, up to 3 rounds x 4 questions), and store `clarificationContext`.

### Step 3: Planning

Launch a planner subagent (or 2+1 topology; join all subagents before Step 4). **Inline planning in the main flow is forbidden.** Pass upstream context, `session-priors`/Wiki constraints, `explorationContext`, `clarificationContext`, and inherited `architecture_template_evidence`.

- **Guardrails**: simple <=4 tasks, medium <=8, large (>3 modules) <=16; 1 feature = 1 substantial task (15-60m, batch <5m trivial edits); `depends_on` only for real output dependencies; vertical UI slices with >=1 `[UI-observable]` criterion per delivery wave.
- **Every `TASK-NNN.json` must include**:
  1. `read_first[]`: target modified files + source-of-truth/pattern files.
  2. `convergence_criteria`: concrete grep/test/CLI verifiable assertions (zero subjective words like "looks correct").
  3. `action` & `implementation`: exact signatures, keys, values, import paths (never "align X with Y").
  4. `architecture_template_refs`: only resolved `template_id` values present in `plan.json.shared_context.architecture_templates`.
- **`--gaps` tasks**: `type: fix`, retaining `issue_id` (update matched issues to `planned`) and `finding_refs[]`.

### Step 4: Plan Checking & Step 4.5: Collision Detection

1. Launch a mandatory **plan checker subagent** (joined before continuing) to verify requirement coverage, DAG acyclicity, grep-verifiable convergence, `read_first[]` completeness, concrete actions, same-wave write non-collision, UI coverage, and valid `architecture_template_evidence` (`kind=template`, `reference_only=true`, resolved IDs only, absent from knowledge consumption fields). Run up to 3 revision loops on criticals.
2. Score 5 dimensions (`requirements_coverage`, `task_quality`, `dependency_correctness`, `estimation_accuracy`, `collision_safety`) weighted by `completeness .30`, `specificity .25`, `structural_validity .20`, `user_validation .15`, `consistency .10`, plus >=1 mandatory **Pressure Pass** on the highest-complexity task.
3. Run boundary review (`skills/ew-orchestrate/references/boundary-grill.md`) if boundary/write conflicts arise, writing `boundary_grill[]` inside `outputs/plan.json` (never raw Markdown inside `.json`).
4. Block before Step 4.5 if coverage <40%, missing `read_first`/`convergence`, no pressure pass, cycle, or invalid template ref (unless user confirms into `residual_risks`).
5. **Collision Detection (Step 4.5, skip if `standalone`)**: intersect new `task.files[]` (write targets only, not `read_first[]`) against existing milestone plans -> write `outputs/collision-report.json`.

### Step 5: Confirmation

Present objective, task/wave counts, key dependencies, confidence %, weakest dimension, and pressure pass result. Prompt via structured choice (`Execute now` / `Re-verify stricter` / `View` / `Modify`; `-y` auto-confirms).

---

## Output Skeleton

- **`outputs/plan.json`**: `{ objective, requirement_refs[], task_ids[], wave_ids[], confidence, constraints[], acceptance_criteria[], shared_context: { architecture_template_search, architecture_templates[] } }` (also admits `plan/1.0` `pi-markdown` approved variant).
- **`outputs/tasks/TASK-NNN.json`**: `{ _meta: { kind: "plan-task", schema: "plan-task/1.0", role: "attachment" }, id, title, description, requirement_refs[], deps[], files[], read_first[], convergence_criteria[], verify[], status: "pending" }`.
- **`outputs/waves.json`**, **`outputs/dependency-graph.json`**, **`outputs/collision-report.json`**, **`outputs/plan-check.json`**.

### Wrap-up

Write `outputs/plan.json` (carrying `_meta: { kind: "plan", schema: "plan/1.0", role: "primary", alias: "current-plan" }`) and `TASK-NNN.json` / `waves.json` / `dependency-graph.json` / `collision-report.json` / `plan-check.json` (all with matching `_meta`). Write `report.md` with frontmatter (`verdict`, `summary`, `constraints`, `decisions`, `concerns`, `next: [{ command: ew-execute, reason: plan ready, needs: [current-plan] }]`) and sections `Summary`, `Conclusion/Verdict`, `Discussion/Retrospective`, `Artifacts`, `Handoff/Next`. Reference `current-plan` via `{{aref:...}}` rather than copying JSON. Seal via fenced `evolve run complete <run_id> --session <session> --actor <actor> --expected-orchestration-revision <rev> --expected-run-revision <rev> --gate context-collected --gate plan-generated --gate plan-checked --gate plan-confirmed --summary "<summary>" --verdict done|done_with_concerns` (recover blockers via `evolve run check` + `evolve run transition`). Hand off candidate staging/review to `ew-knowledge` (`evolve workflows show knowledge`) while keeping `report.md` frontmatter staging (`constraints`/`decisions`).

---

## Revise (`--revise`) & Check (`--check`)

- **`--revise`**: locate `--dir` or bound `current-plan` (`E004` if none), parse instructions (or prompt via structured choice), run planner subagent (joined) to update affected tasks in place while preserving upstream `architecture_template_evidence`, re-run Step 4 + 4.5, confirm, and write updated `outputs/plan.json` + tasks before sealing.
- **`--check <dir>`**: read-only inspection (`E005` if missing) -> run checker, dependency, collision, and milestone alignment checks -> print pass/warn/fail summary without editing repository files (when run inside a bound Run, emit `outputs/plan-check.json` and read-only `outputs/plan.json` copy to satisfy contract gates before sealing).

## Error Codes

| Code | Condition | Recovery |
|------|-----------|----------|
| `E001` | No usable planning context | Supply scope, topic, or upstream artifact first |
| `E004` | No plan to revise | Specify `--dir` or create a plan first |
| `E005` | Plan directory missing (`--check`) | Verify path / `--dir` |
| `E006` | Invalid planner JSON | Retry once with schema reminder, then abort |
| `W001` | Exploration subagent failed | Retry once; mark missing angle and verify in code before confirming |
| `W002` | Plan checker exceeded 3 rounds | Surface remaining issues in `outputs/plan-check.json` for user decision |
