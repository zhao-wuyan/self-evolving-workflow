# Workflow: ew-review

Multi-dimensional code and artifact review inside an Evolve Run. Consumes `current-execution` and `session-priors`, verifies implementation quality across four dimensions, runs a zero-residual check, and writes `outputs/review.json` (`review-findings/1.0`) and `report.md`.

## Pipeline

1. **Resolve Target & Load Context**
2. **4-Dimension Audit** (standard) or **Focused Diff Audit** (`--tier quick`)
3. **Zero-Residual & Evidence Verification**
4. **Write `outputs/review.json` and `report.md`**
5. **Seal Run & Route Knowledge**

---

## Step 1: Resolve Target & Load Context

1. Read bound inputs via Run MCP (`read_artifact`) or `evolve run artifact-read <run> <alias> --session <session>`:
   - `current-execution`: extract changed files, task results, and self-check evidence.
   - `session-priors`: reuse applicable `review` and `coding` Wiki rules for the matching scope.
2. When the target adds paths or categories outside `session-priors`, query `wiki_context` / `memory_search` and open selected entries with `wiki_reference` / `memory_get` (in CLI-only runs, use `evolve context "<query>" --session <session> --include-memory --reads "<run_dir>/knowledge-reads.json"`, then `evolve wiki get <id> --resolved` / `evolve memory get <id>` with `--reads` and `--from-search <search-id>`).
3. Resolve the target file set:
   - Explicit file/dir path -> inspect those files.
   - `HEAD` / `staged` -> `git diff HEAD` / `git diff --staged`.
   - Bound `current-execution` -> `change-manifest` / changed files and diff against base commit.

---

## Step 2: 4-Dimension Review Audit

Audit every target file across all four dimensions (under `--tier quick`, focus on `correctness` and `security` across the changed hunks):

| Dimension | Focus |
| --- | --- |
| `correctness` | Logic errors, edge/boundary cases, null/undefined handling, race conditions, type mismatches, missing error propagation, broken invariants |
| `security` | Injection, XSS/CSRF, auth/permission bypass, secret leakage, path traversal, unsafe deserialization, untrusted input handling |
| `performance` | Hot-path regressions, N+1 queries, memory/handle leaks, unbounded loops/allocations, blocking I/O |
| `architecture` | Layer/boundary violations, circular dependencies, contract drift, duplicated logic, abstraction leaks |

Parallel execution options:
- Launch one read-only subagent per dimension (`invoke_subagent` in Antigravity; `spawn_agent` / `spawn_agents_on_csv` in Codex; native `task`/eval `agent()` with `reviewer` in OMP, shared `context` + `tasks[]`; join/cancel every child before advancing, never poll) returning structured findings. Native agent duties do not enforce OS read-only permissions; strict OMP analysis uses the separate CLI bridge below.
- For an independent cross-model check, explicitly select an authorized model different from the original model. The existing Codex bound command remains:
  `evolve delegate "<review prompt with target files and scope>" --to codex --mode analysis --session <session> --run <run>`
  For OMP use `--to omp --mode analysis --model <authorized-selector> --session <session> --run <run>` with the same prompt; for Agy use `--to agy --mode analysis` without binding flags. Explicitly resolve the authorized second-opinion model on each host before claiming cross-model independence. Same-model children are another perspective, not independent-model verification; apply the [host contract](../../../SKILL.md#omp-native-delegation-and-strict-cli-analysis).

---

## Step 3: Zero-Residual & Evidence Verification

Cross-check implementation completeness against disk state:

1. Verify every claimed file change and convergence criterion in `current-execution` matches actual repository files.
2. Check for residual `TODO`/`FIXME`/debug statements, dead imports, broken relative Markdown links, or skipped/weakened assertions in tests.
3. Run the narrowest relevant verification command(s) if not already evidenced in `current-execution` and record the exact exit status and output summary.
4. Deduplicate findings by `(file, line, root_cause)` and classify each by severity (`critical`, `high`, `medium`, `low`).

---

## Step 4: Write Outputs & `report.md`

Write `{run_dir}/outputs/review.json` matching `review-findings/1.0`:

```json
{
  "_meta": {
    "kind": "review-findings",
    "schema": "review-findings/1.0",
    "role": "primary"
  },
  "target": "<resolved target>",
  "tier": "standard",
  "dimensions_reviewed": ["correctness", "security", "performance", "architecture"],
  "summary": {
    "critical": 0,
    "high": 0,
    "medium": 0,
    "low": 0,
    "total": 0,
    "remaining_actionable": 0
  },
  "zero_residual_check": {
    "status": "passed",
    "checks": []
  },
  "findings": [
    {
      "id": "REV-001",
      "dimension": "correctness",
      "severity": "high",
      "file": "path/to/file.ts",
      "line": 42,
      "title": "Short title",
      "description": "What is wrong and why",
      "evidence": "Observed code/diff or command output at file:line",
      "suggestion": "Concrete remediation",
      "status": "open"
    }
  ]
}
```

Write `{run_dir}/report.md` with frontmatter (`verdict`, `summary`, `constraints`, `decisions`, `concerns`, `next`) and fixed sections (`Summary`, `Conclusion/Verdict`, `Discussion/Retrospective`, `Artifacts`, `Handoff/Next`):
- Set `verdict: ready` when `critical == 0` and `high == 0` and zero-residual check passes.
- Set `verdict: ready_with_concerns` when non-blocking findings or unverified limits remain; route `next` to `ew-plan` or `ew-execute` when fixes are needed.
- Set `verdict: blocked` when `critical > 0` or a hard verification failure prevents acceptance.

---

## Step 5: Seal Run & Knowledge Hooks

Seal the Run via:

```text
evolve run complete <run_id> --session <session_id> --actor <actor_id> --expected-orchestration-revision <orchestration_revision> --expected-run-revision <run_revision> --summary "<observed review summary>" --verdict done|done_with_concerns
```

Use `--verdict done_with_concerns` when actionable findings remain. Stage any reusable review constraints or defect patterns after sealing through `ew-knowledge` (`evolve workflows show knowledge`).
