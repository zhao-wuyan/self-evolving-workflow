# Workflow: Analyze

Multi-dimensional iterative analysis: exploration -> multi-perspective synthesis -> discussion timeline -> intent tracking -> six-dimension scoring -> decision extraction.

## Mode & Pipeline

```
First positional arg matches ^\d+$ -> micro (milestone deep-dive)
First positional arg is non-numeric  -> macro (topic impact; mixed text counts as macro)
No arg + active milestone            -> current milestone micro; else macro
--gaps [ISS-ID]                      -> gaps ([issue gap analysis](issue-gaps-analyze.md))
-q                                   -> quick (skip Steps 2-5, jump from Step 1 to Step 6)
```

Full mode (`-q` and `--gaps` absent):
1. **Setup & Scoping** -> Knowledge/upstream load, scoping, `report.md` discussion init
2. **Exploration & Perspectives** -> `evidence/exploration-codebase.json`, `evidence/perspectives.json`
3. **Interactive Discussion** -> up to 5 rounds in `report.md` (with pressure pass & intent tracking)
4. **Six-Dimension Scoring** -> 6 dimensions (1-5) + risk matrix
5. **Synthesis & Conclusion** -> `outputs/findings.json`, `outputs/risk-matrix.json`, `report.md`
6. **Decision Extraction** -> `findings.json#decisions[]` (Locked/Free/Deferred)

In macro mode, Step 5 sets `scope_verdict`:
- `large`: 3+ independent subsystems or hard serial barrier -> downstream `ew-plan` with multi-subsystem decomposition
- `medium`: 1-2 parallelizable subsystems -> downstream `ew-plan`
- `small`: single or few-file change -> downstream `ew-plan`

## Blocking Step Gates (Full mode only)

| Gate | Requirement to advance |
|------|------------------------|
| `exploration-done` (2 -> 3) | Exploration subagent joined; `evidence/exploration-codebase.json` has >=1 code anchor; >=1 `evolve delegate` (or independent subagent) pass written to `evidence/perspectives.json`; baseline confidence recorded |
| `discussion-round` (3 -> 4) | >=1 interactive round with user feedback recorded; confidence re-scored >=1 time with delta; >=1 pressure pass completed |
| `scoring-complete` (4 -> 5) | All 6 dimensions scored citing exploration/perspective evidence (**manual Read alone is invalid**) |
| `intent-covered` (5 -> 6) | `outputs/findings.json` written; Intent Coverage Matrix has zero unhandled ❌ (or user-confirmed deferral) |

---

## Process

### Step 1: Setup & Scoping

1. **Upstream typed artifacts**: read only via injected alias->path (`upstream-context`, `current-blueprint`, `latest-debug`), never guess latest by mtime. Keep locked constraints fixed; prioritize open constraints/questions. Reuse `architecture_template_evidence` when present without re-searching.
2. **Project knowledge**: reuse `session-priors` when the scope matches; otherwise query `wiki_context` / `memory_search` and open hits with `wiki_reference` / `memory_get`. In CLI-only hosts, run `evolve context "<query>" --session <session> --include-memory --reads "<run_dir>/knowledge-reads.json"` and open selected IDs with `--reads ... --from-search ...`.
3. **Domain terminology & prior runs**: align with `arch` Wiki references, record new term candidates in `report.md`, and skip already-decided areas from same-milestone analyses.

**Quick routing (`-q`)**: jump directly to Step 6.

**Scoping** (skip if `-c`/`-y`; otherwise use a structured prompt such as `ask_question`, up to 3 questions):
1. **Analysis dimensions** (multiSelect, pick 3-4):
   - `architecture`: System Design, Component Interactions, Technology Choices, Design Patterns
   - `implementation`: Code Structure, Patterns, Error Handling, Algorithm Analysis
   - `performance`: Bottlenecks, Optimization, Resource Utilization, Concurrency
   - `security`: Vulnerabilities, Auth, Data Protection, Input Validation
   - `concept`: Foundation, Core Mechanisms, Patterns, Trade-offs
   - `comparison`: Solution Comparison, Pros/Cons, Technology Evaluation
   - `decision`: Criteria, Trade-off Analysis, Risk Assessment, Impact
   - `external_research`: Standard Stack, Architecture Patterns, Don't Hand-Roll, Common Pitfalls (auto-suggest for unfamiliar domains or empty codebase search)
2. **Analysis perspectives** (multiSelect, up to 4): Technical (implementation/feasibility), Architectural (design/scalability), Product/Business (value/impact), Domain Expert (standards/best practices).
3. **Depth** (single): Quick Overview / Standard / Deep Dive. (`-y` defaults: all relevant dimensions, single synthesis perspective, Standard depth.)

Initialize `report.md`: metadata, original User Intent, replaceable `Current Understanding` block, empty discussion timeline, dimension rationale.

### Step 2: Exploration & Multi-Perspective Analysis

**2.0 Research handoff** (only when `external_research` is active, or architecture patterns are active without upstream `architecture_template_evidence`):
1. If `external_research` is selected, run 2-3 targeted web searches (`search_web` in Antigravity or host equivalent) for stack, architecture patterns, and pitfalls.
2. Delegate synthesis (plus one focused architecture-template lookup if absent) to a `research` subagent (OMP: `scout`; joined before proceeding) returning markdown only: `## Standard Stack`, `## Architecture Patterns`, `## Don't Hand-Roll`, `## Common Pitfalls`, and optional `## Architecture Template Evidence` (preserve `no_match`/`load_failed` status cleanly). Store as in-memory `researchContext`.

**2.1 Codebase exploration** (mandatory subagent, not manual Read/Grep):
Launch exploration subagent(s) (`invoke_subagent` with `research` or host subagent; OMP: native `task`/eval `agent()` with `scout`, shared `context` + `tasks[]` for independent slices; join/cancel all before advancing, never poll) across three layers:
- **L1 Breadth**: relevant files and module boundaries (`relevant_files[]`)
- **L2 Depth**: top 3-5 files, 2-3 call/data-flow layers (`call_chains[]`, `data_flows[]`)
- **L3 Anchors**: 20-50 line `file:line` snippets (`code_anchors[]`)

Write merged anchors to `evidence/exploration-codebase.json` (plus optional per-perspective files `evidence/explorations/{perspective}.json` when running multi-perspective up to 4 parallel subagents).

**2.2 Cross-perspective analysis** (mandatory independent pass):
Run >=1 `evolve delegate "<exploration context prompt>" --to codex|agy|omp --mode analysis` (pass `--session <session> --run <run>` for Codex/OMP inside a bound Run; Agy stays standalone). Explicitly select an authorized second-opinion model (OMP: `--model <selector>`); claim cross-model independence only when it differs from the original model. Same-model subagents are not independent-model validation. Strict OMP analysis uses this separate CLI process, not native children. Append `researchContext` as non-binding recommendations if present. For multi-perspective runs, fan out up to 4 independent calls and collect/join all before continuing; results auto-deliver without polling.

**2.3 Aggregation & Round 1**: merge into `evidence/perspectives.json` (including `technical_solutions[]`: `{round, solution, problem, rationale, alternatives, status: proposed|validated|rejected, evidence_refs[], next_action}`), append Round 1 to `report.md`, check initial Intent coverage (✅/🔄/❌), and score baseline confidence across weights (`findings_depth .30`, `evidence_strength .25`, `coverage_breadth .20`, `user_validation .15`, `consistency .10`). `<60%` continue; `60-80%` confirm before converging; `>80%` ready for synthesis.

### Step 3: Interactive Discussion Loop (up to 5 rounds)

Per round:
1. State `Current Understanding` (Round >= 2) and present latest findings.
2. Prompt via structured choice (`ask_question` / host equivalent, skipped in `-y` which auto-deepens <=3 rounds) with header `Round {N} | Confidence: {overall}% | Weakest: {weakest_dim} ({dim_score}%)`:
   - **Go deeper** (recommended): pick sub-direction (up to 4 choices) -> targeted exploration -> merge
   - **Adjust direction**: capture new focus -> re-explore -> log decision delta
   - **Supplement information**: integrate user constraints/corrections -> verify via subagent/delegate if needed
   - **Analysis complete**: run readiness check -> proceed to Step 4
3. Record Round N narrative synthesis (`Starting point`, `Key progress`, `Decision impact`, `Current understanding`, `Remaining questions`), Intent Drift checks (❌/⚠️ surfaced next round), updated `technical_solutions[]`, confidence delta, and quality guards:
   - **Pressure Pass** (mandatory >=1 before Step 4): challenge highest-confidence finding (`evidence demand -> assumption probe -> boundary/tradeoff -> root cause`) under `#### Pressure Test`.
   - **Devil's Advocate** (dim > 0.7), **Scope Minimizer** (>5 findings), **Stall Detection** (2 rounds delta < 5%).
4. **Readiness Gate**: block "Analysis complete" if unhandled ❌, any dim < 40%, no pressure pass, unresolved contradiction, or overall < 80% (unless user explicitly accepts into `residual_risks[]`, or `-y` finishes 3 auto-rounds and records gaps in `residual_risks[]`).

### Step 4: Six-Dimension Scoring

Score each dimension 1-5 (`Feasibility`, `Impact`, `Risk`, `Complexity`, `Dependencies`, plus `Alternatives` with >=2 options N/A), citing exploration/delegate evidence and per-dimension confidence %. Build probability-impact risk matrix (`outputs/risk-matrix.json`), form `go | go_with_conditions | no_go` verdict, and write confidence + pressure summary to `report.md`.

### Step 5: Synthesis & Conclusion

1. **Intent Coverage Matrix**: verify every original intent item is `✅ Addressed`, `🔀 Transformed`, or `❌ Missed` (each ❌ requires an extra round or user-confirmed deferral).
2. **Write `outputs/findings.json`** (with `_meta: { kind: "findings", schema: "findings/1.0", role: "primary", alias: "current-analysis" }`, `outputs/risk-matrix.json` when scored): merge validated `technical_solutions[]` into prioritized recommendations, record Decision Trail, `architecture_template_evidence`, `scope_verdict`, and `recommendation`. Run interactive recommendation review (skipped in `-y`).
3. **Seal `session-priors`**: Runtime auto-snapshots `outputs/priors.json` from opened Wiki entries (`wiki_reference` / `wiki_context`, or CLI `knowledge-reads.json` Wiki reads at completion).
4. **Update `report.md`**: conclusion, recommendations, Decision Trail, Intent Coverage Matrix, session stats.

### Step 6: Decision Extraction (Always runs — main step in `-q`)

1. Identify 3-5 undecided domain gray areas (SEE / CALL / RUN / READ / ORGANIZE), skipping upstream locked items.
2. Let user select areas to discuss (`-y` skips interactive prompts and auto-resolves discussion rounds from code evidence; choosing "Skip" writes empty decision lists).
3. Discuss selected areas with Option A/B/C trade-offs (respect upstream milestone boundaries; new out-of-scope features go to `Deferred`).
4. Write `findings.json#decisions[]` as `{title, class: locked|free|deferred, context, options[], chosen, reason}` (attach `researchContext` hints to `free` items if present).
5. Record `deferred` decisions in `findings.json#decisions[]` and `report.md` (only invoke an external issue tracker with explicit user authorization).

### Wrap-up

Write `report.md` with frontmatter (`verdict: ready`, `summary`, `constraints`, `decisions`, `concerns`, `next: [{ command: ew-plan, reason: ..., needs: [current-analysis] }]`) and sections (`## Summary`, `## Conclusion/Verdict`, `## Discussion/Retrospective`, `## Artifacts`, `## Handoff/Next`). Use `{{aref:current-analysis#/...}}` instead of copying JSON values.
Seal via fenced `evolve run complete <run_id> --session <session> --actor <actor> --expected-orchestration-revision <rev> --expected-run-revision <rev> --gate exploration-done --gate discussion-round --gate scoring-complete --gate intent-covered --summary "<summary>" --verdict done|done_with_concerns` (for `-q` / `--gaps`, confirm `outputs/findings.json` and pass the exit gates with quick/gap mode evidence summary; recover blockers via `evolve run check` + `evolve run transition`). Hand off closeout candidate staging afterward to `ew-knowledge` (`evolve workflows show knowledge`).

---

## Recording Formats

**Decision Record**:
> **Decision**: [Description] | **Context**: [Trigger] | **Options**: [...] | **Chosen**: [Approach] (**Reason**: ...) | **Rejected**: [...] | **Evidence Source**: [subagent / `evolve delegate` / user / `file:line`] | **Impact**: [...]

**Technical Solution**:
> **Solution**: [Approach] | **Status**: [Proposed/Validated/Rejected] | **Problem**: [...] | **Rationale**: [...] | **Alternatives**: [...] | **Evidence**: [`file:line`] | **Next Action**: [...]

## Error Codes

| Code | Condition | Recovery |
|------|-----------|----------|
| `E001` | No relevant findings | Broaden search or ask user to clarify |
| `W001` | Exploration subagent failed | Retry once with narrowed scope; escalate or mark unverified dimensions explicitly |
| `W002` | `evolve delegate` timeout/error | Narrow prompt and retry, switch executor, or mark perspective unverified |
| `W003` | Max rounds reached (5) | Force synthesis and offer follow-up continuation |
