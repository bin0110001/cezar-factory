# Graphical worker benchmark (#328)

No figures are recorded here because none have been measured. The `graphicalSession` runtime and the rendered
fixture have not landed on `dev`, so there is nothing to time. Numbers must come from local runs only, never
estimates.

| Measurement | Result | Reason |
| --- | --- | --- |
| Software-render session startup (Xvfb + Mesa) | not yet measured | runtime/fixture not on `dev` |
| Screenshot latency | not yet measured | runtime/fixture not on `dev` |
| Parallel sessions (distinct displays) | not yet measured | runtime/fixture not on `dev` |
| GPU pilot | not yet measured | separately gated; no proven GPU path |

When measured, record: worker OS and CPU, the pinned fingerprint from the evidence doc, number of runs, and
median and p95 per row.
