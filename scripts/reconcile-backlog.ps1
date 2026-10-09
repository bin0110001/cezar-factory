[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$InputPath,
    [string]$OutputPath = '.factory/backlog-reconciliation.json',
    [ValidateRange(1,100)][int]$BatchCap = 1,
    [ValidateRange(1,100)][int]$ProjectConcurrencyCap = 1,
    [switch]$DryRun,
    [switch]$Dispatch,
    [string]$LeaseOwner = $env:FACTORY_LEASE_OWNER,
    [string]$GhCommand = 'gh'
)

$ErrorActionPreference = 'Stop'
$backlog = Get-Content -Raw $InputPath | ConvertFrom-Json
$now = [DateTimeOffset]::UtcNow
$actions = @(); $invalid = @(); $excluded = @()
$stateLabels = @('factory:new', 'factory:needs-plan', 'factory:needs-help', 'factory:ready', 'factory:working', 'factory:review', 'factory:changes-requested', 'factory:human-review', 'factory:blocked', 'factory:done', 'factory:investigate')
$actionForState = @{ 'factory:needs-plan' = 'plan'; 'factory:ready' = 'implement'; 'factory:review' = 'review'; 'factory:changes-requested' = 'fix-review'; 'factory:investigate' = 'investigate' }
if ($Dispatch -and -not $LeaseOwner) { throw '-Dispatch requires an explicit -LeaseOwner or FACTORY_LEASE_OWNER.' }
foreach ($issue in $backlog.issues) {
    $states = @($issue.labels | Where-Object { $stateLabels -contains $_ })
    if ($states.Count -ne 1) { $invalid += [ordered]@{ issue = $issue.number; reason = 'invalid-factory-state'; states = $states }; continue }
    $lease = $issue.lease
    $activeLease = $lease -and $lease.expiresAt -and ([DateTimeOffset]::Parse($lease.expiresAt) -gt $now)
    if ($issue.blocked -or $issue.openHumanGate -or $activeLease) {
        $excluded += [ordered]@{ issue = $issue.number; reason = if ($activeLease) { 'active-lease' } elseif ($issue.openHumanGate) { 'human-gate' } else { 'blocked' } }
        continue
    }
    $action = $actionForState[$states[0]]
    if (-not $action) { $excluded += [ordered]@{ issue = $issue.number; reason = 'no-legal-action' }; continue }
    $actions += [pscustomobject]@{ issue = [int]$issue.number; action = $action; priority = [int]($issue.priority ?? 0); dependenciesReady = [bool]$issue.dependenciesReady; createdAt = [DateTimeOffset]::Parse($issue.createdAt); state = $states[0] }
}
# Priority is descending; dependency-ready issues precede non-ready issues; ties use oldest issue first.
$ordered = @($actions | Sort-Object @{Expression='priority';Descending=$true}, @{Expression='dependenciesReady';Descending=$true}, @{Expression='createdAt';Descending=$false}, @{Expression='issue';Descending=$false})
$selected = @($ordered | Select-Object -First ([Math]::Min($BatchCap, $ProjectConcurrencyCap)))
$dispatches = @()
if ($Dispatch -and -not $DryRun) {
    foreach ($action in $selected) {
        & $GhCommand issue comment $action.issue --body "<!-- factory-lease:$($action.issue) -->`nlease-owner:$LeaseOwner`nlease-expires:$($now.AddMinutes(30).ToString('o'))" | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Could not claim issue #$($action.issue) before dispatch." }
        $dispatches += [ordered]@{ issue = $action.issue; action = $action.action; leaseOwner = $LeaseOwner; status = 'leased-awaiting-dispatch' }
    }
}
$result = [ordered]@{ generatedAt = $now.ToString('o'); mode = if ($Dispatch) { if ($DryRun) { 'dispatch-dry-run' } else { 'dispatch' } } elseif ($DryRun) { 'dry-run' } else { 'read-only' }; batchCap = $BatchCap; projectConcurrencyCap = $ProjectConcurrencyCap; invalidIssues = $invalid; excludedIssues = $excluded; actions = $selected; dispatches = $dispatches; terminalReason = if ($selected.Count) { 'candidates-found' } else { 'no-candidates' } }
$directory = Split-Path -Parent $OutputPath; if ($directory) { New-Item -ItemType Directory -Force -Path $directory | Out-Null }
$result | ConvertTo-Json -Depth 8 | Set-Content -NoNewline $OutputPath
$result | ConvertTo-Json -Depth 8
