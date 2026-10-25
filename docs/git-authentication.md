# Git authentication inside Cezar

Every Factory remote is HTTPS (`https://github.com/<owner>/<repo>.git`). Inside the Cezar container the
only credential is the persistent `gh` login in the `cezar-gh-config` volume
(see `docs/credential-rotation.md`). Git reaches it through a credential helper baked into
`cezar/Dockerfile`:

```
credential.https://github.com.helper = !gh auth git-credential
GIT_TERMINAL_PROMPT=0
```

Rotating the token therefore fixes `gh` and `git push` together; there is nothing else to update.

## Rules for agents and scripts

- Never put a token in a remote URL, a `credential.helper` value, a file under `/tmp`, or a command line.
  A helper whose value is a URL is not a helper: git runs it as `credential-<value>` and echoes the
  value (token included) in the error.
- Never set `credential.helper=` or `GIT_ASKPASS` to work around a failed push. Diagnose with
  `gh api user --jq .login` (is `gh` logged in?) and
  `git config --show-origin --get-regexp credential` (is the helper present, or overridden?).
- If the helper is missing in a long-running container, the image is stale: redeploy
  (`scripts/deploy/deploy-bazzite.sh`) instead of patching the container.

## Symptoms

| Error | Cause |
| --- | --- |
| `could not read Username for 'https://github.com'` | No credential helper (stale image) or `gh` logged out. |
| `credential-https://...@github.com is not a git command` | A repo-local `credential.helper` was set to a URL. Remove it with `git config --local --unset-all credential.helper`. |
| `Permission denied` writing `~/.gitconfig` | Container UID differs from the image's `cezar` user; set system config as root or fix in the image. |
