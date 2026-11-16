# Untrusted-input policy tests (#581)

Proves that malicious input cannot widen permissions or skip approval. It reuses the existing guards (#104 protected
assets, #113 isolation, #101 review/baseline controls, #346 capability broker, #134 memory provenance); there is no
new policy engine. Fixtures live in `tests/fixtures/untrusted-input/` and are inert: nothing is executed and no
network is used. Tests run in the local suite (`tests/run-tests.ps1`); nothing runs on GitHub.

## Scenarios and evidence

| Scenario | Guard exercised | Denial asserted | Audit event asserted |
| --- | --- | --- | --- |
| Prompt-injection issue body (env var + forged marker) | `scripts/factory/protect-governance.ps1` | policy edit fails | `governance-denial` in `governance-denials.jsonl` |
| Repo file with agent instructions (commit-message waiver tag) | `protect-governance.ps1` | policy + baseline edits fail | `governance-denial` |
| Malicious install script (weakens guard, baseline, check selection) | `protect-governance.ps1` | all three categories fail | `governance-denial` |
| Permission widening (policy, promotion posture; capability scope) | `protect-governance.ps1`, `capability_broker.py` | diff fails; unknown scope/key, observe-for-control, cross-project/session/host target, flag-off control denied | `governance-denial`; broker `capability-denied` event (no credential material) |
| Poisoned memory recall / candidate | `scripts/hindsight/client.py` | secrets redacted; remote `validationStatus` ignored; poisoned candidate rejected, never sent | `retrievalCapture` entry with id + content hash; rejection receipt with `candidateHash` |
| Approval negatives: none, no review, non-collaborator, agent self-approval; memory retention unapproved | `protect-governance.ps1`, `client.py retain` | denied | `governance-denial` / `approval-required` receipt |

Tests: `tests/untrusted-input-policy.ps1`, `tests/test_untrusted_input_policy.py`.

## Gaps found and fixed

- The governance guard wrote only a report on denial; it now also appends a `governance-denial` record.
- The capability broker emitted no denial events; it accepts an optional `audit` callback.
- Hindsight recall trusted a remote memory's `validationStatus`; only the local provenance index can now grant it.
- `scrub` left the token in `Authorization: Bearer <token>`.

## Residual risks

- The guard judges the diff, not the process: an install script that acts at run time (network, files outside the
  worktree) is contained only by per-run isolation (#113), which this suite does not execute against.
- Recall text is redacted for secrets but is still free text; prompt-injection wording inside a memory is not
  detected, only prevented from gaining validated status or approval.
- `governance-denials.jsonl` is a local file beside the report, not tamper-evident storage.
- There is no single untrusted-input classifier; each guard is tested at its own boundary.
