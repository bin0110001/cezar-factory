#!/usr/bin/env pwsh
<##
.SYNOPSIS
Computes the per-issue-class go/no-go for documentation-assisted coding from a JSONL run file.

.DESCRIPTION
Reads policies/docs-evaluation.json (pre-registered thresholds) and one JSON object per line:
issueClass, arm, generationTokens, retrievalTokens, reviewTokens, maintenanceTokens, accepted (bool),
claimsChecked, claimsIncorrect, sourceSha, workflowMode. Net cost is the sum of all four token
components, so documentation upkeep and review are counted, not retrieval alone. Each non-baseline arm
is compared with the baseline per class; a seeded bootstrap gives the confidence interval of the
relative net-token reduction. Writes one JSON report to the success stream. Runs on the local host only.
##>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$RunsPath,
    [string]$PolicyPath
)
$ErrorActionPreference = 'Stop'
if (-not $PolicyPath) { $PolicyPath = Join-Path $PSScriptRoot '../policies/docs-evaluation.json' }
$policy = Get-Content -Raw -LiteralPath $PolicyPath | ConvertFrom-Json
$runs = @(Get-Content -LiteralPath $RunsPath | Where-Object { $_.Trim() } | ForEach-Object { $_ | ConvertFrom-Json })
foreach ($r in $runs) {
    if (-not $r.sourceSha) { throw "run without sourceSha: provenance is required" }
    if ($policy.issueClasses -notcontains $r.issueClass) { throw "unknown issueClass '$($r.issueClass)'" }
    if ($policy.arms -notcontains $r.arm) { throw "unknown arm '$($r.arm)'" }
}
function Net($r) { [double]($r.generationTokens + $r.retrievalTokens + $r.reviewTokens + $r.maintenanceTokens) }
function Mean($xs) { if ($xs.Count -eq 0) { return 0.0 }; ($xs | Measure-Object -Average).Average }
function Reduction($base, $arm) { $b = Mean $base; if ($b -le 0) { return 0.0 }; ($b - (Mean $arm)) / $b }

$rows = @()
foreach ($class in $policy.issueClasses) {
    $base = @($runs | Where-Object { $_.issueClass -eq $class -and $_.arm -eq 'baseline' })
    foreach ($arm in ($policy.arms | Where-Object { $_ -ne 'baseline' })) {
        $test = @($runs | Where-Object { $_.issueClass -eq $class -and $_.arm -eq $arm })
        $row = [ordered]@{ issueClass = $class; arm = $arm; baselineRuns = $base.Count; armRuns = $test.Count }
        if ($base.Count -lt $policy.minRunsPerArmPerClass -or $test.Count -lt $policy.minRunsPerArmPerClass) {
            $row.decision = 'insufficient-data'; $rows += [pscustomobject]$row; continue
        }
        $bn = @($base | ForEach-Object { Net $_ }); $tn = @($test | ForEach-Object { Net $_ })
        $rng = [System.Random]::new([int]$policy.bootstrapSeed)
        $samples = New-Object 'System.Collections.Generic.List[double]'
        for ($i = 0; $i -lt $policy.bootstrapResamples; $i++) {
            $bs = @(1..$bn.Count | ForEach-Object { $bn[$rng.Next($bn.Count)] })
            $ts = @(1..$tn.Count | ForEach-Object { $tn[$rng.Next($tn.Count)] })
            $samples.Add((Reduction $bs $ts))
        }
        $sorted = $samples | Sort-Object
        $alpha = (1 - $policy.confidenceLevel) / 2
        $lo = $sorted[[int][math]::Floor($alpha * ($sorted.Count - 1))]
        $hi = $sorted[[int][math]::Ceiling((1 - $alpha) * ($sorted.Count - 1))]
        $red = Reduction $bn $tn
        $acceptedBase = Mean @($base | ForEach-Object { [double][bool]$_.accepted })
        $acceptedArm = Mean @($test | ForEach-Object { [double][bool]$_.accepted })
        $checked = ($test | Measure-Object -Property claimsChecked -Sum).Sum
        $wrong = ($test | Measure-Object -Property claimsIncorrect -Sum).Sum
        $wrongRate = if ($checked -gt 0) { $wrong / $checked } else { 0.0 }
        $t = $policy.thresholds
        $go = ($red -ge $t.minNetTokenReduction) -and ($lo -gt 0) -and (($acceptedBase - $acceptedArm) -le $t.maxAcceptedRateDrop) -and ($wrongRate -le $t.maxClaimIncorrectRate)
        $row.netTokenReduction = [math]::Round($red, 4)
        $row.ci = @([math]::Round($lo, 4), [math]::Round($hi, 4))
        $row.acceptedRateBaseline = [math]::Round($acceptedBase, 4)
        $row.acceptedRateArm = [math]::Round($acceptedArm, 4)
        $row.claimIncorrectRate = [math]::Round($wrongRate, 4)
        $row.decision = if ($go) { 'go' } else { 'no-go' }
        $rows += [pscustomobject]$row
    }
}
[ordered]@{
    policyVersion = $policy.version
    limitations   = 'Bootstrap over runs, not over issues; correctness is human or test judged, never self-graded; token cost excludes wall-clock human time.'
    results       = $rows
} | ConvertTo-Json -Depth 6 -Compress
