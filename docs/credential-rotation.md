# Rotate Cezar's GitHub credential

Run `scripts\deploy\rotate-cezar-github-token.bat` from Windows after you
revoke the old GitHub personal access token and create its replacement.

The helper connects to Bazzite, prompts for SSH authentication when needed,
then prompts for the new GitHub token on the remote terminal with echo
disabled. The token is streamed directly into `gh auth login`; it is never
added to a command line, file, repository artifact, or environment variable.
It verifies the account with `gh api user --jq .login`, deliberately avoiding
`gh auth status` because that command can display token metadata.

To point it elsewhere, set `SSH_TARGET` or `SSH_KEY` in the Command Prompt
before invoking it. For example:

```bat
set SSH_TARGET=operator@factory-host
set SSH_KEY=C:\Users\you\.ssh\factory_key
scripts\deploy\rotate-cezar-github-token.bat
```
