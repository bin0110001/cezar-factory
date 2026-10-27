---
name: factory-project-onboarding
description: Onboard a new GitHub repository into Cezar Factory with a dev branch, target registration, Factory labels, bounded issue seeding, reviewed release, and runtime parity checks.
---

# Factory project onboarding

Use this skill when a new GitHub repository must become a Cezar/Factory project. The goal is a verified handoff from an empty or issue-only repository to an enabled, observable project—not merely a source checkout.

## Scope and boundaries

- Work only with the explicitly named repository and the host-local target registry. Never scan drives or infer deployment targets.
- The onboarding implementation is `scripts/onboard-project.ps1`, but Factory scripts may run only from a workflow `command:` step. This skill must not invoke the script or substitute direct `gh` mutations for it.
- Check whether an approved onboarding workflow owns that command. If none exists, report that the workflow-owned onboarding entry point is missing and stop before creating branches, labels, registry entries, or issues.
- The onboarding entry point does not merge pull requests, enable live automations, dispatch issue work, or repair a Bazzite checkout. Keep those actions behind the normal review and release gates.
- Confirm that the corresponding Cezar project exists before reporting onboarding complete. A GitHub repository alone is not a configured runtime target.

## Procedure

1. Resolve the canonical GitHub repository, Cezar project ID/API endpoint, project type, and an explicitly requested target registry entry. For a first pass, bound issue seeding to three open issues unless the operator requests another limit.
2. Hand off the resolved inputs to the approved onboarding workflow. Prefer its dry-run mode when the target entry is new or uncertain, and review its summary for the `dev` branch, labels, registry update, and seeded issue IDs. If no such workflow exists, report the gap; do not call the script from this skill.
3. Distinguish automation synchronization from project-layer installation. Remote-only synchronization creates Cezar automation records but does not install the project’s `.ai/cezar` workflows, skills, policies, or scripts. If Cezar’s workflow list contains only `quick-task`, use an approved workflow-owned full-layer installation with a dry run first. If that workflow is unavailable, report the gap.
4. Enable requested Factory features in the project-owned config through the supported installation workflow. For maintenance, `features.maintenance: true` should materialize `factory-maintenance`, `factory-backlog-label-audit`, and the maintenance automation definition. Verify Cezar registers `factory-maintenance` before a manual or scheduled run. An automation with an unregistered workflow fails as `unknown workflow`.
5. Verify seeded issues have `factory:new` only when they lack an existing `factory:*` state label. Do not overwrite workflow state; intake owns subsequent routing.
6. Put Factory content changes through the required PR targeting `dev`. Obtain independent review before requesting auto-merge; do not merge a failed, unresolved, or unreviewed PR.
7. After merge, follow the `factory-release` and `factory-finish-release` process. Promote only a fully tested commit to `stable`, synchronize explicitly configured Cezar targets, and enable automations through the release process.
8. Verify runtime parity before declaring success: the Bazzite checkout is clean and on the promoted stable commit, the Factory version and mounted Cezar version agree, the `factory-autodeploy.timer` is enabled and active, and the new project reports its expected automation count and enabled state.

## Recovery and stop conditions

- There is no UI force-refresh substitute for the release gate. If a host is stale, inspect the checked-in guidance in `docs/shared-factory.md` and use only the documented, operator-authorized host setup/recovery.
- Stop rather than resetting, overwriting, or manually editing a dirty or diverged Bazzite checkout. Stop as well when the host-local deployment inventory or target registry is missing, or when the timer/service cannot be verified.
- A remote-only automation sync does not deploy application or infrastructure files. Use the documented host deployment flow for Bazzite services and their bind-mounted configuration.
- For an empty generic repository, the full-layer verifier may report missing project-owned validation scripts or ignore rules. Record those as onboarding gaps and do not misrepresent a successful workflow registration as a clean application verification.

## Handoff report

Report the repository, `dev` branch result, target registration, seeded issue IDs, project-layer installation and feature flags, registered workflow names, PR/review state, promoted stable SHA/version, per-target synchronization result, Bazzite checkout/container parity, timer state, and the new project's enabled automation count. Call out any skipped repair or remaining human gate explicitly.
