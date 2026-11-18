# Workflow: ew-verify

Independent goal-backward verification: `Constraint Pre-check -> Must-Haves Breakdown (Truths / Artifacts / Key Links) -> Anti-Pattern & Regression Coverage -> Seal`.

## Step 1: Load Artifacts & Constraint Pre-check

1. Read bound `current-plan` and `current-execution` (`read_artifact` / `evolve run artifact-read`). Complete the Knowledge Gate for applicable coding/review constraints.
2. Check changed files against any active Wiki tech-stack constraints (`allowed_libs`, `disallowed_imports`, `required_patterns`). Record violations as `CV-N` (`disallowed_import`, `unlisted_dependency`, `missing_required_pattern`).

## Step 2: Goal-Backward Structural Verification (`goal-backward-verified` gate)

Normalize every criterion from `current-plan` (plus any UAT human gaps) into three verification layers:
1. **Truths** (observable behaviors): locate implementation + wiring, mark `VERIFIED`, `FAILED`, or `UNCERTAIN` (`--strict` rejects `UNCERTAIN`).
2. **Artifacts** (on-disk modules & deliverables): inspect across 3 levels:
   - `L1 Existence`: file exists (`MISSING` on fail)
   - `L2 Substance`: real implementation rather than stub/placeholder/`TODO: implement` (`STUB` on fail)
   - `L3 Wiring`: imported and invoked by callers via `evolve code callers` / ripgrep (`ORPHANED` on fail)
3. **Key Links**: verify live wiring for critical boundaries (`Component -> API`, `API -> DB`, `Form -> Handler`, `State -> Render`, `Event -> Handler`) with `file:line` proof (`WIRED` / `PARTIAL` / `NOT_WIRED`).

## Step 3: Anti-Pattern & Test Coverage (`nyquist-covered` gate)

1. **Anti-pattern scan** (unless `--skip-antipattern`): scan changed files for `TODO`/`FIXME`/`HACK`, stub returns, skipped/disabled tests (`skip`/`@ts-ignore`/`as any`), and dead imports -> write `outputs/antipattern-report.json`.
2. **Narrowest live verification** (unless `--skip-tests`): execute the targeted test/typecheck/build commands covering modified modules and their direct importers, recording exact commands, exit codes, and pass/fail counts -> write `outputs/requirement-coverage.json`.

## Step 4: Write `outputs/verification.json` & Seal

1. Write `{run_dir}/outputs/verification.json` (`verification/1.0`: `status: passed|gaps_found|blocked`, `truths[]`, `artifacts[]`, `key_links[]`, `constraint_violations[]`, `gaps[]` (`GAP-N` with `severity` and `fix_direction`), `commands_run[]`).
   - If `evolve experience status` reports `collecting: true`, the verifying AI may include `experiences[]` in `verification.json` only for an independently verified, reusable lesson. Use a passed result and a unique `truths[].id` with `status: VERIFIED`. Each draft has `domain`, a versioned `stack` (e.g. `python@3.12`), `title`, `applicability`, `lesson`, `verification` (sanitized reproduction or before/after observation), and `evidence` (that truth ID). Use single-line fields; omit project names, paths, code, raw logs, secrets, and guesses. If nothing qualifies, omit the field. Session completion stages the sealed evidence locally; it does not publish.
2. Write `{run_dir}/report.md` (`next` routing to `ew-test` when passed, or `ew-plan --gaps` / `ew-debug` when gaps remain).
3. Seal via fenced `evolve run complete <run_id> --session <session> --actor <actor> --expected-orchestration-revision <rev> --expected-run-revision <rev> --gate goal-backward-verified --gate nyquist-covered --summary "<summary>" --verdict done|done_with_concerns`. Stage reusable verification lessons afterward through `ew-knowledge`.
