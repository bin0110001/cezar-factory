<!--
managed-by: cezar-factory
factory-version: 0.3.2
source: skills/factory-backlog-label-audit/SKILL.md
-->
# Factory Backlog Label Audit Skill

Normalize legacy GitHub issues into the Factory taxonomy carefully. This is a label-only migration,
not triage and not implementation.

The repository being audited is the project named by the task. Do not create
Factory implementation issues there. Factory infrastructure defects belong in
`bin0110001/cezar-factory`; confirm the repository before creating an issue.
Never copy a private project's issue body or URL into a public repository without
explicit approval; report the needed Factory work and request a sanitized issue
if cross-repository tracking is required.

## Hard boundaries

- Do not change source code, issue title/body, milestones, assignments, projects, or issue state.
- The script may normalize every deterministically classifiable open issue in
  one run. Process **at most three** genuinely ambiguous issues in the LLM
  session.
- Consider only the candidates emitted by the read-only collector. The
  workflow invokes the mounted runtime collector and then a deterministic
  preparation consumer before this skill is given to the LLM. The collector
  selects candidates and fetches their bounded bodies; the consumer applies
  deterministic labels and creates reservations.
- This is a single bounded pass: consume the collector artifact performed
  before the LLM step, process only its emitted candidates, and write one
  result. Do not run the collector, list issues again, create a temporary
  audit script, or retry with a different shell command. If a pre-LLM step
  fails, the workflow stops before this skill.
- The workflow validates the handoff before this skill starts. If reading the
  validated artifact fails for any reason, make one concise failure report and
  stop immediately. Do not try another path, shell, tool, or equivalent
  existence check.
- Do not read, print, parse, lint, or judge the script source. A displayed or serialized script body is not an audit result; only its exit status and the emitted input artifact are valid evidence. Never replace it because it appears incomplete.
- The workflow's preparation consumer may call the installed sibling
  `create-labels.ps1` to ensure the taxonomy. The skill must not run scripts.
- Preserve every existing non-Factory label. Never remove a legacy/project label.
- You never execute or resolve any Factory script. The workflow runs `/projects/cezar-factory/scripts/audit-backlog-labels.ps1` as a read-only collector, then a deterministic preparation consumer applies static classifications and reserves ambiguous candidates before this skill starts. The worktree-local `.factory/backlog-label-audit-input.json` preserves collection-time `labels`; `staged` records the reservation the workflow applied. Do not treat the source snapshot as the issue's current labels.
- For each selected issue, propose exactly `factory:new`, one `type:*`, and one `risk:*` label. Use the candidate's `typeHint` and `riskHint` when present; `test` is `type:test`, never `type:maintenance`. Do not add
  `agent:*` labels.
- Never use `factory:needs-help` for work that can proceed autonomously. It is reserved for a genuine human decision, missing external input, or conflicting requirement. The candidate script's temporary `factory:auditing` reservation is the sole audit exception.
- The collector classifies clear legacy markers in the input artifact: `blocked`/`blocker` proposes `factory:blocked`; `needs-decomp` proposes `factory:needs-plan` plus `complexity:large`; and an unambiguous legacy type proposes `factory:new`, `type:*`, and `risk:*`. The workflow-owned preparation consumer validates and applies these entries and reserves only the genuinely ambiguous candidates. The LLM sees at most the requested three candidates. Do not reconsider or copy `resolved` entries into the candidate proposal. If a candidate is an epic or tracking parent, propose `factory:tracking` and record the reason. Retain `factory:needs-help` only for a genuine human escalation. Every proposal must include a durable closing label; a bare skipped outcome is invalid. The deterministic consumer applies candidate edits after the proposal and verifies them without changing issue bodies or adding comments.

## Classification

Use existing labels as primary evidence: `bug` maps to `type:bug`; `test` maps to `type:test`;
`enhancement` maps to `type:feature`; `migration` or `architecture` maps to `type:refactor`;
documentation/localization-only work maps to `type:docs`. Otherwise use `type:maintenance` only for
maintenance/operational work. If no mapping is defensible, skip it.

Set `risk:high` only for security, destructive migrations, production/network credentials, or broad
architecture changes. Set `risk:medium` for normal code changes and `risk:low` for isolated tests,
documentation, or non-production maintenance. When uncertain, skip.

## Procedure

1. The workflow's pre-LLM steps have already run the read-only collector exactly
   once and applied its deterministic classifications/reservations. You must not run it, or any other Factory
   script, and must not add a resolver, shell wrapper, fallback search, or
   retry. If a pre-LLM step failed, the workflow stops before this skill. Do not
   search for scripts or inspect source. Read the exact `outputPath` reported in the emitted JSON. It must be
   under the current scheduled worktree; never read a project-root or prior-run
   `.factory/backlog-label-audit-input.json`. This is the only issue-discovery
   operation. Do not call `gh issue list`, inspect raw issue-list JSON, or
   list additional issues.
2. Choose only from the remaining at-most-three `candidates`, using the
   pre-fetched `body` included for each candidate. Do not retrieve issue bodies,
   fetch, or inspect any other issue.
3. Do not read GitHub state or apply any changes. The deterministic workflow consumer owns live state checks, label edits, and verification after this proposal is written.
4. For every candidate, propose exactly one durable closing Factory state label. For classifiable work, use `factory:new`, one `type:*`, and one `risk:*`. For decomposition-needed work, use `factory:needs-plan`, one `type:*`, one `risk:*`, and `complexity:large`; this routes it to autonomous large-model planning. For an epic or tracking parent, use `factory:tracking`; for blocked work, use `factory:blocked`; use `factory:needs-help` only for a genuine human escalation. Include a concise rationale. Do not use a bare skipped outcome.
5. Write `.factory/backlog-label-audit.json` as a proposal for the deterministic consumer:

The result file must contain only the candidates from the input file. Never add
issues discovered in a later listing or from a prior audit artifact. Use the
repository's PowerShell/runtime file-writing mechanism; do not use shell
heredocs or create files outside the repository.

```json
{
  "considered": [123],
  "changed": [{"issue": 123, "added": ["factory:new", "type:bug", "risk:medium"], "reason": "legacy bug label"}],
  "skipped": [{"issue": 124, "reason": "tracking parent", "added": ["factory:tracking"]}]
}
```

The workflow consumer validates that every candidate appears exactly once, rejects unsupported labels, rechecks the open issue's current labels against the collected snapshot and reservation, applies the proposal, and verifies the result. If current state changed, the consumer fails closed; do not retry with a new issue listing or edit labels manually.
