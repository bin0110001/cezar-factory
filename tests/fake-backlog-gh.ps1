param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
$ErrorActionPreference = 'Stop'
# FAKE_BACKLOG_ARGS_LOG records each call's arguments, one line per call.
if ($env:FAKE_BACKLOG_ARGS_LOG) { Add-Content -LiteralPath $env:FAKE_BACKLOG_ARGS_LOG -Value ($Arguments -join ' ') }
# FAKE_BACKLOG_FAIL_FIRST=N makes the first N calls fail like a truncated GitHub response (counter kept in FAKE_BACKLOG_COUNTER).
if ($env:FAKE_BACKLOG_FAIL_FIRST) {
    $calls = 1 + [int](Get-Content -Raw -LiteralPath $env:FAKE_BACKLOG_COUNTER -ErrorAction SilentlyContinue)
    Set-Content -LiteralPath $env:FAKE_BACKLOG_COUNTER -Value $calls
    if ($calls -le [int]$env:FAKE_BACKLOG_FAIL_FIRST) { [Console]::Error.WriteLine('unexpected end of JSON input'); exit 1 }
}
Get-Content -Raw -LiteralPath $env:FAKE_BACKLOG_ISSUES
