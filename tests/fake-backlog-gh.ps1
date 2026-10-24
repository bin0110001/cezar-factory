param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
$ErrorActionPreference = 'Stop'
Get-Content -Raw -LiteralPath $env:FAKE_BACKLOG_ISSUES
