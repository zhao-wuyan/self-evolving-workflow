---
name: ew-brainstorm
description: Explore a problem space and produce bounded options for the Evolve chain
argument-hint: '<intent> [--from <artifact-alias>] [-y]'
wiki_categories: [arch, learning]
search_profile:
  wiki: references
  memory: optional
session-mode: run
contract:
  consumes:
  - kind: context-package
    alias: upstream-context
    required: false
    schema: context-package/1.0
    role: attachment
    accepts_negative_evidence: true
  - kind: priors
    alias: session-priors
    required: false
    schema: priors/1.0
    role: evidence
  produces:
  - path: outputs/brainstorm.json
    kind: brainstorm
    alias: current-brainstorm
    role: primary
    required: true
    schema: brainstorm/1.0
  - path: outputs/context-package.json
    kind: context-package
    alias: upstream-context
    role: attachment
    required: false
    schema: context-package/1.0
  contract_version: 2.1
---

# Brainstorm

Brainstorm is a planning step inside the Evolve Skill. Explore the problem space, record assumptions and alternatives, and leave a bounded option set for the next chain step.

1. Read the current Session objective, `boundary_contract`, optional `upstream-context`, and available Wiki evidence. Complete the Run Knowledge Gate (`evolve skill workflows show session-run`, reusing `session-priors` or searching `arch` scope with `--category arch` when using CLI `--reads`).
2. Separate observed facts, user constraints, open questions, and proposed options (`-y` skips interactive prompts and resolves defaults from codebase/Wiki evidence). When deeper codebase grounding or parallel option evaluation is needed, dispatch `cli-explore-agent` / `workflow-analyzer` (`cli_explore_agent` / `workflow_analyzer` in Codex, or inline role instructions when absent; always join/cancel before Step 4).
3. Compare options against scope, risk, reversibility, and verification cost.
4. Write `{run_dir}/outputs/brainstorm.json` (with `_meta: { kind: "brainstorm", schema: "brainstorm/1.0", role: "primary", alias: "current-brainstorm" }`) and optional `outputs/context-package.json` (`_meta` matching `context-package/1.0`), citing source evidence for every material conclusion.
5. Write `{run_dir}/report.md` (`verdict: ready|ready_with_concerns|blocked|failed`; `next` proposing `ew-blueprint`, `ew-roadmap`, `ew-analyze`, or `ew-plan` only when durable follow-up artifacts are needed), then seal or transition the Run per `evolve skill workflows show session-run`.

Do not implement changes in this step. Do not replace the Session chain with an untracked recommendation.
