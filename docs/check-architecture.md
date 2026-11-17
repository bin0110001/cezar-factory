# Architecture and API compatibility check (#670)

`cezar/packages/cezar/src/server/verification/checks/providers/architecture-adapter.ts` is an opt-in, incremental check provider behind the
check-provider contract (`docs/check-provider-contract.md`). It consumes structure rather than recreating it: import edges come from the
code graph (an injected `readEdges`), and planned scope and consumer impact come from the Change Impact Manifest (`PlannedScope`, built
from `server/impact/manifest.ts`). Nothing here parses source or runs a process.

**Rules** are versioned per project (`architectureRulesSchema`, version 1): named modules by path glob, boundaries (`from` must not
import `to`, with a reason), cycle detection (module or file level) and the public contracts with the files that define them. A boundary
that names an unknown module is rejected.

**What it reports**, only for violations that involve changed files (incremental, deterministic):

- `arch.boundary:<from>-><to>`: a changed file imports a forbidden module (high), with path, line and the rule's reason.
- `arch.cycle:<members>`: a strongly connected component (Tarjan) that includes something changed (medium).
- `arch.api-removed:<id>` and `arch.api-changed:<id>`: a public contract's signature hash differs between two surface snapshots; additions
  are fine (high).
- `arch.unplanned-change` and `arch.unplanned-contract:<id>`: a changed file outside the planned files and modules, or a changed contract
  the plan did not declare (low and medium).

**Policy and baselines.** Findings are in the `custom` category, so they are quality debt: baselined violations stay visible
(`visibleDebt`) and do not block, and a new one blocks only where the finding policy sets `blockQualityDebtAt`
(`docs/check-findings-policy.md`). With no rules configured the check is NOT_APPLICABLE through planning
(`planArchitectureCheck`), never a silent pass; a plugin run without rules reports `unknown`.

Not done here: producing the import edges and the API surface snapshots (the code graph and the contract extractors), and wiring the check
into a project's profile.
