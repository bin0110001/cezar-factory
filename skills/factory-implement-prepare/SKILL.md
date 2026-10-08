<!--
managed-by: cezar-factory
factory-version: 0.3.33
source: skills/factory-implement-prepare/SKILL.md
-->
# Factory Implementation Preparation Skill

Prepare the selected issue before implementation begins.

1. Extract the numeric issue number and URL from the workflow task. Do not
   search the filesystem for an issue copy or use anonymous GitHub requests.
2. Run exactly this first preparation command, using the registered Factory
   runtime and the extracted issue number:

   `pwsh -NoProfile -File $FACTORY_RUNTIME_ROOT/scripts/prepare-implementation.ps1 -Issue <issue number> -OutputPath .factory/implementation-context.json`

3. If the command fails, inspect its complete error once. Retry only with a
   corrected issue number or syntax. If `gh`, credentials, or the runtime is
   unavailable, stop and report the blocker; do not guess or switch shells.
4. Confirm that `.factory/implementation-context.json` exists and contains the
   selected issue number, issue URL, issue body/comments, and environment
   metadata. Do not edit source files, lifecycle labels, or the issue.

The next workflow step owns implementation. Leave the context artifact in the
worktree for that step to consume.
