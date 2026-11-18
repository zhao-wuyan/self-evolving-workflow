---
name: release-gate
description: Validate release readiness against active Wiki constraints and emit a structured release-gate/1.0 artifact.
version: 0.1.0
session-mode: run
required_links:
  - references/check-checksum.md
contract:
  contract_version: 2.1
  consumes: []
  produces:
    - path: outputs/release-gate.json
      kind: verification
      schema: release-gate/1.0
      role: primary
      alias: latest-release-gate
      required: true
---

# Release Gate

1. Resolve active knowledge constraints with `evolve search "release gate" --from kb --mode context --kind constraint --task release --category review --trace`.
2. Follow [the checksum verification guide](references/check-checksum.md) to validate `artifact_sha256`.
3. Write `outputs/release-gate.json` with `schema_version: "release-gate/1.0"`, `environment`, `artifact_sha256`, `decision`, `reasons`, `consulted_knowledge_ids`, and `consulted_memory_ids`.
