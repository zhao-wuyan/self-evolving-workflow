# Odyssey Shared Base

Shared by all seven Odyssey modes (`debug`, `improve`, `planex`, `review`, `security`, `defensive`, `ui`). Mode files own their front-half state machine, pattern source, category table, completion summary, and `W001-W007` warnings. Everything below is single-source; map host tools via [runtime adapters](runtime-adapters.md).

<execution_discipline>

1. **Workspace commits (mutable modes only)** — in mutable modes when code changes are made, commit workspace source changes per phase (`git commit -m "odyssey-{mode}({slug}): {phase} — {summary}"`). Never commit `{run_dir}/outputs/*` (`session.json`, `evidence.ndjson`, `understanding.md`) to git; register them atomically via `evolve run complete`. Read-only `security` and `defensive` modes never touch source files or commits.
2. **Confident edits vs decision gate** — implement confident fixes immediately; record ambiguous tradeoffs as `evidence.ndjson {"phase":"decision","status":"pending"}` without modifying code. Only these justify waiting on a decision: cross-module architecture tradeoffs | business-semantics ambiguity | new dependency or breaking API. ("Unsure how", "too big", "pre-existing" are NOT valid triggers.)
3. **Subagent & CLI assist** — parallelize independent scans/dimensions cleanly via host subagents (always joining/cancelling every spawned subagent — see [runtime adapters](runtime-adapters.md)) and run `evolve delegate "<prompt>" --to codex|agy|omp --mode analysis|write` for cross-angle checks. OMP native results auto-deliver without polling; strict analysis uses the separate CLI bridge. For independent second opinions explicitly select an authorized model; same-model children are not independent-model verification. Keep existing Codex defaults.
4. **No context-exhaustion aborts** — complete every campaign cleanly through `S_RECORD -> END`.
5. **Zero-residual** — every finding needs a concrete disposition (fix / issue / decision); "report only" and blanket "pre-existing" skips are forbidden.

</execution_discipline>

<shared_invariants>

Mode `prepare/odyssey-<mode>.md` files restate these as pre-flight guardrails; keep wording aligned:

- **Generalize is mandatory** unless `skip_generalize == true`; prior-phase convergence is NOT a valid skip reason.
- **Thoroughness floor** — all 3 generalization layers (syntax/semantic/structural) must be attempted and logged. A single-layer quick grep does NOT satisfy it.
- **Evidence append-only** — evidence.ndjson entries are immutable observations; modifying or deleting them is forbidden.
- **Per-item justification** — when `cross_phase_loops >= max_loops`, every unfixed finding needs its own reason. A blanket "pre-existing" is forbidden.

</shared_invariants>

<shared_schemas>

Artifact paths and `_meta` (`kind`, `schema`, `role`, `alias`) come from `references/prepare/odyssey-<mode>.md`. Attach `_meta` at top-level on JSON outputs (`session.json`, `explore.json`, `anchors.json`), on the first record of `evidence.ndjson`, and in YAML frontmatter of `understanding.md`. Set `current_state = "END"` before `evolve run complete`.

- **`session.json` core**: `{ current_state: "S_INTAKE", flags: { skip_fix: false, skip_generalize: false, auto_confirm: false }, phase_goals: [], phase_goals_all_done: false, self_iteration_log: [], cross_phase_loops: 0, max_loops: 5, created_at: "", updated_at: "" }` + mode fields.
- **`evidence.ndjson` line**: `{ ts, phase, type, source, content, note }` + phase fields.
- **`generalization_stats`**: `{ patterns_extracted, total_hits, cross_layer_confirmed, regression_risks, by_layer: { syntax, semantic, structural }, deepening_triggered }`.

</shared_schemas>

<anti_stall>

Track `progress_metrics: { phase_stats: {}, stale_count: 0, last_productive_phase: "", convergence_trend: "unknown" }` and `directions_tried: []` (`{ phase, round, strategy_type: "scope_widen|perspective_shift|tool_switch|structural_pivot", strategy_desc, result }`):
- After each analytical phase, count deduplicated `new_findings` vs `repeated`: `new == 0` -> `stale_count++`, `stalling`; `new > 0` -> reset `stale_count`, update `last_productive_phase`; 2 declining phases -> `diminishing`.
- New self-iteration strategies must differ from same-phase `directions_tried` (`stale_count`: 1 = shift perspective, 2 = structural pivot, 3 = structured user escalation or `-y` `INCONCLUSIVE`).
- Optional `--heartbeat`: update `session.json.updated_at` each phase (see [runtime adapters](runtime-adapters.md)).

</anti_stall>

<self_iteration>

Evaluate every analytical stage + `S_GENERALIZE` across three checks: **Coverage** (related files covered), **Depth** (`>=80%` with `file:line`), **Actionability** (concrete next step). If any fails and `stale_count < 3`, pick an untried strategy (`scope_widen` | `perspective_shift` | `tool_switch` | `structural_pivot`) and log to `evidence.ndjson {"phase":"self-iteration"}` + `session.json`. Exit when all suffice or `stale_count >= 3`.

</self_iteration>

## Shared Back-Half

`S_GENERALIZE -> S_DISCOVER -> S_RECORD -> END` runs cleanly at the end of every mode.

<shared_actions>

### A_GENERALIZE

1. **3-layer pattern extraction** from each mode's `## Generalize Source` into `session.json.patterns[]` (`[{ id, source, layer, signature, description, risk, fix_template, confidence }]`):
   - **Syntax**: regex/grep signature (`eval(`, missing `await`, etc.)
   - **Semantic**: anti-pattern reasoning across related modules
   - **Structural**: parallel file/import/override structures
2. **4-way parallel scan** (Syntax grep, Semantic scan, Structural match, Historical `git log -S`; join all workers before deduplicating) -> multi-layer boost / single-layer `needs_review` / prior-fix `regression_risk`; >=3 hits in one module triggers 1 targeted deep scan.
3. Log `session.json.generalization_stats` + `understanding.md` generalization section. Zero hits after attempting all 3 layers emits the mode's zero-hit warning, never blocks `S_RECORD`.

### A_DISCOVER

1. Triage every scan hit (`±10` lines context) as `bug` / `risk` / `safe`:
   - `bug` + `fix_template` -> fix & return to `S_FIX` (mutable modes)
   - `bug` needing decision / read-only mode -> record issue / decision
   - `risk` -> add guard if safe (mutable) or record issue/decision
   - `safe` -> skip
   *(Use structured prompt in Normal mode; follow mode's `-y` table when `-y`.)*
2. Increment `cross_phase_loops`; if `>= max_loops`, record per-item justification for every unfixed finding. Update `evidence.ndjson` + `understanding.md`.

### A_RECORD

1. Finalize `understanding.md` summary/learnings per the mode's `## Knowledge Persistence` table; resolve pending decisions and audit `phase_goals[]` (`pending -> done|skipped|failed`, `phase_goals_all_done = true` iff all confirmed).
2. Set `current_state = "END"` in `outputs/session.json`, emit the mode's Completion Summary, and seal atomically with fenced `evolve run complete` including verified reusable findings in `--summary`.
3. Follow `evolve workflows show knowledge` (repo: `skills/ew-knowledge/SKILL.md`) — stage candidates post-seal via `evolve closeout session <session-id>` and `evolve wiki propose` / `apply` (never direct corpus writes).

</shared_actions>

<shared_appendix>

### Phase Initialization & Pre-load

Initialize `phase_goals[]` in `session.json` after INTAKE and mirror cleanly via [runtime adapters](runtime-adapters.md). Under `-y`: pending decisions -> default + `deferred`; 3-strike -> `INCONCLUSIVE`; goal audit -> auto-accept.

Before discovery or code search, satisfy the **Knowledge Gate** (`AGENTS.md`):
1. Call Run MCP `wiki_context` + `wiki_reference` / `memory_search` + `memory_get` (or CLI fallback `evolve context "<keywords>" --session <id> --include-memory --reads "<run_dir>/knowledge-reads.json"` + `evolve wiki get <id> --resolved --reads ... --from-search ...`).
2. After the Knowledge Gate, inspect the codebase with `evolve code search "<keywords>"` and check `evolve session list` when `-c` or prior scope overlap may exist.

### Error Codes & Shared Next-Step Routing

`E000-E004` and `W008` are unified in [SKILL.md](../SKILL.md). `W001-W007` are owned per mode (the same warning code has mode-specific meaning; never assume cross-mode equivalence).

| Outcome | Recommended follow-up |
|---|---|
| Reusable patterns/rules ready to publish | Follow `evolve workflows show knowledge` (`evolve closeout session` -> `evolve wiki propose`) |
| Independent second opinion needed | `evolve delegate "<review prompt>" --to codex\|agy\|omp --mode analysis`; explicitly select an authorized different model for cross-model verification (OMP `--model <selector>`), with binding rules in [runtime adapters](runtime-adapters.md) |
| Pending `phase=decision` items remain | Filter `evidence.ndjson` (`phase == "decision" && status == "pending"`) |

</shared_appendix>
