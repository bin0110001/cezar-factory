# GitHub authentication boundaries

GitHub API access, native Git transport, and the `gh` CLI are separate authentication paths.
An OAuth connection for the GitHub MCP authorizes API calls; it does not authenticate `git` or
`gh` in a Cezar checkout.

## Supported Cezar boundary

In the Cezar container, host-owned native Git and `gh` operations use the persistent login in the
`cezar-gh-config` volume (see [credential rotation](credential-rotation.md)). The image configures
Git's global GitHub credential helper as `gh auth git-credential`, with `GIT_TERMINAL_PROMPT=0`.
The checkout service invokes `gh repo clone` from the host process. It does not copy credentials
into a clone's local Git config or task worktrees. Spawned agent environments drop `GITHUB_TOKEN`,
`GITHUB_ENTERPRISE_TOKEN`, `GH_TOKEN`, `GH_ENTERPRISE_TOKEN`, and `GH_CONFIG_DIR`, including when
environment passthrough or the legacy full-environment option is enabled. Provider-specific
`COPILOT_GITHUB_TOKEN` remains separate and is passed only to the Copilot backend when configured.

This is a shared host boundary, not per-user or per-run isolation. Agent subprocesses run as the
Cezar service account and can invoke Git or `gh` against the same global helper and login. Filtering
token variables prevents direct environment handoff; it does not prevent shell commands from using
the shared host login. Do not describe the login as a credential broker or claim it limits a
process to one repository. A future isolated-run design would need an explicit credential owner,
scoped issuance policy, and process/filesystem isolation.

## Rules for agents and scripts

- Never put a token in a remote URL, a `credential.helper` value, a file under `/tmp`, a command
  line, or an agent environment. Do not persist the global helper in a repository-local Git config.
- Keep GitHub API calls on their configured MCP/OAuth path. Built-in authenticated `git` and `gh`
  operations should use host-owned Cezar services. Arbitrary agent shell commands share the global
  login as described above; do not imply that this boundary prevents their use of it.
- Do not pass host GitHub credentials through prompts, per-run environment, worktree config,
  process arguments, or logs.
- Never set `credential.helper=` or `GIT_ASKPASS` to work around a failed push. Diagnose on the
  host with `gh api user --jq .login` and `git config --show-origin --get-regexp credential`.
- If the global helper is missing in a long-running container, the image is stale: redeploy through
  the supported deployment workflow instead of patching the container by hand.
- A missing or rejected host login must produce a clear authentication failure. MCP API success
  alone is not evidence that native Git or `gh` operations are available.

## Symptoms

| Error | Cause |
| --- | --- |
| `could not read Username for 'https://github.com'` | No host credential helper, or `gh` is logged out. |
| `credential-https://...@github.com is not a git command` | A local or global `credential.helper` was set to a URL. Remove the bad entry from its owning config. |
| `Permission denied` writing `~/.gitconfig` | Container UID differs from the image's `cezar` user; fix the image or host configuration. |
