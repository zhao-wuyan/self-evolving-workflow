---
name: ew-skill-design
description: Design, migrate, or validate an Evolve project Skill with linked Markdown, a Session/Run contract where needed, and reproducible host cases.
session-mode: none
version: 0.6.0
---

# Evolve Skill Design

Use this Skill (directly or when routed by `AGENTS.md`, `ew-knowledge`, or `workflow-evolve`) when authoring/migrating `skills/<id>/SKILL.md` or when a closeout candidate matches the structural routing criteria in `ew-knowledge` `references/knowledge-route.md` rule 8 (`evolve skill workflows show ew-knowledge`): requires a new Skill contract/lifecycle gate, new artifacts/outputs, cross-Skill routing or multi-stage branching, at least 3 stable steps, or an explicit new/migrated Skill. Single-evidence behavioral fixes (single inline instruction or conditional link) continue through `workflow-evolve` instead.

## Workflow

1. **Resolve context & lifecycle**:
   - Follow the canonical Knowledge Gate: outside a Run, use `evolve search "<query>" --mode context` (or `node dist/workflow-cli.js search "<query>" --mode context` in this checkout); inside an Evolve Run, follow `evolve skill workflows show session-run` (prefer `session-priors` when its scope matches, otherwise use CLI `--reads "<run-dir>/knowledge-reads.json"`).
   - Inventory existing entry points, flags, inputs, outputs, and recovery paths when migrating a Skill.
   - Choose `session-mode: run` when durable progression, coordinator decisions, or artifact handoff is needed; otherwise use `session-mode: none`.
2. **Enforce Progressive Disclosure (`SKILL.md` vs `references/`)**:
   - Keep `SKILL.md` focused on: frontmatter (`name`, `description`, `session-mode`, `contract`, `required_links`), trigger/routing table, non-negotiable invariants, and short common steps.
   - Move mode details, schemas, checklists, and examples into package-relative `.md` links (see [the package contract guide](references/package-contract.md)). Normalized paths must stay inside the package root; never use cross-package `../` links.
   - Keep every entry in `required_links` minimal and literally linked in `SKILL.md`.
3. **Validate & verify**:
   - Follow [the replay and release procedure](references/validation.md) to validate the committed Git revision and exercise the main flow, one passing case, and affected recovery paths.

## Evolve design-task handoff

- When entered from `evolve kb candidates route`, inspect the task with `evolve skill design task <task-id>` and run `evolve skill design run <task-id> --runner <script>` (or `node dist/workflow-cli.js` in this checkout).
- Return a `skill-design/1.0` envelope (`task_id` + replayable `draft` naming the target entry, evidence sources, baseline hash, priority, and conditional links; or `mode: "package"` with `changes` for new/contract-changing packages; a change with `"content": null` deletes that package file, e.g. learnings folded into the body during consolidation — never the entry or a linked document).
- Do not edit the target Skill during draft generation; **the caller** (the invoking agent/operator or orchestrator) runs `evolve skill design review <design-id>` and `evolve skill design replay <design-id> --runner <script> --scenarios <json>`.
- **Apply confirmation gate & rollback**: Runtime enforces `review → replay` before `apply`; additionally, before running `evolve skill design apply <design-id>`, verify that replay passed all scenarios and obtain explicit approval (user confirmation in interactive sessions, or an Agy confirmation receipt in automated gates). If post-apply verification fails or a regression appears, immediately run `evolve skill design rollback <design-id>`.
