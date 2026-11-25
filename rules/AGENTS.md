# Self-Evolving Workflow

Use the relevant package in `skills/` for project orchestration; commit project-scoped Skill packages so Runs can bind a Git revision. Check the CLI with `evolve --version`; install or upgrade deliberately if unavailable. Use `evolve skill workflows show session-run` for Run control and `evolve skill workflows show agent-usage` for delegation.

## Knowledge Gate

- Before project exploration (including `git`, file reads, release, or maintenance actions) and whenever the task scope changes mid-conversation, run `evolve search "<1–3 task keywords>" --mode context` and open governing or truncated hits with `evolve kb get <id|q-N:idx>... --resolved`. Reuse valid bound priors when available; use one Run receipt (`--reads "<run-dir>/knowledge-reads.json"`) and `--session <session-id>` for CLI lookups. Refine irrelevant queries and re-query after repeated failed fixes. Follow project scope; read local + global, write project by default.

## Memory Recording

- Record the first confirmed correction, durable decisions, informative failures and non-obvious verified methods immediately. Search for existing records; use `evolve kb add "<lesson>" --kind episodic --type <type> --scene <step> --session <session-id> --evidence <source-ref>` or update the existing record. Bind real evidence and distinguish verified facts from hypotheses; omit routine requests/progress. Before handoff or compaction confirm important records by `kb get`. See `evolve skill workflows show ew-knowledge` for provenance and standalone tasks.

## Closeout & Self-Evolution

- Before `run complete`, record material knowledge adoption or measured outcomes on the existing Run receipt with `evolve kb feedback` (see session-run). If no knowledge was used, do not fabricate feedback.
- `evolve session complete` freezes evidence and queues candidate extraction; inspect `evolve kb closeouts <session-id>`. Do not repeat harvest while running or between Run steps. Standalone tasks harvest only at explicit or confirmed final wrap-up. See `evolve skill workflows show ew-knowledge` for state-specific recovery.
- New or changed Wiki content and Skill modifications require explicit approval of the target and action. Use governed `kb propose` / `kb apply`, never write `wiki/entries/` or legacy `.workflow/specs/` / `.workflow/knowhow/` directly. Keep candidates pending if approval is absent. `workflow-evolve` is explicit `/workflow-evolve` only, for confirmed Skill/process defects, not ordinary code/test failures.
- For missing memories, CLI/Hook failures, or maintenance, use `evolve kb doctor` and the `ew-knowledge` maintenance route. Do not migrate, bulk-retry, install Hooks or change user-wide settings without authorization.