# Documentation reference and decision drift check (#672)

`cezar/packages/cezar/src/server/verification/checks/providers/doc-drift-adapter.ts` is a check provider behind the check-provider contract
(`docs/check-provider-contract.md`). It adds no documentation engine.

**Broken references, changed docs only.** For each Markdown file a change touched, `checkDocReferences` reports relative links whose target does
not exist (or escapes the repository), anchors with no matching heading (in the same file or in a linked Markdown file), backticked repository
paths that do not exist, and `path#Symbol` references the symbol lookup rejects. External URLs, fenced code blocks and valid references are
ignored. File and symbol existence are injected lookups, so the provider reads no repository itself. Because only changed docs are examined,
existing breakage elsewhere cannot block unrelated work.

**Decision drift, existing results.** The decision lifecycle and drift detection own the judgement; this provider only exposes their results
(`DriftResult`: decision id, `in-sync` / `drifted` / `unknown`, a summary, evidence references and files). A drifted decision becomes a
`docs.decision-drift:<id>` finding (medium) whose title carries the evidence as provenance; `unknown` is informational; `in-sync` is silent.

**Policy.** Findings are `custom`, that is quality debt, so existing breakage can be baselined and stays visible without blocking
(`docs/check-findings-policy.md`), and a new broken reference or drift blocks only where the finding policy sets `blockQualityDebtAt`. A run
with no changed docs and no drift results reports `unknown`, not a pass.

Not done here: producing the drift results (the dependency-intelligence and spec-first work) and the file and symbol lookups are adoption steps;
no module in this repository currently emits drift results, so the provider takes them as input.
