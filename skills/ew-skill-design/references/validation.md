# Validate and Release a Project Skill

## Static & Contract Validation

- Run `evolve skill validate <id> --root <repo>` (or `node dist/workflow-cli.js skill validate <id>` in this checkout).
- Note that Evolve binds the **committed Git revision (`HEAD^{commit}`)** — working-tree edits are ignored until committed (use a test commit in an isolated worktree to test unpublished changes).
- Fix any broken link, package-escaping `..` path (escaping the Skill package root), unsupported lifecycle, or output schema mismatch at the source.

## Runtime & Replay Verification

- **Stateful Skills (`session-mode: run`)**:
  - Verify a fresh Run binds the expected commit and `contract`.
  - Read `SKILL.md` and exercised links via `evolve run read skill`, confirm input aliases and output schemas, and run `evolve run check` before `evolve run complete`.
  - When migrating existing guidance, also resume a Run bound to the prior commit and replay one historically successful case.
- **Standalone Skills (`session-mode: none`)**:
  - Verify the actual host entry, expected outputs, and completion receipt.
- **Design-task apply & rollback**:
  - After `review` and `replay` pass, obtain explicit confirmation before `evolve skill design apply <design-id>`; revert any failed or regressed application with `evolve skill design rollback <design-id>`.

## Routing: `ew-skill-design` vs `workflow-evolve`

- Canonical boundary: follow rule 8 of `ew-knowledge` `references/knowledge-route.md` (`evolve skill workflows show ew-knowledge`). Route to **`ew-skill-design`** when a candidate needs a new Skill contract/lifecycle gate, new artifacts/outputs, cross-Skill routing/multi-stage branching, at least 3 stable steps, or an explicit new/migrated Skill.
- Otherwise route single-evidence behavioral fixes (single instruction or conditional link) to **`workflow-evolve`** (`evolve session review <session-id>` -> `draft` -> `replay` -> `apply` / `rollback`). For priority placement (`high` inline <= 280 chars vs `normal`/`low` under `references/learnings/`), see `skills/workflow-evolve/references/agy-gate.md` (`evolve skill workflows show workflow-evolve`).
