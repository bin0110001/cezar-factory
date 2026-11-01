# Static lint for constructs that make a Factory script wait forever.
#
# Factory command steps run unattended: stdin is closed, there is no terminal, and a stuck call
# blocks the run (and a worker slot) until a deadline kills it. These rules catch the ways a
# PowerShell script commonly ends up waiting on something that will never arrive, so they fail
# in CI instead of in production. Suppress a deliberate use with, on the same line:
#   # hang-lint: allow <rule> - <reason>
# This is a heuristic line scanner, not a parser: it favours few false positives over completeness.

$script:HangLintRules = @(
    @{ Id = 'automatic-input'
       Message = '$input is the automatic stdin enumerator; using it as a variable waits for stdin. Use another name.'
       Pattern = '(?i)\$input\b' },
    @{ Id = 'interactive-prompt'
       Message = 'Prompts for input; unattended steps have no terminal. Take a parameter or environment variable instead.'
       Pattern = '(?i)\bRead-Host\b|\bGet-Credential\b|\bOut-GridView\b|\bPromptForChoice\b|\.UI\.Prompt\b|\[Console\]::(ReadLine|ReadKey|In)\b|^\s*pause\s*$' },
    @{ Id = 'http-without-timeout'
       Message = 'Invoke-WebRequest/Invoke-RestMethod default to no timeout in PowerShell 7. Add -TimeoutSec.'
       Pattern = '(?i)\bInvoke-(WebRequest|RestMethod)\b'
       Absent = '(?i)-TimeoutSec\b|\bTimeoutSec\s*=' },
    @{ Id = 'unbounded-wait'
       Message = 'Waits for a process or job with no timeout. Pass a timeout, or kill the process first.'
       Pattern = '(?i)\.WaitForExit\(\s*\)|\bWait-Process\b|\bWait-Job\b|\bStart-Process\b[^|;]*\s-Wait\b'
       Absent = '(?i)-Timeout\b' },
    @{ Id = 'editor-opening-git'
       Message = 'git commit/merge/tag without a message flag opens an editor. Pass -m/-F/--no-edit.'
       Pattern = '(?i)\bgit(\.exe)?\s+(-C\s+\S+\s+)?(commit|merge|tag)(?![-\w])'
       Absent = '(?i)\s(-m|-F|--message|--file|--no-edit|-a\s+-m)\b|--ff-only|--abort|--quit|\s-d\b|--delete|\s-l\b|--list' },
    @{ Id = 'ssh-without-batchmode'
       Message = 'ssh/scp can stop at a password or host-key prompt. Pass -o BatchMode=yes (and ConnectTimeout).'
       Pattern = '(?i)(^|[&;|(]\s*|\s)(ssh|scp)(\.exe)?\s+-'
       Absent = '(?i)BatchMode=yes' }
)

function Get-HangLintFindings {
    <# .SYNOPSIS Returns one object per rule violation in the given PowerShell source text. #>
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Text, [string]$Name = 'input')
    $findings = @()
    $inBlockComment = $false
    $lineNumber = 0
    foreach ($line in ($Text -split "\r?\n")) {
        $lineNumber++
        $code = $line
        if ($inBlockComment) {
            if ($code -match '#>') { $inBlockComment = $false }
            continue
        }
        if ($code -match '^\s*<#') {
            if ($code -notmatch '#>') { $inBlockComment = $true }
            continue
        }
        if ($code -match '^\s*#') { continue }
        $allowed = @([regex]::Matches($line, 'hang-lint:\s*allow\s+([a-z-]+)') | ForEach-Object { $_.Groups[1].Value })
        # Drop a trailing comment so words in it do not match (keeps the suppression text out too).
        $code = [regex]::Replace($code, '\s#\s.*$', '')
        foreach ($rule in $script:HangLintRules) {
            if ($allowed -contains $rule.Id) { continue }
            if ($code -notmatch $rule.Pattern) { continue }
            if ($rule.ContainsKey('Absent') -and $code -match $rule.Absent) { continue }
            # A splatted call (Invoke-RestMethod @p) takes its options from a hashtable built elsewhere.
            if ($rule.ContainsKey('Absent') -and $code -match '\s@\w+' -and $Text -match $rule.Absent) { continue }
            $findings += [pscustomobject]@{ File = $Name; Line = $lineNumber; Rule = $rule.Id; Message = $rule.Message; Text = $line.Trim() }
        }
    }
    $findings
}

function Get-WorkflowDeadlineFindings {
    <# .SYNOPSIS Every command step in a workflow YAML needs an explicit 1-3600 second deadline. #>
    param([Parameter(Mandatory)][string]$Text, [string]$Name = 'workflow')
    $findings = @()
    $lines = $Text -split "\r?\n"
    $stepId = ''
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match '^  - id:\s*(\S+)') { $stepId = $Matches[1] }
        if ($lines[$i] -notmatch '^    command:') { continue }
        $deadline = $null
        for ($j = $i + 1; $j -lt $lines.Count -and $lines[$j] -match '^    \S|^      '; $j++) {
            if ($lines[$j] -match '^    timeoutSeconds:\s*(\d+)\s*$') { $deadline = [int]$Matches[1]; break }
        }
        if ($null -eq $deadline) {
            $findings += [pscustomobject]@{ File = $Name; Line = $i + 1; Rule = 'step-without-deadline'; Message = "command step '$stepId' has no timeoutSeconds"; Text = $lines[$i].Trim() }
        } elseif ($deadline -lt 1 -or $deadline -gt 3600) {
            $findings += [pscustomobject]@{ File = $Name; Line = $i + 1; Rule = 'step-deadline-range'; Message = "command step '$stepId' timeoutSeconds must be 1-3600 (found $deadline)"; Text = $lines[$i].Trim() }
        }
    }
    $findings
}
