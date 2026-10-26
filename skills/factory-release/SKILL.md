---
name: factory-release
description: Validate Factory-managed changes and hand off release work through reviewed repository gates and explicitly configured release automations.
---

# Factory release

Use this skill after any change under `scripts/`, `skills/`, `workflows/`,
`policies/`, `templates/`, `automations/`, or Factory versioning.

## Invariants

- Read targets only from `config/factory-projects.json`; never scan for or
  invent deployment targets. If the registry is absent or empty, finish local
  validation, report that target configuration is needed, and make no external
  release changes.
- For configured targets, every listed target must receive its required release
  action even when the Factory version is unchanged. A matching version does
  not prove synchronization.
- Validate the changed assets and automation catalog before any release action.
- Shared-mount promotion is allowed only after the validated implementation
  commit has merged to `dev` through the reviewed PR path. A feature branch is
  never promoted directly.
- Remote-only synchronization updates Cezar automation definitions; it does
  not deploy Factory scripts, skills, workflows, or application files. A full
  `.ai/factory` installation requires an absolute, verified local `projectPath`
  in the registry and a successful dry run.
- Bazzite-hosted runtime changes require the supported host deployment path.
  Cezar workflow commands run inside its Linux container, where
  `/projects/cezar-factory` is a container mount, never a Windows path.
- A skill or workflow prompt must not ask the model to run Factory scripts.
  Script-backed release work belongs to workflow `command:` steps. If no
  approved release automation is configured for the required action, report
  that handoff gap instead of running scripts from the model session.
- Stop on a failed target and report its exact configured identity; never
  silently skip it or redirect it to another project.

## Shared-mount release

Projects use the Factory checkout mounted into Cezar. The release candidate is
the tested merge commit, never an unmerged feature branch.

1. The implementation PR targets `dev` and has independent review plus the
   high-risk plan-approval gate when applicable. Request GitHub auto-merge only
   after those gates pass.
2. After merge, stable promotion is performed by the approved post-merge
   release process, which runs the catalog and full-suite gates before moving
   `stable`. Do not ask the model to invoke a promotion script.
3. The Bazzite `factory-autodeploy` timer advances the mounted checkout and
   reconciles automations. For immediate host deployment, use the supported
   host process and stop on a dirty checkout, divergence, or runtime mismatch.

Shared entries use the mounted checkout for Factory content. Remote-only
entries receive automation synchronization. A local project path is used only
when a target needs the full managed Factory layer.

## Procedure

1. Validate the changed assets, full Factory suite, automation catalog, and
   release metadata. Preserve unrelated work and report any failed gate.
2. Check the host-local target registry only. If it is missing or empty, report
   that release is ready but needs explicit target configuration; perform no
   promotion, synchronization, deployment, or target discovery.
3. For each configured target, use its approved release automation if one is
   present. Queue that automation with `cez automation run <id>`, report the
   returned task ID, and stop. Do not inspect its worktree or create a
   replacement task.
4. If a configured target requires release work and no approved automation
   exists, report the missing workflow-owned release path. Do not run a Factory
   script directly from the skill.
5. Report local validation, each configured target's result, runtime parity,
   and any release handoff gap.
