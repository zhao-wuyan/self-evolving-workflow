# Pre-flight: ew-retrospective

Confirm target Runs, active lenses, read-only source-artifact boundaries, and routing governance before executing [workflow](workflow.md).

## Modes & Flags

- **Default / `<session|run>`**: analyze the bound Session (`evolve session get`) or target Run ID (`evolve run get`) execution/verification/review artifacts.
- **`--lens <technical|process|quality|decision>`**: restrict to selected lens(es); default runs all four in parallel.
- **`--compare <prior-run>`**: load a prior `retrospective.json` artifact via `evolve run read artifact` and emit a trend delta section.
- **`--no-route`**: synthesize `outputs/retrospective.json` and `outputs/retrospective.md` without initiating downstream routing (`ew-knowledge`, `workflow-evolve`, `kb add --kind episodic`, or external issue tracking); classify every insight with `route: "skipped"` and record `routing_skipped: true` summary metadata so `insights-routed` still holds honestly.
- **`-y`**: skip optional interactive confirmation for non-Wiki steps (`kb add --kind episodic`, report formatting); **never** treats `-y` as Wiki publication approval (`ew-knowledge` owns human authorization for `kb propose` / `apply`).

## Knowledge Gate & Boundaries

- Complete the Run Knowledge Gate (`evolve skill workflows show session-run`) to avoid re-proposing insights already documented in active Wiki entries.
- **Source artifacts are read-only**: never modify code, `verification.json`, `review.json`, `plan.json`, or completed retrospective artifacts; write only to `{run_dir}/outputs/`.
- **Never write `wiki/entries/` or `.workflow/specs/` directly**: route project knowledge through `ew-knowledge` (`closeout` / `kb propose`), and Skill/workflow defects through `workflow-evolve` (`evolve session review` / `evolve skill draft`).
- **Exit gates**: `lenses-complete` (every requested lens ran independently without cross-suppression) and `insights-routed` (deterministic `INS-{8hex}` IDs + explicit route classification per insight, or explicit `route: "skipped"` + `routing_skipped: true` under `--no-route`).
