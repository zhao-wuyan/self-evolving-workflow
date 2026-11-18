---
name: workflow-evolve
disable-model-invocation: true
description: Meta-workflow for modifying Skill packages (`skills/<id>/SKILL.md`) via execution history analysis, Codex + Agent Memory replay, and Agy confirmation. Explicit user `/workflow-evolve` invocation only (`disable-model-invocation: true`); never auto-invoke during normal project tasks.
argument-hint: "--skill <skills/<id>/SKILL.md> --iterations <n> --scenarios <file> (--session <id> | --execution <id> --project <id> | --history <file> | --review <file>) [--run-dir <dir>] [--bank <file>] [--auto]"
session-mode: run
required_links:
  - references/auto-loop.md
contract:
  contract_version: 2.1
  consumes: []
  produces:
    - path: outputs/evolution-report.json
      kind: workflow-evolution-report
      schema: workflow-evolution/1.0
      role: primary
      alias: latest-workflow-evolution
      required: true
  gates:
    entry:
      - explicit iteration count is a positive integer
      - target Skill package is committed and replayable
    exit:
      - every applied round has an Agy confirmation receipt
      - baseline and candidate scenarios pass
      - failed applications are rolled back
version: 0.4.0
---

# Workflow Evolution

Use this Skill **only** when explicitly invoked (`/workflow-evolve`) to modify Skill/Harness behavior (`skills/<id>/SKILL.md`) based on completed Session/Run or execution evidence. Never auto-invoke this Skill during ordinary project coding or task execution, and do not treat routine business-code bugs, failing project tests, or single user clarifications as Skill defects. Routing to `ew-skill-design` follows `ew-knowledge` `references/knowledge-route.md` rule 8 (`evolve skill workflows show ew-knowledge`): candidates needing a new Skill contract/lifecycle gate, new artifacts/outputs, cross-Skill routing/multi-stage branching, at least 3 stable steps, or an explicit new/migrated Skill route to `ew-skill-design` (auto-routable or directly invocable). `--iterations <n>` is required; `--auto` enables unattended `apply` and rollback after the Agy confirmation gate.

- Read [the automatic loop](references/auto-loop.md) for argument parsing, state, retries, and stop conditions.
- Read [history review](references/history-review.md) when reconstructing execution evidence or building a transcript fixture.
- Read [the Agy gate](references/agy-gate.md) when preparing or validating Agy discussion and confirmation payloads and `priority` placement rules.

## Entry Contract

```text
evolve-loop.mjs
  --skill <skills/<id>/SKILL.md>
  --iterations <positive integer>
  --scenarios <JSON file with >=1 baseline failure and >=1 baseline pass>
  [--runner <replay runner>]
  (--session <Session ID> | --execution <Skill execution ID> --project <source project ID> | --history <transcript-evidence/1.0 JSON> | --review <serialized Session review> | --allow-empty-history)
  [--run-dir <dir>] [--output-dir <dir>] [--max-retries <n>] [--agy <executable>] [--bank <file>] [--auto]
```

- **Run output requirement**: Inside an Evolve Run (`session-mode: run`), you MUST pass `--run-dir <run_dir>` (or set `RUN_DIR`) so `evolve-loop.mjs` emits `outputs/evolution-report.json` with `_meta`; omit `--run-dir` only for standalone invocations outside a Run.
- **`--execution` requires `--project`**: Passing `--execution <id>` without `--project <source-project-id>` fails immediately with an error.
- **Default runner**: `scripts/codex-memory-replay.mjs` (runs `codex exec` in an isolated scratch workspace using the replay CLI against the target Git commit and returns loaded document hashes + `knowledge-reads/1.0`). Scenario `input` needs `task` plus `expected` (exact text) and/or `rubric` (string or list judged by a separate read-only `codex exec`); failures return `feedback`. Set `AGENT_MEMORY_DB` to an absolute path when replay should query existing memories; raise `CODEX_REPLAY_TIMEOUT_MS` / `EVOLVE_REPLAY_TIMEOUT_MS` for rubric judging.
- **pass^k**: A scenario may set `"samples": <1-10>`; it passes only when every sample passes (baseline and candidate alike).
- **Scenario bank**: `--bank <file>` (default `.evolve/evolution/bank/<skill-id>.json`) keeps verified scenarios as baseline passes and records addressed signal IDs; later runs replay the bank and skip addressed signals. Point `--bank` at a tracked file to share it.
- **Clean commit required**: Commit target Skill package changes before running (`evolve-loop.mjs` verifies the target package directory is clean before each round, and `evolve skill replay` creates isolated worktrees under `<git-dir>/evolve-replay/`).
- **Agy receipts**: Preserve both discussion and confirmation JSON per round; apply only when `approved: true`.
- **Automatic project review**: OpenViking lifecycle supplies one fixed `--review` with real Run sources, a project business runner, and `EVOLVE_KNOWLEDGE_SNAPSHOT`. Zero attributable signals exit without a candidate (`no_signals`); discussion evidence must be a subset of the review sources. This path is independent of `--session`/`--execution`/`--history`, which use the scenario bank's addressed-signal filtering.
- **Installed CLI**: Set `EVOLVE_CLI` to the installed `workflow-cli.js`; `AGENT_MEMORY_CLI` remains accepted for compatibility with the OpenViking lifecycle and is used as a fallback when `EVOLVE_CLI` is absent. The replay runner resolves `required_links` from the requested Git commit; project `node_modules` is not required.

## Operations and Versions

| Operation | When | Command |
| --- | --- | --- |
| `add` | New attributable defect with no learning covering it | `evolve skill draft <entry> <instruction> --priority <p> --evidence <ref>` |
| `supersede` | A Run read an existing learning and still failed, or the learning is wrong | `evolve skill draft ... --supersedes <learning-id>` |
| `retire` | `evolve skill learnings <entry>` marks `retire_candidate` / `unused`, or the body absorbed the learning | `evolve skill retire <entry> <learning-id>... --evidence <ref> [--reason <text>]` |
| consolidate | `skill learnings` reports `consolidate_recommended` (inline > 3 or total > 8) | Route to `ew-skill-design` package mode; `add` is blocked in the loop |

Each candidate commit carries `Evolve-Draft`, `Evolve-Operation` and `Evolve-Evidence` trailers and bumps the frontmatter `version` (patch for learnings, minor for package redesigns when the designer left it unchanged). Receipts live in `<git-dir>/evolve-replay/` with refs `refs/evolve/replays/<id>`. `evolve skill rollback <receipt>` reverts the candidate even after later unrelated commits, as long as the candidate files were not changed again.

### Handoff from `ew-knowledge` (`kb candidates route`)

When `evolve kb candidates route <closeout-id> <candidate-id> --skill <skill-id>` returns `route: "skill-addition"`, inspect the closeout record with `evolve kb candidates show <receipt-id> --project <source-project-id>` and map inputs as follows:

1. **Target & history flag**:
   - `--skill skills/<skill-id>/SKILL.md`
   - Session receipt (`kb harvest session`): pass `--session <session_id>`.
   - Standalone Skill receipt (`kb harvest skill`): pass `--execution <execution_id> --project <source-project-id>` (`<execution_id>` from `kb candidates show`'s `session_id` / execution ID).
   - Direct transcript fixture: pass `--history <transcript-evidence/1.0 JSON>`.
2. **`--scenarios` construction**: Author a JSON array of `>= 2` items (`{ id, input: { task, expected }, baseline: boolean, knowledge_reads? }`):
   - At least one failing baseline scenario (`"baseline": false`) reproducing the defect in `candidate.content` and `candidate.sources` with the expected fixed output.
   - At least one passing baseline scenario (`"baseline": true`) ensuring unaffected behavior stays green.

## Automatic Invocation

```powershell
# PowerShell (use `\` line continuation on POSIX shells)
node skills/workflow-evolve/scripts/evolve-loop.mjs `
  --skill skills/<id>/SKILL.md `
  --iterations 3 `
  --scenarios .evolve/evolution/scenarios.json `
  --session <session-id> `
  --run-dir <run_dir> `
  --auto
```

Writes round state under `.evolve/evolution/<timestamp>/` (and `outputs/evolution-report.json` when `--run-dir <run_dir>` is passed). Seal the Run with `evolve run complete` only when `state.status` is `completed` (or `done_with_concerns` if `confirmed_pending_apply` awaiting manual `apply`); on `regression_detected`, `agy_rejected`, `replay_failed`, `consolidation_required`, `confirmation_rejected`, `rolled_back`, or `failed`, transition the Run with `evolve run transition ... failed|blocked` (`no_attributable_signals` exits with zero Skill changes; `consolidation_required` hands off to `ew-skill-design`).
