# Pre-flight: ew-debug

Confirm entry mode, Knowledge Gate context, and strict read-only diagnosis invariants before running [workflow](workflow.md).

## Entry Modes

| Mode | Trigger | Symptom Source |
| --- | --- | --- |
| Standalone | `<issue>` description | Interactive collection (expected, actual, error, regression window, repro steps) + recent `git log`/`diff` |
| From test / review | `--from-test` or bound `latest-test` / `latest-auto-test` / `latest-review` | Failed scenarios, `app_defects[]`, or findings clustered by affected module or flow |
| Parallel | `--parallel` | One isolated debug subagent per non-overlapping failure cluster (all joined before synthesis) |
| Continuation | `-c` | Resume from prior failed Run's `evidence` / `understanding` via `run get` |

Missing issue and no bound failure artifact -> error `E001`.

## Knowledge & Codebase Pre-load

1. Follow the Run Knowledge Gate (`evolve skill workflows show session-run`): reuse bound `session-priors` (`debug`/`coding`); otherwise query `evolve search "<query>" --mode context` + `evolve kb get <id>` (with CLI `--reads` with `--task debug`) to check known pitfalls and prior fixes.
2. Run `evolve code search` / `evolve code callers` / `evolve code trace` after the Knowledge Gate to trace propagation paths.

## Scientific Boundaries (Iron Law)

- **Read-only on repository source**: never apply speculative quick fixes or edit production source files during diagnosis; temporary reproduction probes must be reverted or isolated to `{run_dir}/evidence/`. Fixing belongs to `ew-plan --gaps` -> `ew-execute`.
- **Evidence before confirmation**: a hypothesis stays `"suspected"` until backed by a live reproduction or concrete `file:line`/log evidence.
- **Single-variable testing & 3-strike escalation**: test one hypothesis at a time and record append-only observations in `{run_dir}/evidence/evidence.ndjson`. If 3 hypotheses fail, STOP proposing ad-hoc theories (`INVESTIGATION INCONCLUSIVE`), record all falsified hypotheses + architectural contradiction anchors, and escalate to architectural analysis (`ew-analyze` inside the Session, or standalone `ew-odyssey-debug`).
- **Backward tracing**: trace from symptom origin back to where valid data first turned invalid — fix root cause, never surface symptoms.
- **Exit gates**: `hypothesis-tested` (repro + isolated hypotheses logged) and `evidence-grounded`:
  - For `confirmed` / `partial`: pressure pass done, multi-factor confidence recorded (`>= 40%`), zero unaddressed contradicting evidence, and concrete `affected_files[]` + `fix_direction`.
  - For `inconclusive` (3-strike architectural contradiction): complete 3-strike refutation dossier logged across `outputs/reproduction.json` + `outputs/hypotheses.json` (`>= 3` falsified hypotheses with `file:line` refutation anchors) + `outputs/diagnosis.json` (`status: "inconclusive"`, `fix_direction: null`, explicit `escalation_target`), without fabricating `affected_files[]` or `fix_direction`.
