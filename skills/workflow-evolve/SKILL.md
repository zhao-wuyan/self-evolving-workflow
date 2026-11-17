---
name: workflow-evolve
description: Analyze a Skill execution history, run a real Codex plus Agent Memory regression, and iteratively improve the Skill through an Agy-confirmed replay loop.
argument-hint: <skill-entry> --iterations <n> --scenarios <file> [--session <id>|--execution <id>] [--auto]
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
version: 0.3.0
---

# Workflow Evolution

Use this Skill for single-evidence behavioral fixes grounded in a completed Session/Run or standalone execution (new Skills or contract/multi-file restructuring route to `ew-skill-design` instead). `--iterations <n>` is required; `--auto` enables unattended `apply` and rollback after the Agy confirmation gate.

- Read [the automatic loop](references/auto-loop.md) for argument parsing, state, retries, and stop conditions.
- Read [history review](references/history-review.md) when reconstructing execution evidence or building a transcript fixture.
- Read [the Agy gate](references/agy-gate.md) when preparing or validating Agy discussion and confirmation payloads.

## Entry Contract

```text
workflow-evolve <skill-entry>
  --iterations <positive integer>
  --scenarios <JSON file with >=1 baseline failure and >=1 baseline pass>
  [--runner <replay runner>]
  --session <Session ID> | --execution <Skill execution ID> | --history <JSON transcript> | --review <serialized Session review>
  [--project <project ID>] [--max-retries <n>] [--auto]
```

- **Default runner**: `scripts/codex-memory-replay.mjs` (runs `codex exec` read-only against the target Git commit and returns loaded document hashes + `knowledge-reads/1.0`). Set `AGENT_MEMORY_DB` to an absolute path when replay should query existing memories.
- **Clean commit required**: Commit target Skill changes before replay (`evolve skills replay` creates isolated worktrees under `<git-dir>/evolve-replay/`).
- **Agy receipts**: Preserve both discussion and confirmation JSON per round; apply only when `approved: true`.
- **Automatic project review**: OpenViking lifecycle supplies one fixed `--review` with real Run sources, a project business runner, and `EVOLVE_KNOWLEDGE_SNAPSHOT`. Zero attributable signals exit without a candidate; discussion evidence must be a subset of the review sources.
- **Installed CLI**: Set `AGENT_MEMORY_CLI` and `EVOLVE_CLI` to the matching installed package. Nested `skills/**/SKILL.md` entries are inspected at the requested Git commit; project `node_modules` is not required.

## Automatic Invocation

```powershell
# PowerShell (use `\` line continuation on POSIX shells)
node skills/workflow-evolve/scripts/evolve-loop.mjs `
  --skill skills/workflow-evolve/SKILL.md `
  --iterations 3 `
  --scenarios .agent-memory/evolution/scenarios.json `
  --session <session-id> `
  --auto
```

Writes round state under `.agent-memory/evolution/<timestamp>/` (and `outputs/evolution-report.json` when `--run-dir <run_dir>` is passed).
