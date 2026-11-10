---
name: factory-finish-release
description: Apply the gates and produce a complete handoff for an explicitly requested Factory Production Run or live deployment.
---

# Factory finish and release

Use this skill only for a **Production Run** or an explicit request to deploy
live. Ordinary development uses Dev mode, local validation, and a reviewed PR
targeting `dev`. Production target, promotion, and Bazzite parity gates must
not interrupt that work.

This skill owns release decisions and the final report. It does not tell the
model to run Factory scripts. A workflow's `command:` steps own Factory
script execution, validation, Cezar synchronization, and supported host
deployment. If no such workflow is configured, report the missing workflow
as the remaining handoff instead of substituting direct script execution.

## Release gates

1. Require passing local validation and a recorded self-review with no open
   findings before a change is eligible to merge.
2. Preserve unrelated working-tree changes. Never reset, clean, stash, or
   overwrite user work to make a release appear ready.
3. Read targets only from the host-local `config/factory-projects.json` or
   targets explicitly supplied by the user for this Production Run. If the
   registry is absent or empty, make no external changes and report that
   target configuration is pending.
4. Treat the shared mounted Factory checkout as the default. A target marked
   `mode: shared` receives automation synchronization only. Use `projectPath`
   only when a target still needs the full local Factory layer; it must be an
   absolute verified path on the workflow host.
5. Keep remote-only Cezar synchronization separate from deployment of
   application or `integrations/` files. Bazzite service changes require the
   configured deployment inventory and supported host flow.
6. Require a clean, expected, version-matched Bazzite checkout, complete
   runtime parity, and all configured review gates before declaring the
   release successful. Never pull, reset, copy over, or delete a mismatched
   remote checkout.
7. The normal promotion owner is the host's `factory-local-promotion` timer;
   it validates the exact merged `dev` commit, activates `dev`, runs canaries,
   then advances `stable` according to policy. The host's autodeploy timer
   reconciles `stable`. A Production Run selects the controlled posture.
8. The legacy per-project push path is deprecated. Do not retire it until a
   complete shadow-audit receipt reports `legacyPushRetirementReady: true`.
   The same-host controller/autodeploy locks must cover any legacy operation.

## Required handoff

Report the local Factory version and tested commit, validation receipt, each
configured target and result, Bazzite version/mount/runtime parity when
applicable, PR number and base branch, review status, and promotion or
deployment receipt. State any target, workflow, or host configuration that
remains pending. A matching version or successful automation API response
alone does not establish a complete release.
