# Workflow: ew-retrospective

Four-lens retrospective: `Load Evidence -> Parallel Lens Analysis -> Synthesize & Compare -> Route Insights -> Seal`.

## Step 1: Load Read-Only Evidence

1. Complete the Run Knowledge Gate (`evolve skill workflows show session-run`) and load bound artifacts (`current-execution`, `latest-verification`, `latest-review`) plus `evolve session get` (or `evolve run get` for a specified `<session|run>`) and any `--compare` prior retrospective.
2. Verify source artifacts remain untouched throughout analysis.

## Step 2: Independent Four-Lens Analysis (`lenses-complete` gate)

Run one read-only subagent per selected lens in parallel (`workflow-analyzer` / `workflow_analyzer` via `invoke_subagent` or host equivalent; fall back to inline role instructions when absent; **join or cancel all spawned subagents cleanly before synthesis**):
1. **`technical`**: architectural trade-offs, coupling surprises, brittle APIs, code patterns worth reusing or avoiding.
2. **`process`**: estimation drift, blocked gates, unclear plan boundaries, wasted retries or missing pre-flight context.
3. **`quality`**: missed edge cases, test gaps, late regressions caught in review/verify vs earlier steps.
4. **`decision`**: assumptions that held vs broke, reversible vs irreversible choices, scope changes.

Each lens reports findings independently with exact evidence anchors (`run_id`, `file:line`, exit code); missing a requested lens flags `[LOW CONFIDENCE]`.

## Step 3: Synthesis, Stability & Routing (`insights-routed` gate)

1. Deduplicate cross-lens findings and compute a deterministic `INS-{8hex}` ID per insight (`sha256(scope + normalized_title).slice(0, 8)`) so re-runs do not spawn duplicates.
2. Classify each insight's route (if `--no-route` is set, assign `route: "skipped"` to every insight and set `routing_skipped: true` in `outputs/retrospective.json` without triggering downstream routing or memory staging; otherwise classify):
   - `wiki-candidate` -> prepare candidate summary for `ew-knowledge` closeout review (never direct file write).
   - `skill-evolve` -> attribute exact Skill/step + Run receipt for `workflow-evolve` (`evolve session review` / `evolve skill draft`).
   - `issue` -> surface actionable backlog item for user-authorized issue tracking.
   - `none` -> project-specific observation recorded in `retrospective.md` only.
3. Unless `--no-route`, collect user confirmation via structured prompt (`ask_question` or host equivalent) before invoking optional external routes (`kb add --kind episodic` / issue tracking); keep Wiki publication explicitly under `ew-knowledge`.

## Step 4: Write Outputs & Seal

1. Write `{run_dir}/outputs/retrospective.json` (`_meta: { kind: "retrospective", schema: "retrospective/1.0", role: "primary", alias: "latest-retrospective" }`, `lenses_run[]`, `routing_skipped`, `delta` if `--compare`, `insights[]` with `id`, `lens`, `summary`, `evidence[]`, `route`, `status`) and `{run_dir}/outputs/retrospective.md`.
2. Write `{run_dir}/report.md` (`verdict: ready|ready_with_concerns|blocked|failed`) and seal or transition the Run per `evolve skill workflows show session-run` (`--gate lenses-complete --gate insights-routed`).
3. Unless `--no-route`, at Session completion hand candidate staging/review cleanly to `ew-knowledge` (`evolve skill workflows show ew-knowledge`).
