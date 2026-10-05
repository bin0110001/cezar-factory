# Bounded local utility jobs

Factory local jobs are deliberately narrow model calls. They classify or
summarize supplied evidence; they do not edit repositories, choose lifecycle
transitions, or persist memory by themselves.

The runner is `scripts/local/run-local-job.ps1`. It sends an OpenAI-compatible
JSON request to LiteLLM and defaults to the `factory-small` logical model.
Configure the endpoint with `LITELLM_URL`, the credential with
`LITELLM_MASTER_KEY`, and override the model with `FACTORY_LOCAL_MODEL` when
needed.

Example:

```powershell
$env:LITELLM_URL = 'http://127.0.0.1:4001'
$env:LITELLM_MASTER_KEY = 'host-local-secret'
./scripts/local/run-local-job.ps1 `
  -Job summarize-diff `
  -InputPath artifacts/diff-context.txt `
  -OutputPath artifacts/local-summary.json
```

The runner caps injected context at 12,000 characters by default and records
the selected job, model, endpoint, structured result, and provider usage in
the output envelope. Use `-MaxChars` for a smaller bounded context; values
outside 100–50,000 are rejected.

Local jobs are advisory. Their output must be validated or reviewed by the
calling workflow before it changes GitHub state or becomes durable project
memory. The routing policy in `routing/local-jobs.yaml` is the source of truth
for supported job classes and their context limits.
