# Local utility workflow live evidence

Captured 2026-10-03 by running the checked-in
`scripts/local/run-local-job.ps1` against the Bazzite LiteLLM gateway.

- Job: `summarize-logs`
- Endpoint: `http://192.168.86.69:4001`
- Logical model: `factory-small`
- Input: `docs/litellm-live-evidence.md`
- Result: structured JSON with `status=success`, summary, evidence, and artifact references
- Provider usage: 704 total tokens
- The runner remained advisory and made no repository changes.

The gateway credential was loaded into process memory for the test and is not recorded here.
