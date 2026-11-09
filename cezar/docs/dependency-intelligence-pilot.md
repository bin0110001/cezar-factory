# Dependency Intelligence pilot

This pilot exercises the local SQLite projection with seeded issues from two repositories and injected source failures. It runs on a developer machine, uses no GitHub Actions compute, and makes no GitHub writes. GitHub remains the authority; the database is disposable cache and audit history.

## Run

From the Cezar monorepo directory:

```powershell
npm test -- packages/cezar/src/server/dependency-graph
```

The pilot fixture is an `acme/factory` issue blocked by an `acme/cezar` issue. `pilot.test.ts` runs the source adapter and actual SQLite store against that fixture, then injects a stale compare-and-swap request, a GitHub outage, and an immediate retry. The suite also pins cross-repository identity, evidence, and untrusted issue-content rules.

## Failure-injection matrix

| Scenario | Injection | Expected result | Test evidence |
| --- | --- | --- | --- |
| Offline GitHub | Make the source runner fail after one complete sync | Keep the last graph readable, mark it stale, redact credentials from the warning | `service.test.ts` — retains a stale projection; `store.test.ts` — cache remains available offline |
| Concurrent/stale write | Submit a decision or simulation against an older revision | Compare-and-swap rejects the write; no decision is added | `store.test.ts`, `service.test.ts`, `algorithms.test.ts` |
| Stale source | Pin an old snapshot or mark a refresh unavailable | Readiness is unknown and scheduler admission fails closed | `algorithms.test.ts`, `admission.test.ts` |
| Prompt injection in issue text | Seed an issue body with instructions to edit files | Agent prompt labels all issue text as untrusted, tools remain `Read` only, and no issue text enters trend points | `agents.test.ts`, `service.test.ts` |
| Retry exhaustion | Reserve attempts for the same cycle fingerprint past its cap | No new run starts after the three attempt budget; cooldown is persisted in SQLite | `agents.test.ts`, `store.test.ts` |
| Replay and export | Read an earlier immutable revision, weekly trend points, and bounded diagnostics | Historical readiness and bottlenecks remain reproducible; the trend response omits issue bodies and evidence excerpts | `pilot.test.ts`, `store.test.ts`, `service.test.ts` |

## Budgets and limits

- GitHub sync reads at most 100 pages of 100 issues per full pass; incomplete pages never authorize readiness.
- Weekly trend history returns at most 100 revisions and five bottlenecks per week. Each bottleneck is an issue ID plus a direct blocked-issue count; no issue body is included.
- Graph health diagnostics cap each category at 20 rows; diagnostics export caps cycles and decision candidates at 50 each.
- Algorithm stress coverage uses a 5,000-node acyclic chain to guard against recursive stack growth. The pilot treats a dependency-graph test run under 30 seconds as the local regression budget; this is a diagnostic budget, not a completion-time forecast.

## Rollback

The pilot is read-only with respect to GitHub. If the local validation fails, stop the pilot and keep the current Cezar checkout; no remote state needs repair. For a deployed code regression, roll back the Cezar code to the prior reviewed `dev` commit, restart Cezar through its supported host deployment flow, and leave the graph database intact. The next successful read-only sync reconciles the projection from GitHub. Never repair the SQLite file by hand or restore an older graph over newer GitHub dependencies.
