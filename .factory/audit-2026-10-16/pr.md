The workflow map still described a superseded risk-based human merge path. Correct it to match the current router, explicitly distinguish an auto-merge request from an observed merge, and record the source audit and structural remediation plan.

The audit is tracked in #17 with six native child issues (#18, #19, #20, #21, #22, #23), reciprocal dependencies and an evidence-preserving link to existing defect #1. The report records two reproduced false-positive validation cases, release/deployment recovery gaps, and current GitHub configuration blockers.

Validation: full local Factory suite passed against the initial working tree, automation catalog and release metadata checks passed, documentation whitespace/issue-link checks passed, and independent documentation/source review completed with its factual correction applied. The suite result is explicitly scoped to the original audited tree, not this docs-only branch or deployed infrastructure.

Only two documentation files change. Existing local work remains in the original checkout. No Factory runtime assets or repository settings are changed, no operational defect is claimed resolved, and no target deployment is performed. Auto-merge is currently disabled and dev has no protection rule; do not bypass those missing gates. This PR does not close the remediation tracking issue.

Related: #17, #18, #19, #20, #21, #22, #23.
