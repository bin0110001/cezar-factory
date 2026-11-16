# Coding-agent trust boundaries and threat model (#133, #578)

Everything an implementation agent reads is **untrusted data**: issue and PR text, repository files, tool output,
retrieved memory and dependency scripts. Policy and evidence authority lives outside the agent's write scope.
This document maps each boundary to the control that already owns it; it adds no competing framework.

| Boundary | Threat | Owning control |
| --- | --- | --- |
| Policy, baselines, mandatory checks, audit ledger | Agent weakens or rewrites what gates its own work | #104 governance guard (`policies/protected-assets.json`, `docs/governance-guard.md`); append-only ledger; waiver only via an independent approved review (#101) |
| Per-run worktree and workspace | Cross-run contamination, shared state writes | #113 isolated worktrees and fenced workspace claims |
| Session control actions | Permission widening, forged tokens, host targets | `scripts/session/capability_broker.py` (scoped, short-lived, fenced tokens; config may only narrow) |
| Retrieved memory | Poisoned or secret-bearing memory | `scripts/hindsight/client.py` (bounded, provenance-checked, scrubbed) |
| Logs, traces, failure audits, memory writes | Secret leakage | Redaction at the collection boundary: `Protect-FailureText` (PowerShell), `capability_broker.redact` and `hindsight.scrub` (Python) share one rule set |
| Review | Self-approval | #101 independent review or recorded self-review gate |

Malicious issue instructions (for example "enable control", "edit policies/", "print the token") have no channel to
change any of these controls: flags, policy and guard configuration are read from the base revision or the host, never
from issue or repository text.

## Inputs and attacker capabilities

Attacker capability: can write text to a GitHub issue or PR, commit files to a branch, publish or poison a dependency
or its install script, or seed a memory entry. Cannot write the base revision, the host, or the evidence store.

| Input | Control owner | Gap |
| --- | --- | --- |
| GitHub issue / PR text | Guard and flags read from base revision/host (#104); review gate (#101) | none |
| Repository content (instruction files, configs) | Governance guard protected assets (#104) | none |
| Tool output | Collection-boundary redaction | pattern redaction limits (residual risk below) |
| Retrieved memory | `scripts/hindsight/client.py` provenance check and scrub | none |
| Dependency scripts | Run network policy; reviewed as code | residual risk below |
| Model context | Untrusted-data rule above; no authority transfer | none |
| Runner / sandbox | #113 isolated worktrees; scanner profile `docs/scanner-worker-profile.md` | host credential in child env (#166) |
| Logs and traces | Redaction at collection | residual risk below |
| Evidence and policy store | Append-only evidence, head/attempt binding (#580) | none |

## Negative-test scenarios later work must cover

Injected issue body, instruction-bearing repo file, poisoned memory recall, malicious install script, permission
widening, forged capability token, evidence truncation or rewrite, and a planted secret in every output channel. The
first five are implemented in `docs/untrusted-input-security.md` (#581); evidence and scanner secrets are covered by
#580 and `docs/scanner-worker-profile.md`.

## Tests

`tests/test_factory_trust_boundaries.py` (secret redaction for every collector, permission widening, forged tokens,
protected-evidence manifest) and `tests/protect-governance.ps1` (per-asset-class guard negatives and waiver forgery).
All run locally and fail closed.

## Residual risks

- **Host GitHub credential in agent child environments (#166).** Cezar passes its persistent credential to agent
  children for `gh`/Git. Removing it needs the credential-broker decision tracked in #166; until then secrets are
  contained by redaction at collection, not by absence from the environment.
- Pattern-based redaction misses secrets with no recognizable shape or key name.
- Dependency install scripts run with the run's network policy; review them as code.

## Operator response

On a suspected leak: rotate the credential (`docs/credential-rotation.md`), quarantine the run's traces and
artifacts, and file an issue linking the run ID. Guard denials are recorded in `.factory/governance-guard.json`.
