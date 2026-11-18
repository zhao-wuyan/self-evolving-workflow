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

1. Read bound inputs via `evolve run read artifact <run> <alias> --session <session>`:
   - `current-execution`: extract changed files, task results, and self-check evidence.
   - `session-priors`: reuse applicable `review` and `coding` Wiki rules for the matching scope.
2. Complete the Run Knowledge Gate (`evolve skill workflows show session-run`) when the target adds paths or categories outside `session-priors`.
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
- Launch one read-only subagent per dimension (`workflow-reviewer` / `workflow_reviewer`, via `invoke_subagent` in Antigravity, or `spawn_agent` / `spawn_agents_on_csv` in Codex; OMP hosts use native `task`/eval `agent()` with `reviewer`, batching independent slices through `context` + `tasks[]`; fall back to inline role instructions when absent; join/cancel every spawned subagent before advancing, never poll) returning structured findings. Native agent duties do not enforce OS read-only permissions; strict OMP analysis uses the one-shot CLI worker below.
- For an independent cross-model check, explicitly select an authorized model different from the original model and run:
  `evolve agent exec "<review prompt with target files and scope>" --to codex --mode analysis --session <session> --run <run>`
  (or `--to agy --mode analysis` without `--session`/`--run` for an unbound second opinion; for OMP use `--to omp --mode analysis --model <authorized-selector> --session <session> --run <run>` with the same prompt — OMP is a one-shot restricted worker). Explicitly resolve the authorized second-opinion model on each host before claiming cross-model independence. Same-model children are another perspective, not independent-model verification; apply the [host contract](../../../SKILL.md#omp-native-delegation-and-strict-cli-analysis).

---

## Step 3: Zero-Residual & Evidence Verification

Cross-check implementation completeness against disk state:

1. Verify every claimed file change and convergence criterion in `current-execution` matches actual repository files.
2. Check for untracked residual defects in reviewed diffs (`TODO`/`FIXME`/debug statements, dead imports, broken relative Markdown links, or skipped/weakened test assertions), building on `ew-verify`'s `antipattern-report.json` when present rather than duplicating its full scan.
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
    "role": "primary",
    "alias": "latest-review"
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
- Set `verdict: ready` when `critical == 0` and `high == 0` and the zero-residual check passes -> seal with `--verdict done`.
- Set `verdict: ready_with_concerns` whenever the review itself finished (`outputs/review.json` written) yet actionable findings remain (`critical > 0`, `high > 0`, non-blocking findings, or unverified limits) so `latest-review` seals and binds for downstream remediation -> route `next` to `ew-plan` (`--gaps`, `needs: [latest-review]`) for multi-file/multi-step fixes, `ew-companion` (`<= 3` findings, `<= 2` files, single concern), or `ew-odyssey-review` (iterative standalone repair campaign) — **never** route `next` directly to `ew-execute` — and seal with `--verdict done_with_concerns`.
- Set `verdict: blocked` or `failed` ONLY when `ew-review` itself cannot perform a grounded review (missing/unreadable target or broken verification tools) -> do **not** call `run complete`; transition via `evolve run transition` per `evolve skill workflows show session-run`.

---

## Step 5: Seal Run & Knowledge Hooks

Seal or transition the Run per `evolve skill workflows show session-run` (all required reads satisfied; no extra exit gates on `ew-review`). When high-signal recurring defect patterns surface, record them via `evolve kb add --kind episodic "<pattern>" --type error --scene review --session <session_id>`, and after sealing stage reusable review constraints or defect patterns through `ew-knowledge` (`evolve skill workflows show ew-knowledge`).
