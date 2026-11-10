---
name: factory-release
description: Apply Factory release gates and report delivery state for an explicitly requested Production Run or live deployment.
---

# Factory release

Use this skill only for a **Production Run** or an explicit request to deploy
live. Ordinary development and troubleshooting stays in Dev mode and ends
with a reviewed PR to `dev`. Missing production target configuration or host
parity must not stop Dev-mode work.

This skill defines release decisions and evidence. It does not execute Factory
scripts. Factory operational scripts run only from workflow `command:` steps;
the owning workflow performs validation, target synchronization, and host
deployment. If the requested operation has no owning workflow, report that
workflow gap rather than issuing a direct script command.

## Invariants

- Read targets only from the host-local `config/factory-projects.json` or
  targets explicitly supplied for this Production Run. Never scan for or
  invent targets.
- The shared mounted checkout is the default. A project with `mode: shared`
  receives automation synchronization only; it does not receive managed-file
  updates.
- Use `projectPath` only when a project needs the complete local `.ai/factory`
  layer. It must be an absolute, verified path on the workflow host, not a
  Cezar container or remote Bazzite path.
- Remote-only synchronization updates Cezar automation definitions. It does
  not deploy application or `integrations/` files.
- Bazzite-hosted service changes use the explicit deployment inventory and
  supported Bazzite workflow. A dirty, mismatched, or unverified host checkout
  is a release blocker; never overwrite it.
- The shadow audit is read-only and reports remote-only targets as `unknown`.
  Migration uses its fresh receipt, a separate branch, and a recorded
  backout. Keep legacy push support until the receipt's
  `legacyPushRetirementReady` is true.
- A configured release or autodeploy lock must remain held across legacy
  synchronization. If the workflow cannot access the same lock files, stop
  and report that boundary.

## Shared delivery

The normal delivery flow merges reviewed changes to `dev`. The host's
`factory-local-promotion` timer validates the exact merged commit, activates
the `dev` channel, runs canaries, and advances `stable` according to the
promotion policy. The host's `factory-autodeploy` timer then reconciles the
runtime to `stable`. Do not trigger manual promotion or move channel pointers
as part of normal delivery.

A Production Run selects the controlled promotion posture, including its
independent approval and soak requirements. A failed local validation,
missing registry, dirty checkout, failed parity check, or missing review gate
stops the release before the affected state changes.

## Required handoff

Report the tested commit, local validation evidence, configured targets and
their result, Bazzite checkout/runtime parity when applicable, the PR base and
review state, and promotion/deployment receipt state. Mark external target or
host configuration as pending when it is missing; do not claim a release from
a matching version string or a successful automation API response alone.
