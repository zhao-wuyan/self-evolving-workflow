# Workflow: Odyssey Planex

Single requirement delivery loop — requirement parsing → acceptance criteria → plan → execute → verify → generalize. Follow [shared phases](odyssey-base.md) and [runtime adapters](runtime-adapters.md).

---

## State Chain

```
S_INTAKE → S_PLAN → S_EXECUTE → S_VERIFY → S_FIX → [back-half]
```

FIX↔VERIFY loop until all criteria pass. Back-half: `S_GENERALIZE → S_DISCOVER → S_RECORD → END` (see [shared phases](odyssey-base.md) §Shared Back-Half).

---

## Boundary

**In scope:** Single requirement delivery loop — requirement parsing → all acceptance criteria passing + generalization.
**Out of scope:** Multi-requirement orchestration → `/ew-orchestrate --goal roadmap` | Deep debugging → `--mode debug` | Code review → `--mode review` | UI optimization → `--mode ui`

---

## Context

### `--template <name>`

| Template | Criteria pattern | Use case |
|----------|-----------------|----------|
| `feature` | User story acceptance + boundary tests + UI verification | New feature |
| `bugfix` | Regression tests + root cause confirmation + boundary coverage | Bug fix |
| `refactor` | Behavior preservation + performance baseline + API compatibility | Refactoring |
| `migration` | Data consistency + rollback verification + performance comparison | Data/API migration |
| `api-endpoint` | Request/response contract + error handling + permission checks | API development |

### Target Resolution

Requirement parsed from `<intent>`.

### Session Fields

```json
{ "requirement": "",
  "acceptance_criteria": [{"id":"AC1","criterion":"","verify_method":"test|grep|cli-review|manual","status":"pending","evidence":"","passed_at":null}],
  "plan": {"tasks":[{"id":"T1","title":"","description":"","criteria_refs":["AC1"],"status":"pending","files_modified":[],"domain":"general","executor":"agent"}],"created_at":""},
  "execution_config": {"method":"auto","default_executor":"","domain_routing":{"frontend":"","backend":"","default":"agent"},"code_review_tool":"Skip","verification_tool":"Auto","confirmed":false},
  "iterations": [{"iteration":1,"started_at":"","completed_at":"","criteria_before":{"passed":0,"total":0},"criteria_after":{"passed":0,"total":0},"gaps_fixed":[],"files_modified":[]}],
  "current_iteration": 0,
  "patterns": [], "generalization_stats": null }
```

### evidence.ndjson Phases

`planning|execution|verification|fix|decision|generalization|discovery|self-iteration`

### phase_goals[]

| ID | Goal | done_when | phase | skip_when |
|----|------|-----------|-------|-----------|
| G1 | Acceptance criteria defined | ≥1 criterion in acceptance_criteria[] | S_INTAKE | — |
| G2 | Plan created | session.json.plan populated | S_PLAN | — |
| G3 | Implementation complete | all plan tasks executed | S_EXECUTE | — |
| G4 | All criteria pass | all acceptance_criteria[].status == passed | S_VERIFY | — |
| G5 | Pattern generalized | patterns[] ≥1 entry | S_GENERALIZE | skip_generalize |
| G6 | Discoveries triaged | all scan hits classified | S_DISCOVER | skip_generalize |
| G7 | Learnings persisted | spec entries created OR no actionable | S_RECORD | — |

### understanding.md — 8 Sections

1. Requirement & Criteria
2. Plan
3. Execution
4. Verification
5. Fix Log
6. Generalization
7. Discoveries
8. Learnings

---

## State Machine

### Transitions

```
S_PLAN    → S_EXECUTE
S_EXECUTE → S_VERIFY
S_VERIFY → S_GENERALIZE   : all passed AND !skip_generalize
S_VERIFY → S_RECORD       : all passed AND skip_generalize
S_VERIFY → S_FIX          : some failed AND iteration < max
S_VERIFY → S_PLAN         : fundamental plan flaw → cross_phase_loops++ (replan). Criteria preservation: acceptance_criteria[] statuses preserved; only plan.tasks[] regenerated. Passed criteria retain `passed`; failed criteria reset to `pending` for re-verification.
S_VERIFY → S_RECORD       : some failed AND iteration >= max (escalate)
S_FIX → S_VERIFY (loop)
```

Discover routes to S_EXECUTE (not FIX): area needing same implementation → new task, `cross_phase_loops++`.

### Actions

**A_INTAKE extra** — Define acceptance criteria: analyze requirement → derive testable criteria, each with `verify_method` (test|grep|cli-review|manual). Normal: structured prompt to confirm/edit | `-y`: auto-derive, record `{"phase":"decision","type":"criteria-confirmation","status":"deferred"}`. Mark G1.

**GATE: criteria-defined** — ≥1 criterion in `acceptance_criteria[]`, each with a testable `criterion` and assigned `verify_method` (test|grep|cli-review|manual); confirmed by user or auto-derived with deferred confirmation under `-y`; G1 marked.

**A_PLAN** — (1) Decompose requirement into ordered tasks mapped to acceptance criteria. (2) CLI-assisted planning (optional):
```bash
evolve delegate "PURPOSE: Create implementation plan for: {requirement}
TASK: Decompose into subtasks | Map to acceptance criteria | Identify dependencies
MODE: analysis
CONTEXT: @**/* | Criteria: {criteria_summary}
EXPECTED: JSON [{task_id, title, description, criteria_refs, deps}]
" --to codex --mode analysis
```
(3) Write `session.json.plan`, append evidence (planning), update §2. Mark G2.

Commit: `"odyssey-planex({slug}): PLAN — requirement decomposed into tasks"`

**A_EXECUTE** —

- **Step 1 — Execution Options Confirmation.** Skip if `-y` OR `--method` explicitly set OR `execution_config.confirmed == true` (resume). Load tools: `the Codex, Agy, or OMP executables available to the host` (preserve existing defaults). Prompt via structured prompt (OMP `ask`; 3 questions): Executor (Auto domain routing | Agent all | specific CLI | custom) / Review (Skip | {tool}) / Verify (Auto | specific tool | Skip). Parse → write `execution_config`, set `confirmed: true`. `--skip-verify` overrides verification to `"Skip"`.

- **Step 2 — Executor Resolution** (method == "auto"): domain routing — frontend (UI/component/page/style, .tsx/.jsx/.vue/.css/.html/.svelte) | backend (API/server/db/service, .go/.rs/.java/.py/.sql/.proto) | general (mixed/config/tests, .ts/.js/other). Resolution: `execution_config.domain_routing[domain]` or default `"agent"`.

- **Step 3 — Task Execution** per plan order (independent tasks may parallelize cleanly via joined subagents — see [runtime adapters](runtime-adapters.md)). **Agent path:** launch subagent (OMP `task` for implementation, shared `context` + `tasks[]` or eval `agent()`; results auto-deliver, join/cancel before advancing, never poll) with task definition + criteria refs + prior task summaries + specs_content → implement → verify convergence → auto-fix (max 3) → return. **CLI path:** use the selected enabled executor; append both `--session <id> --run <id>` for bound Codex/OMP, never for standalone Agy. OMP role/model/permission rules are in runtime adapters.
```bash
evolve delegate "PURPOSE: Implement task ${task_id}: ${title}; success = criteria ${criteria_refs} satisfied
TASK: ${description} | Read existing code first | Verify convergence criteria after changes
MODE: write
CONTEXT: @${scope}/**/* | Criteria: ${criteria_summary}
EXPECTED: Working code changes, convergence evidence, summary of what was done
CONSTRAINTS: Scope limited to task files | Follow project specs

## Acceptance Criteria (must satisfy)
${criteria_refs.map(ref => criteria[ref].criterion).join('\n')}

## Implementation Steps
${task.description}

## Project Specs
${specs_content}

## Prior Task Summaries
${prior_summaries}
" --to ${resolved_executor} --mode write
```
**Deviation Rule (MANDATORY hard limit — max 3 retries per task):** first attempt normal dispatch → retry with simplified self-contained prompt via `evolve delegate "<simplified prompt>" --to ${resolved_executor} --mode write` → switch to Agent path → all 3 fail → mark task `blocked`, checkpoint, continue remaining. NEVER exceed 3 attempts on a single task.

- **Step 4 — Per-Task Evidence:** `{"phase":"execution","type":"task-completed","task_id":"T1","executor":"...","files_modified":[],"summary":"","attempt":1}`; update task status.

- **Step 5 — Post-Execution Validation.** Skip if `verification_tool == "Skip"` OR `--skip-verify` OR no completed tasks. **Check 1** Summary Consistency (task status vs git diff). **Check 2** CLI Verification Gate:
```bash
evolve delegate "PURPOSE: Verify execution output meets acceptance criteria; success = all criteria verified with file:line evidence
TASK:
1. CONVERGENCE: For each criterion, read actual code, verify behavior exists, report status with evidence
2. EXISTENCE: Verify all expected files exist on disk
3. SUBSTANCE: Verify real implementation — flag stubs, placeholders, TODO-only
4. ANTI-PATTERNS: Scan for TODO/FIXME/HACK, console.log debug, disabled tests
MODE: analysis
CONTEXT: @${modified_files}
EXPECTED: JSON { convergence: [{criterion, status, evidence}], issues: [{type, file, line, severity}], overall: passed|gaps_found }
CONSTRAINTS: Read-only | Check ALL criteria exhaustively | Evidence must be file:line

## Acceptance Criteria (verify each)
${acceptance_criteria.map(c => c.criterion).join('\n')}

## Modified Files
${modified_files.join('\n')}
" --to ${execution_config.verification_tool} --mode analysis
```
`overall == "passed"` → proceed to S_VERIFY with boosted confidence; `gaps_found` → log findings, proceed. **Check 3** Code Review (if `code_review_tool != "Skip"`): `evolve delegate "Review git diff for correctness, style, bugs, and code quality" --to ${code_review_tool} --mode analysis`.

- **Step 6 — Completion:** update §3. Mark G3.

**GATE: plan-executed** — all plan tasks executed (`completed`) or explicitly `blocked` after 3 retries with logged evidence; per-task execution evidence recorded; post-execution validation (convergence, existence, substance, anti-patterns) completed unless `--skip-verify`; G3 marked.

Commit: `"odyssey-planex({slug}): EXECUTE — task implementation complete"`

**A_VERIFY** — Iron gate; verify each criterion by method:

| Method | Action |
|--------|--------|
| `test` | Run relevant tests, check pass/fail |
| `grep` | Grep for expected pattern |
| `cli-review` | `evolve delegate "PURPOSE: Verify criterion {id}: {criterion}\nTASK: Read implementation \| Check behavior \| Report pass/fail with file:line\nMODE: analysis\nCONTEXT: @{relevant_files}\nEXPECTED: JSON {criterion_id, status, evidence}" --to codex --mode analysis` |
| `manual` | Normal: structured prompt / `-y`: record `deferred` |

Record per criterion: `{"phase":"verification","type":"criterion-check","criterion_id":"AC1","method":"","result":"passed|failed","evidence":"","iteration":N}`. Update `acceptance_criteria[].status`. Append to `iterations[]`. Update §4 pass/fail table. **Route:** all passed → mark G4 → next. Some failed + iteration < max → S_FIX. Some failed + iteration >= max → Normal: structured prompt (continue/lower bar/accept) / `-y`: `deferred`, proceed S_RECORD.

**GATE: all-criteria-passed** — every `acceptance_criteria[].status == passed` with recorded evidence and `passed_at`, verified by the declared `verify_method`; iterations logged in `iterations[]`; if max iterations exceeded, criteria may be `deferred` only with explicit user consent (or `-y` auto-accept); G4 marked.

Commit: `"odyssey-planex({slug}): VERIFY — criteria verification iteration {N}"`

**A_FIX** — (1) Increment `current_iteration`. (2) For each failed criterion: diagnose gap → targeted code fix (not re-implementation). (3) CLI fix review (optional): `evolve delegate "Review fixes in git diff for regressions and return JSON {verdict, regression_risk, concerns}" --to codex --mode analysis`. (4) Append evidence (fix), update §5 → S_VERIFY.

Commit: `"odyssey-planex({slug}): FIX — iteration {N} gap fixes"`

---

## Generalize Source

Implementation patterns from executed tasks (API contract shapes, validation shapes, error response format, config structure).

---

## Iteration Model

```
S_EXECUTE → S_VERIFY ──all pass──→ S_GENERALIZE → S_DISCOVER → S_RECORD
                │                       │
           some fail + iter < max       3-layer scan, 0 hits ─→ S_RECORD
                ▼
             S_FIX ──→ S_VERIFY (loop)
```

Max iterations (default 3) prevents infinite loops.

---

## Knowledge Persistence (§8)

Include verified reusable findings in the Run summary and harvest the completed Session through `evolve workflows show knowledge` (`evolve closeout session` → `evolve wiki propose`).

| Category | Content | Follow-up |
|----------|---------|-----------|
| Multi-round fix cycle pattern | Problem scenario + fix iteration + final approach | `evolve closeout session` → `evolve wiki propose` (`category: debug`) |
| Reusable implementation pattern | Pattern + applicable scope + code template | `evolve closeout session` → `evolve wiki propose` (`category: coding`) |
| Acceptance criteria template | Standard template + verify_method suggestion | `evolve closeout session` → `evolve wiki propose` (`category: review`) |
| Generalization pattern | Signature + risk + fix template | `evolve closeout session` → `evolve wiki propose` (`category: coding`) |

---

## Completion Summary

```
--- PLANEX ODYSSEY COMPLETE ---
Requirement: {requirement}
Criteria:    {passed}/{total} passed
Iterations:  {N} cycles
Patterns:    {patterns_extracted} ({by_layer} distribution)
Scan hits:   {total_hits} ({cross_layer_confirmed} cross-layer confirmed)
Issues:      {N} created | Decisions: {N} resolved, {M} pending, {K} deferred
Learnings:   {N} spec entries
Self-iter:   {N} rounds across {M} stages
Goals:       {done}/{total} confirmed ({skipped} skipped)
Status:      {ALL_PASSED|PARTIAL|ESCALATED}
---
```

---

## Mode `-y` Points

| Decision Point | Normal | `-y` |
|---------------|--------|------|
| S_INTAKE criteria | structured prompt | auto-derive `deferred` |
| S_EXECUTE options | structured prompt | defaults (auto/Skip/Auto) `confirmed:true` |
| S_EXECUTE task blocked | structured prompt | auto continue, log blocked |
| S_VERIFY manual criterion | structured prompt | `deferred` |
| S_VERIFY max iteration | structured prompt | auto accept `deferred` |
| A_DISCOVER routing | structured prompt | auto-route to execute, issue for rest |

---

## Phase Gates

- **Audit gate** (PLAN+EXECUTE): plan tasks mapped to criteria; all tasks executed or blocked after 3 retries (`plan-executed`).
- **FIX gate:** every failing acceptance criterion receives a targeted fix scoped to the diagnosed failure without dropping/weakening criteria (`evidence phase=fix`), bounded by `--max-iterations`.
- **VERIFY gate:** every criterion verified by its declared `verify_method`; `all-criteria-passed` confirmed or max-iteration escalation consented (`needs_rework` routes back to FIX).

---

## Error Codes

| Code | Severity | Condition | Recovery |
|------|----------|-----------|----------|
| E001 | error | No requirement | Provide requirement or -c |
| W007 | warning | CLI review regression concern | Review before next iteration |

---

## Success Criteria

- [ ] Requirement parsed; session + output files created; acceptance criteria defined
- [ ] Plan decomposed into tasks mapped to acceptance criteria
- [ ] All tasks executed (or blocked after 3 retries); execution evidence logged
- [ ] understanding.md sections written progressively (§1–§8)
- [ ] Criteria verified by method (test/grep/cli-review/manual); fix loop if needed
- [ ] Multi-layer generalization + discovery triage (unless --skip-generalize)
- [ ] phase_goals derived, tracked, and hardened-audited; goal_mode injected via prepare goal:true
- [ ] Session resumable via -c; completion summary emitted
- [ ] Status: ALL_PASSED / PARTIAL / ESCALATED

---

See [shared base](odyssey-base.md) for generic follow-up routing (`Next Step Routing`). Related transitions: `/ew-odyssey <finding> --mode debug` (root cause), `/ew-odyssey <changed-files> --mode review` (formal review), `/ew-odyssey <component> --mode ui` (UI fixes).
