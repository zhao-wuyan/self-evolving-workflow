# Project Skill Package Contract

## Frontmatter & Links

- **`name`**: Must match the package directory name (except `ew-odyssey-*`, where `name` is `ew-odyssey` and `src/workflow-skills.ts` binds per-mode `contract` and `required_links` from `references/prepare/odyssey-<mode>.md`).
- **`description`**: State exact invocation triggers and boundaries.
- **`session-mode`**: `none` for standalone Skills; `run` for stateful Skills with `contract` (`contract_version: 2.1`).
- **`required_links`**:
  - Include ONLY documents that every invocation must preload. Keep conditional/mode guides as standard body links without putting them in `required_links`.
  - Every item in `required_links` MUST appear as a literal relative Markdown link inside `SKILL.md` (for `ew-odyssey-*`, inside `ew-odyssey/SKILL.md`), resolve after path normalization (`posix.join`) to a committed regular `.md` file inside the same Skill package root (must not escape the package root; cross-package `../` links are forbidden — reference other packages via `evolve skill workflows show <id>`), and any `#heading` fragment must match an actual heading.
- **Host portability**: Use capability-neutral wording in shared workflow rules instead of hardcoding host-specific tool names (shell commands, structured user prompts, or subagent spawning). Isolate any host tool mappings in a dedicated adapter reference (or, for vendored upstream playbooks, provide an explicit host adapter mapping section in the entry document so upstream prompts translate cleanly to the active host).

## Session/Run Contract (`contract_version: 2.1`)

```yaml
session-mode: run
required_links:
  - references/check.md
contract:
  contract_version: 2.1
  consumes:
    - kind: findings
      alias: current-analysis
      schema: findings/1.0
      role: primary
      required: true
  produces:
    - path: outputs/verification.json
      kind: verification
      schema: verification/1.0
      role: primary
      alias: latest-verification
      required: true
```

## Output & Boundary Rules

- Put all typed outputs under the Run's `outputs/` directory with matching `_meta` / frontmatter (`kind`, `schema`, `role`, optional `alias`).
- Use `report.md` for execution narrative and `evidence/` for verification traces; keep scratch files outside `outputs/`.
- Define observable pass conditions, blocked states, and next authorized actions at each phase boundary. The coordinator drives progression via Session/Run commands and receipts.
