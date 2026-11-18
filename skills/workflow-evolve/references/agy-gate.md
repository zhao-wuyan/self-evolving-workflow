# Agy gate

Every round has two Agy calls.

## Discussion response

The first call receives the baseline observations, history review (open signals only), the Skill learning inventory (`evolve skill learnings`), and the feedback from earlier failed attempts in the same round. It must return JSON with this shape.

```json
{
  "approved": true,
  "operation": "add|supersede|retire",
  "priority": "high|normal|low",
  "instruction": "one concise Skill instruction",
  "when": "optional trigger for normal or low priority guidance",
  "supersedes": ["learning ID replaced by this instruction (supersede only)"],
  "retire": ["learning ID removed without new text (retire only)"],
  "signals": ["history signal ID addressed by this change"],
  "evidence": ["receipt or verification reference"],
  "rationale": "why the change is attributable and minimal",
  "needs_revision": []
}
```

`approved` means the suggestion is ready to turn into a draft. Agy must set it to `false` when the evidence is missing, the change is broader than the observed failure, or the candidate triggers structural criteria in `ew-knowledge` `references/knowledge-route.md` rule 8 (`evolve skill workflows show ew-knowledge`, e.g. new Skill contract, new artifacts, cross-Skill routing, >= 3 stable steps, an explicit new Skill, or learning bloat). Structural candidates route to `ew-skill-design` after the loop.

## Operation choice

- **`add`** (default when `operation` is omitted): no existing learning covers the trigger. Requires `priority` and `instruction`. Rejected when the inventory reports `consolidate_recommended`.
- **`supersede`**: an existing learning was read in the failing Run and did not prevent the failure, or it is wrong. Requires `supersedes`, `priority` and `instruction`; the old blocks, index entries and documents are removed in the same candidate.
- **`retire`**: a learning is marked `retire_candidate` / `unused`, conflicts with the passing scenarios, or the main body already covers it. Requires `retire`; `rationale` becomes the retirement reason.

The loop marks `signals` (or signals whose sources appear in `evidence`) as addressed after a verified `applied` round; addressed signals do not drive later proposals.

## Priority placement and constraints

`evolve skill draft` (`src/skill-addition.ts`) maps `priority` to the exact Skill modification structure:

- **`high`**: Single-line inline instruction inserted directly after YAML frontmatter in `SKILL.md` (`<!-- evolve:learning:<id> -->`). Must be a single line (no newlines) and **<= 280 characters**.
- **`normal`**: Creates `references/learnings/<id>.md` (no 280-character limit on body) and inserts a conditional Markdown link in `SKILL.md` pointing to `references/learnings/<id>.md` (`when <when>`). `when` must be single-line.
- **`low`**: Creates `references/learnings/<id>.md`, appends a bullet entry pointing to `./<id>.md` in `references/learnings/index.md`, and adds a Markdown link in `SKILL.md` (`<!-- evolve:learning:index -->`) pointing to `references/learnings/index.md`.

## Confirmation response

The second call receives the draft and the complete replay receipt. It must return `approved`, `reason` and `required_changes`. It approves only when every baseline pass remains green, every requested failure is fixed, the candidate loaded the expected Skill documents, and the evidence is traceable to the reviewed execution.

The loop stores both responses under the round directory. `--auto` applies a receipt after this second call returns `approved: true`. Agy owns the evaluation decision for each proposed change.
