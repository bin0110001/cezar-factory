# Reliability analytics

The Verification History page includes a project-scoped, read-only reliability rollup for 7, 30,
or 90 UTC days. It groups recorded validation and issue-run evidence by project and resolved model,
shows daily counts, and offers a fingerprint drilldown with source and baseline SHAs plus evidence
IDs from the deterministic finding ledger. It does not use Hindsight to infer causes.

## Metric rules

- **First-pass validation** is the first parseable verification result recorded for a Cezar work run.
  The denominator includes only work runs with a recorded validation result in the selected window.
- **Bounded repair success** counts a non-infrastructure first validation failure followed by a pass
  in at most three recorded validation results (the initial result plus two retries). Infrastructure
  errors are excluded from this denominator.
- **Infrastructure** is a verification or check result explicitly marked `infrastructure-error`.
- **Flaky** requires the same project, source SHA, and check ID to have both a failed and a passing
  result in the retained history.
- **Regression** requires a failed check on a source SHA with an explicitly recorded `baseSha` and a
  passing result for the same project and check on that exact base SHA. A missing match is
  **unknown**, never a regression inferred from time or nearby commits.
- A fingerprint drilldown is **mixed** when its retained occurrences have more than one of these
  classifications; the summary counts remain per occurrence.
- **Closed unmerged** GitHub PRs are counted separately from merged PRs; the UI calls them closed
  unmerged to avoid claiming why a publisher closed them. A merged PR is marked **reverted** only
  when the local coding ledger records `delivery.reverted` or its GitHub timeline has a
  cross-reference whose PR title identifies a revert.
- **Time to accepted PR** is measured from the associated Cezar work start to the GitHub merge
  timestamp. The median includes only one-to-one run/PR links with both timestamps; status alone
  does not invent a duration.

## Coverage and retention

The API reports unreadable validation events, validation rows without a coding-run link, missing
baseline SHAs, unavailable GitHub status, and a cap when more than 50 PRs are linked in the window.
It checks at most eight terminal PR timelines per request; the response discloses when that cap is
hit. Failure drilldowns are limited to the 20 most frequent fingerprints and 20 issue, check, SHA,
verification, or evidence IDs per fingerprint. These caps keep each response bounded.

The finding ledger retains observations for 180 days by default. The analytics endpoint does not
change or extend that policy. The selected window controls which verification results and PR
associations contribute; matching passing results for flaky/regression classification may come
from any retained observation. Existing Cezar run retention and local ledger availability bound
the history that can be reported.

`GET /api/v1/p/:projectId/verification/analytics?windowDays=30` returns the same versioned
contract used by the UI. Valid windows are 7, 30, and 90 days. The endpoint is read-only and degrades
GitHub lookup to explicit unknown outcomes when the project has no usable GitHub access.
