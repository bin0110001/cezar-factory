# Governance guard

`scripts/factory/protect-governance.ps1` runs as the `protect-governance` command step in `workflows/implement.yaml` and
`workflows/fix-review.yaml`, before targeted tests. It compares the working tree, index and commits against the merge
base (the handoff's `baseCommit`, else `origin/dev`/`origin/stable`) and fails when an agent diff touches a protected
asset. Renames and deletions count as touching both paths.

Protected assets are declared in `policies/protected-assets.json`:

| Category | Rule |
| --- | --- |
| `policy` | any change under `policies/**` or `config/promotion-policy.json` |
| `baseline` | any change to baseline files (`**/baselines/**`, `*.baseline*`, `*-baseline.*`) |
| `check-selection` | `.ai/factory/test-ownership.json` (deleting or renaming it also fails): removing a check, dropping a pattern, changing a command or relaxing `unmapped` fails; adding checks/patterns is allowed |
| `ledger-evidence` | append-only: new files and pure appends pass; a modified file must keep the base content as an unchanged byte prefix, so truncation or in-place rewrite fails, as do deletes and renames. Covers `.factory/ledger`, `.factory/verification`, `.factory/repair-ledger*`, `.factory/evaluations`, `.factory/artifacts/validation`, `.factory/ship-loop/receipts`, `.factory/release-reports`, `ledger/`, `evidence/` |
| `evidence-schema` | the evidence manifest, validation receipt and authorization schemas |
| `guard` | the guard script and the two workflows that run it |

The ledger (#52) and focused selection (#53) paths are globs in the manifest; update the manifest when their final
locations land.

## The only bypass: an authorized review

1. A reviewer who is neither the PR author nor the acting identity submits an **APPROVED** GitHub review on the head
   commit whose body contains the `factory-governance-waiver:<sha256>` tag printed by the failing guard (hash of the exact
   sorted protected paths).
2. `.factory/governance-authorization.json` references it (`schemas/governance-authorization.schema.json`: `pr`,
   `reviewer`, `headCommit`, exact `paths`). The marker authorizes nothing on its own; the guard verifies the review on
   GitHub (state, commit, reviewer association, tag). Environment variables, commit-message tags and agent-written markers
   without that review are rejected.

Every accepted waiver is printed, written to `.factory/governance-guard.json`, and appended (append-only) to
`.factory/ledger/governance-waivers.jsonl`. Until the #52 ledger lands this file is the waiver record; there are no
hidden waivers. Tests: `tests/protect-governance.ps1` (negative case per asset class plus forgery cases; uses throwaway
repos and a fake `gh`, never deploys).

## Threat model and evidence binding (#580)

An implementation agent writes inside its worktree, so it could forge a passing record by editing history (truncate, rewrite,
delete or rename ledger/receipt files), loosening policy, baselines or mandatory checks, or by copying a genuine passing
record from another head or attempt. The guard closes the first group by diff against the trusted base; most `.factory/*`
paths are gitignored, so they are listed for completeness and for any tracked copy.

Binding rule: every verdict record carries `attemptId` (`-AttemptId` or `FACTORY_ATTEMPT_ID`) and `headSha`.
`scripts/factory/verify-evidence-binding.ps1` rejects (exit 1) a record whose `headSha` differs from the current head, whose
`attemptId` differs from the current attempt, or that lacks either binding. Pre-existing unbound records are accepted only
with `-AllowLegacy`, only if `headSha` matches, and with a loud warning. The consumer of a verdict/evidence record must run it
with the immutable head and attempt id of the run being decided.
