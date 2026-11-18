# Pre-flight: ew-review

Confirm audit target, bound context, and read-only invariants before running [workflow](workflow.md).

## Input & Mode

- **Default (`current-execution`)**: read bound `current-execution` (`read_artifact` / `evolve run read artifact`) and audit its changed files and git diff.
- **Explicit `<target>`**: file/directory path, `HEAD` / `staged` (`git diff`), or commit/PR range.
- **`--tier quick`**: focused pass on changed hunks (`correctness` + `security` + regressions).
- **`-y`**: skip optional confirmation prompts; never suppress findings, missing evidence, or gate checks.

## Boundaries & Invariants

- **Read-only audit**: never edit repository source files; write Run outputs only under `{run_dir}/outputs/` and `{run_dir}/report.md`.
- **Knowledge reuse**: follow the Run Knowledge Gate (`evolve skill workflows show session-run`): consume `session-priors` for covered `review`/`coding` scope; query `evolve search "<query>" --mode context` + `evolve kb get <id>` (with CLI `--reads` / `--from-search`) whenever the target introduces new paths or categories.
- **Evidence-first**: audit all 4 dimensions (`correctness`, `security`, `performance`, `architecture`, or `correctness`+`security` in quick tier); every finding requires verified `file:line`, observed evidence, accurate severity (`critical|high|medium|low`), and concrete remediation.
- **Zero-residual check & routing**: verify claimed fixes and test results against disk state without collapsing distinct root causes. Route actionable fixes via `outputs/review.json` + `next` to `ew-plan --gaps` (multi-file/multi-step), `ew-companion` (`<= 3` findings, each `<= 2` files, single concern), or `ew-odyssey-review` (iterative standalone repair campaign) — **never** route `ew-review` `next` directly to `ew-execute`.
