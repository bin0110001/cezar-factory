<!-- Change contract (spec-first path, docs/spec-first.md). Fill this in before code changes.
     Behavioral contract below is authoritative; generated wiki/docs are derived and never approved here. -->
# Change contract: <issue title>

- Issue: #<n>
- Approved base SHA: <sha>   <!-- the contract is stale once the target branch moves past this on a touched path -->
- Revision: 1
- Impact manifest: <link to impact-manifest.json (docs/impact-manifest.md)>

## Spec
Behavior that must hold, one verifiable statement per item. Each item has an id (C1, C2, ...).

## Design
Public interfaces, schema/serialization migrations, boundaries, affected projects, dependent issues (#145/#154).

## Invariants
Each invariant names the test that pins it.

## Tasks
Ordered, each mapped to the contract ids it satisfies.

## Acceptance
Each id maps to evidence: test name or #132 acceptance evidence. No evidence means unverified.

## Open decisions
Only decisions that change compatibility, ownership or the system contract.
