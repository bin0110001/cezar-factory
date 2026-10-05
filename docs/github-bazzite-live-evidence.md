# Bazzite Cezar GitHub live evidence

Verified on 2026-10-04 against the Bazzite host `Chinchilla` at
`192.168.86.69`.

The active Cezar container is `cezar` (`localhost/cezar:local`). It includes
GitHub CLI and mounts the persistent `cezar-gh-config` volume at
`/home/cezar/.config/gh`. The container runs as UID 10001, while the empty
mounted directory was owned by UID 1001 and could not be written. The directory
owner was corrected to UID/GID 10001 and mode 0700. The GitHub token was then
stored with `gh auth login --with-token` over the verified SSH connection; no
token value is recorded in this repository.

Read-only verification from inside Cezar:

- `gh api user --jq .login` returned `bin0110001`.
- `gh api repos/bin0110001/cezar-factory --jq .full_name` returned
  `bin0110001/cezar-factory`.
- `gh api --method GET search/issues -f q='repo:bin0110001/cezar-factory is:issue'`
  returned `total_count: 0`.
- The persisted `hosts.yml` is owned by UID/GID 10001 with mode 0600.

The GitHub CLI auth fix is on Bazzite in Cezar's persistent config volume.
No issue, pull request, or other GitHub state was changed. The full issue/PR
lifecycle remains unverified. The separate OpenHands `default` agent profile
currently has no MCP server references, so this evidence covers Cezar's CLI
path only.
