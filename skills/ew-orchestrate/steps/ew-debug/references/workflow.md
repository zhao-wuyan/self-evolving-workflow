# Workflow: ew-debug

Scientific root-cause pipeline: `Symptom Baseline -> Cluster -> Isolated Hypothesis Investigation -> Confidence & Pressure Pass -> Synthesis & Seal`.

## Step 1: Collect Symptoms & Baseline

1. Complete the Run Knowledge Gate (`evolve skill workflows show session-run`) and check bound inputs (`latest-test`, `latest-auto-test`, `latest-review`, `current-execution`).
2. Extract reproduction baseline: expected vs actual behavior, exact error output, `git log --oneline -10`, and minimal reproduction command (run and record exact exit code/output into `outputs/reproduction.json`).
3. Under `--from-test`, group failures (from `latest-test` `gaps[]`, `latest-auto-test` `app_defects[]`, or `latest-review` `findings[]`) into independent component/flow clusters.

## Step 2: Isolated Hypothesis Investigation (`hypothesis-tested` gate)

Dispatch an isolated read-only investigation subagent (`workflow-debugger` / `workflow_debugger` via `invoke_subagent` or host equivalent; fall back to inline role instructions when absent; in `--parallel` mode, one subagent per non-overlapping cluster; **join or cancel all spawned subagents cleanly before Step 3**).

Each investigator follows strict discipline:
1. Form 2–3 ranked hypotheses and test ONE variable at a time via backward tracing (`evolve code trace` + reproduction logs).
2. Append every test step, observed result, and `file:line` anchor to `{run_dir}/evidence/evidence[-<cluster>].ndjson` and summarize active state in `{run_dir}/evidence/understanding[-<cluster>].md`.
3. Enforce **3-strike stop**: after 3 falsified hypotheses without confirmation, stop guessing, record `INVESTIGATION INCONCLUSIVE` with the architectural contradiction anchors, and advance to the `inconclusive` exit path in Step 3/4 (do not fabricate a root cause).

## Step 3: Confidence Scoring & Pressure Pass (`evidence-grounded` gate)

Compute multi-factor confidence (`evidence_depth * 0.30 + evidence_strength * 0.25 + coverage_breadth * 0.20 + reproduction * 0.15 + consistency * 0.10`; `< 40%` low, `40–70%` medium, `> 70%` high) and run two mandatory checks before writing outputs:
- **Pressure Pass**: cross-check confirmed causes (or 3-strike refutations) against every refuted hypothesis and contradicting observation.
- **Devil's Advocate** (when isolation `> 0.7`): verify whether the apparent cause hides a deeper upstream invariant violation.
- **Readiness check**:
  - **`confirmed` / `partial`**: confirm evidence completeness `>= 40%`, pressure pass complete, zero unresolved contradicting evidence, and concrete `affected_files[]` + `fix_direction`.
  - **`inconclusive` (3-strike stop)**: confirm `>= 3` falsified hypotheses logged with `file:line` refutation anchors and architectural contradiction summary; do NOT fabricate `affected_files[]` or `fix_direction`.

## Step 4: Write Outputs & Seal

1. Write `{run_dir}/outputs/diagnosis.json` (`_meta: { kind: "diagnosis", schema: "diagnosis/1.0", role: "primary", alias: "latest-debug" }`, `status: confirmed|partial|inconclusive`, `clusters[]`, `confidence`, `pressure_pass`, `escalation_target?`), `{run_dir}/outputs/hypotheses.json`, and `{run_dir}/outputs/reproduction.json`. Write `{run_dir}/outputs/fix-directions.json` (`_meta: { kind: "fix-directions", schema: "fix-directions/1.0", role: "attachment", alias: "latest-fix-directions" }`, actionable root cause + target `file:line` + verification criteria) only for `confirmed`/`partial` diagnoses.
2. Write `{run_dir}/report.md` and seal/transition per `evolve skill workflows show session-run` (`--gate hypothesis-tested --gate evidence-grounded`):
   - `confirmed`: `verdict: ready`, `next: [{ command: ew-plan, args: ["--gaps"], reason: "...", needs: [latest-debug] }]` -> `evolve run complete ... --verdict done`.
   - `partial`: `verdict: ready_with_concerns`, `next` -> `ew-plan --gaps` -> `evolve run complete ... --verdict done_with_concerns`.
   - `inconclusive` (complete 3-strike refutation dossier ready for architectural re-analysis): `verdict: ready_with_concerns`, `next: [{ command: ew-analyze, reason: "3-strike inconclusive diagnosis; architectural analysis required", needs: [latest-debug] }]` (note `ew-odyssey-debug` for standalone multi-iteration campaigns) -> `evolve run complete ... --verdict done_with_concerns`.
   - Hard blocker (insufficient reproduction/evidence or unable to safely continue without human intervention): `verdict: blocked`, `next` -> `ew-analyze` / human intervention -> do **not** call `run complete`; transition via `evolve run transition <run_id> blocked ... --reason "INVESTIGATION INCONCLUSIVE: ..."` (see `evolve skill workflows show session-run`).
3. When `diagnosis.status` is `confirmed` or `partial`, record verified non-obvious root causes and workarounds in working memory via `evolve kb add --kind episodic "<root cause and workaround>" --type verified_fix --scene debug --session <session_id>`, and after sealing stage reusable pitfall/root-cause patterns through `ew-knowledge` (`evolve skill workflows show ew-knowledge`).
