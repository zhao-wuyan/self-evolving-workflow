# Pre-flight: ew-grill

Confirm mode, depth, upstream seed, and read-only invariants before executing [workflow](workflow.md).

## Input & Mode

| Mode | Trigger | Behavior |
| --- | --- | --- |
| Resume | `-c` / `--continue` | Resume from prior Run's bound `grill-report.md` and unresolved branches |
| Auto | `-y` | Codebase evidence answers Socratic branches automatically (still walks all branches — never skips grilling) |
| Interactive | `<topic>` or `--from <alias>` | Full adversarial Socratic Q&A with structured user prompts (`ask_question` or host equivalent) |

- `--depth shallow|standard|deep`: sets branch count to `3`, `5` (default), or `8`.
- Missing topic and no `--from` / `-c` -> fail cleanly (`E001`).

## Knowledge & Context Pre-load

1. Complete the Run Knowledge Gate (`evolve skill workflows show session-run`, CLI `--task grill` when using `--reads`) for `arch`/`review` scope.
2. Run `evolve code search "<topic>"` only after the Knowledge Gate when mapping overlapping symbols.

## Boundaries & Invariants

- **Read-only on repository source**: write artifacts only under `{run_dir}/outputs/` and `{run_dir}/evidence/`.
- **Evidence-anchored challenges**: every questioned assumption must cite concrete `file:line` anchors or observed command output, never abstract opinion.
- **Immediate contradiction checks**: whenever an answer conflicts with codebase evidence or an earlier answer, challenge it on the spot before moving to the next branch.
- **Exit gate intent**: `terminology-aligned` (all candidate terms collision-checked in `outputs/terminology.md`) and `branches-walked` (full depth `3/5/8` walked from basic -> specific -> adversarial, producing `outputs/grill-report.md` and `outputs/context-package.json`).
