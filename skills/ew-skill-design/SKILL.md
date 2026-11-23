---
name: ew-skill-design
description: "Design, migrate, or validate an Evolve Skill package (`skills/<id>/SKILL.md`). Use when authoring or migrating a Skill, adding a Session/Run contract or artifacts, or resolving `consolidate_recommended` / `skill-design` closeout routes."
session-mode: none
version: 0.6.0
---

# Evolve Skill Design

Use this Skill (directly or when routed by `AGENTS.md`, `ew-knowledge`, or `workflow-evolve`) to author or migrate `skills/<id>/SKILL.md` when a change requires a new Skill contract/lifecycle gate, new artifacts/outputs, cross-Skill routing or multi-stage branching, at least 3 stable steps, `consolidate_recommended` consolidation, or an explicit new/migrated Skill (`ew-knowledge` `references/knowledge-route.md` rule 8; `evolve skill workflows show ew-knowledge`). Single-evidence behavioral fixes continue through `workflow-evolve`.

## Workflow

1. **Resolve context, invocation, and Dual Loads**:
   - Satisfy the canonical Knowledge Gate first: outside a Run, use `evolve search "<query>" --mode context` (or `node dist/workflow-cli.js search "<query>" --mode context` in this checkout); inside an Evolve Run, follow `evolve skill workflows show session-run` (reuse matching `session-priors`, or use CLI `--reads "<run-dir>/knowledge-reads.json"`).
   - For migrations, inventory every existing entry point, flag, input, output, and recovery path.
   - Choose invocation mode by **Dual Loads** (`context load` vs `cognitive load`):
     - **Model-invoked** (default; omit `disable-model-invocation`, keep branch-triggered `description`) when the agent or another Skill must fire it autonomously — its `description` pays permanent **context load** on every turn.
     - **User-invoked** (`disable-model-invocation: true`, one-line human `description` with trigger lists stripped, and matching `policy.allow_implicit_invocation: false` in `agents/openai.yaml` when present) when only the human types `/skill` — zero context load, spending **cognitive load** instead (group crowded user-invoked Skills behind a router Skill).
   - Choose `session-mode: run` when durable progression, coordinator decisions, or typed artifact handoff is required; otherwise use `session-mode: none`.
   - *Done when*: Knowledge Gate recorded, invocation mode + `session-mode` justified by Dual Loads, and all migration surfaces inventoried.

2. **Structure by Information Hierarchy and Positive Authoring**:
   - Apply **Progressive Disclosure** (see [the package contract guide](references/package-contract.md)): keep `SKILL.md` to frontmatter (`name`, `description`, `session-mode`, optional `disable-model-invocation`, `contract`, `required_links`), trigger/routing table, core invariants, and ordered steps. Move mode details, schemas, checklists, and examples into package-relative `.md` links under `references/` with paths normalized inside the package root.
   - Keep `required_links` minimal (universally preloaded files only) and literally linked in `SKILL.md`.
   - **Co-locate** each concept's definition, rules, and caveats under one heading; keep one authoritative source of truth and leave trivial lookups (`package.json`, `--help`, directory layout) to the environment.
   - Anchor behavior with sharp **leading words** and **positive framing** (state the target behavior directly so undesirable patterns stay out of context; pair any unavoidable hard guardrail with its positive target).
   - End every step (and flat reference set) on a checkable, exhaustive **completion criterion** to guard against premature completion; split a sequence across a real context boundary (hand-off or subagent dispatch) only when sharpening the bound fails to stop rushing.
   - Prune **no-ops** (delete whole sentences that restate model defaults or use weak qualifiers) and **sediment** (stale layers kept out of inertia).
   - *Done when*: All branch-only material is disclosed under `references/`, every step has a checkable completion criterion, `required_links` is minimal and literally linked, and prose passes positive-framing & no-op/sediment pruning.

3. **Validate & Verify**:
   - Follow [the replay and release procedure](references/validation.md) to verify strict YAML frontmatter, host-invocation parity, committed Git revision binding, and reproducible passing/recovery cases.
   - *Done when*: Static frontmatter & contract validation pass on the committed revision and every required runtime/replay scenario passes cleanly.

## Evolve design-task handoff

- When entered from `evolve kb candidates route`, inspect the task with `evolve skill design task <task-id>` and run `evolve skill design run <task-id> --runner <script>` (or `node dist/workflow-cli.js` in this checkout).
- Return a `skill-design/1.0` envelope (`task_id` + replayable `draft` naming the target entry, evidence sources, baseline hash, priority, and conditional links; or `mode: "package"` with `changes` for new/contract-changing packages; a change with `"content": null` deletes an absorbed package file such as consolidated learnings while preserving the entry and linked documents).
- Leave the target Skill untouched during draft generation; **the caller** runs `evolve skill design review <design-id>` and `evolve skill design replay <design-id> --runner <script> --scenarios <json>`.
- **Apply confirmation gate & rollback**: Runtime enforces `review -> replay` before `apply`; before running `evolve skill design apply <design-id>`, verify all replay scenarios passed and obtain explicit approval (user confirmation in interactive sessions, or an Agy confirmation receipt in automated gates). On post-apply failure or regression, run `evolve skill design rollback <design-id>` immediately.
