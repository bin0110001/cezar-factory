# Test-effectiveness safeguards (#671)

`cezar/packages/cezar/src/server/verification/checks/providers/test-effectiveness-adapter.ts` is a check provider behind the check-provider
contract (`docs/check-provider-contract.md`), category `test`.

- **Existing weakening guard.** `parseWeakeningGuard` wraps `scripts/check-weakening.ps1`: exit 0 is clean (or the guard is not enabled), exit 1
  turns each `  - message` violation on stderr into a high-severity finding with a stable id, exit 2 fails closed (an error, never a pass).
- **Source-level weakening.** `analyzeTestChanges` compares test files before and after: a deleted test file, removed test cases, newly skipped,
  disabled or pending tests, and removed assertions with the tests left in place (TypeScript, Python and .NET patterns). New test files and
  non-test files are ignored.
- **Impacted suites.** The change-impact selection (#53) is consumed, not recomputed: an impacted suite that did not execute (skipped or not run)
  is reported and makes an otherwise clean result `unknown` with a reason, never a pass. A real failure stays a failure (a new `unknown` flag on
  the runner output can only turn a pass or warning into `unknown`).
- **Changed-line coverage (optional).** Changed source lines below a minimum percentage are reported; with no coverage data there is no
  opinion. The coverage trend stays in `quality-metrics` (#649).
- **Flaky quarantine.** A failing test is quarantined only for the environment fingerprint it was observed in, only while unexpired, and only
  if a human or operator reviewed it (the #651 review rules); otherwise it blocks again. A quarantined failure is reported as informational.

Findings go through the finding policy, so existing weakening can be baselined (#54) and stays visible without blocking, and a new one blocks
where policy says so.

Not done here: running the guard script, producing the test file diffs and the coverage, and selecting suites are adoption steps; the provider
takes their results as inputs.
