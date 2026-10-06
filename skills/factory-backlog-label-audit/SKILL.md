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
- Consider only the candidates emitted by the installed audit script. In Cezar,
  invoke the mounted runtime directly at
  `/projects/cezar-factory/scripts/audit-backlog-labels.ps1`. Use
  `.ai/factory/scripts/audit-backlog-labels.ps1` only outside Cezar as a
  local-install fallback. The script is mandatory; it
  fetches, filters, and reserves the bounded candidates.
- This is a single bounded pass: run the candidate source once, process only its emitted candidates, and write one result. Do not list issues again, create a temporary audit script, or retry with a different shell command. If the source command fails, stop and report the failure.
- If neither registered script path exists or the selected command fails, stop the run as failed. Do not search the filesystem, call `gh issue list`, switch shells, call MCP/resource discovery, install tools, or reconstruct the candidate list manually.
- Do not read, print, parse, lint, or judge the script source. A displayed or serialized script body is not an audit result; only its exit status and the emitted input artifact are valid evidence. Never replace it because it appears incomplete.
- The only filename to resolve or execute is `audit-backlog-labels.ps1`.
  `create-labels.ps1` is an internal sibling used by that script; never resolve
  it as the audit entry point.
- Preserve every existing non-Factory label. Never remove a legacy/project label.
- Resolve the script only from `/projects/cezar-factory/scripts/audit-backlog-labels.ps1` in Cezar, then `.ai/factory/scripts/audit-backlog-labels.ps1` outside Cezar; do not use any other path. It ensures Factory labels using its own installed location and writes `.factory/backlog-label-audit-input.json`. The candidate's `labels` are the pre-audit source snapshot; the `staged` entry records the post-fetch `factory:auditing` reservation. Do not treat that source snapshot as the issue's current labels.
- For each selected issue, add exactly `factory:new`, one `type:*`, and one `risk:*` label. Use the candidate's `typeHint` and `riskHint` when present; `test` is `type:test`, never `type:maintenance`. Do not add
  `agent:*` labels.
- Never use `factory:needs-help` for work that can proceed autonomously. It is reserved for a genuine human decision, missing external input, or conflicting requirement. The candidate script's temporary `factory:auditing` reservation is the sole audit exception.
- The candidate script resolves every clear legacy marker it fetched: `blocked`/`blocker` becomes `factory:blocked`; `needs-decomp` becomes `factory:needs-plan` plus `complexity:large`; and an unambiguous legacy type becomes `factory:new`, `type:*`, and `risk:*`. Only genuinely ambiguous items are left in `candidates` and reserved with `factory:auditing`; the LLM sees at most the requested three. Do not reconsider entries in `resolved`; record them exactly as emitted. If an issue is an epic or tracking parent, replace an `factory:auditing` reservation with `factory:tracking` and record the reason. Retain `factory:needs-help` only for a genuine human escalation. Each outcome prevents repeat evaluation without changing the issue body or adding a comment. A skipped issue without one of these durable closing labels is an audit failure, never a valid skip.

## Classification

Use existing labels as primary evidence: `bug` maps to `type:bug`; `test` maps to `type:test`;
`enhancement` maps to `type:feature`; `migration` or `architecture` maps to `type:refactor`;
documentation/localization-only work maps to `type:docs`. Otherwise use `type:maintenance` only for
maintenance/operational work. If no mapping is defensible, skip it.

Set `risk:high` only for security, destructive migrations, production/network credentials, or broad
architecture changes. Set `risk:medium` for normal code changes and `risk:low` for isolated tests,
documentation, or non-production maintenance. When uncertain, skip.

## Procedure

1. In Cezar, run exactly one direct command from the scheduled worktree:

   `pwsh -NoProfile -File /projects/cezar-factory/scripts/audit-backlog-labels.ps1`

   Do not add a resolver, environment-variable interpolation, shell wrapper,
   or fallback search. Outside Cezar only, use
   `pwsh -NoProfile -File .ai/factory/scripts/audit-backlog-labels.ps1` when
   that local-install path exists. If the selected command fails, the audit is
   failed and must stop. Do not substitute `create-labels.ps1`, search for
   scripts, or inspect source.
   Then read the exact `outputPath` reported in the emitted JSON. It must be
   under the current scheduled worktree; never read a project-root or prior-run
   `.factory/backlog-label-audit-input.json`. This is the only issue-discovery
   operation. Do not call `gh issue list`, inspect raw issue-list JSON, or
   list additional issues.
2. Copy `resolved` entries directly into the result; do not inspect or alter
   them. Choose only from the remaining at-most-three `candidates`. Retrieve
   only those issue bodies if needed. Do not fetch or inspect any other issue.
3. Re-read each candidate's labels immediately before writing, to avoid racing a human or another run. The expected audit reservation is `factory:auditing`; if any other Factory label has appeared, record it as skipped without editing.
4. For every candidate, execute and re-read one closing label edit before reporting it. For classifiable work, replace the reservation with `factory:new`, one `type:*`, and one `risk:*`. For decomposition-needed work, replace it with `factory:needs-plan`, one `type:*`, one `risk:*`, and `complexity:large`; this routes it to autonomous large-model planning. For an epic or tracking parent, replace it with `factory:tracking`; for blocked work, replace it with `factory:blocked`; retain `factory:needs-help` only for a genuine human escalation.
5. If the closing edit or re-read fails, stop the audit as failed. Do not call the issue skipped and do not emit a successful audit record. A `skipped` entry is valid only when its `added` array names the durable closing label visible in the re-read.
6. Re-read labels after each edit and write `.factory/backlog-label-audit.json`:

The result file must contain only the candidates from the input file. Never add
issues discovered in a later listing or from a prior audit artifact. Use the
repository's PowerShell/runtime file-writing mechanism; do not use shell
heredocs or create files outside the repository.

```json
{
  "considered": [123],
  "changed": [{"issue": 123, "added": ["factory:new", "type:bug", "risk:medium"]}],
  "skipped": [{"issue": 124, "reason": "tracking parent", "added": ["factory:tracking"]}]
}
```
