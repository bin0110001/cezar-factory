# Spec-first change contract rules (#178), read from policies/change-contract.json. Dot-source this file.
# Pure functions: they decide the path, staleness and convergence from evidence. They schedule nothing and
# set no lifecycle state; Cezar and route-state.ps1 own both.

function Get-ChangeContractPolicy {
    param([string]$Path = (Join-Path $PSScriptRoot '../policies/change-contract.json'))
    $policy = Get-Content -Raw $Path | ConvertFrom-Json
    if ($policy.schemaVersion -ne 1) { throw "unsupported change-contract schemaVersion $($policy.schemaVersion)" }
    $policy
}

function Select-ChangePath {
    # Returns 'spec-first' or 'code-first' with the reasons. Routine work is code-first unless the policy's
    # contract evidence says otherwise; risk level alone never adds a gate beyond the policy's labels.
    param($Policy, [string[]]$Labels = @(), [string[]]$ContractKinds = @(), [string[]]$Modules = @(), [bool]$TouchesProtectedAsset = $false)
    $reasons = @()
    $hit = @($ContractKinds | Where-Object { $_ -in $Policy.specFirst.contractKinds })
    if ($hit.Count) { $reasons += "contract kinds: $($hit -join ', ')" }
    if ($TouchesProtectedAsset -and $Policy.specFirst.protectedAssets) { $reasons += 'protected asset' }
    if (@($Modules | Select-Object -Unique).Count -ge $Policy.specFirst.minModules) { $reasons += "modules >= $($Policy.specFirst.minModules)" }
    $isCodeFirstType = @($Labels | Where-Object { $_ -in $Policy.codeFirst.types }).Count -gt 0
    $labelHit = @($Labels | Where-Object { $_ -in $Policy.specFirst.labels })
    if ($labelHit.Count -and -not $isCodeFirstType) { $reasons += "label: $($labelHit -join ', ')" }
    [pscustomobject]@{ Path = $(if ($reasons.Count) { 'spec-first' } else { 'code-first' }); Reasons = $reasons }
}

function Test-ChangeContractStale {
    # Stale when the approval pins no SHA, or the target branch changed a path the contract covers since then.
    # ChangedSinceApproval is the list of paths changed on the target branch after ApprovedSha (the caller
    # reads it from git); an unknown list counts as stale rather than fresh.
    param([string]$ApprovedSha, [string]$CurrentSha, [string[]]$ContractPaths = @(), $ChangedSinceApproval = $null)
    if (-not $ApprovedSha) { return [pscustomobject]@{ Stale = $true; Reason = 'no approved SHA' } }
    if ($ApprovedSha -eq $CurrentSha) { return [pscustomobject]@{ Stale = $false; Reason = 'base unchanged' } }
    if ($null -eq $ChangedSinceApproval) { return [pscustomobject]@{ Stale = $true; Reason = 'base moved and changed paths unknown' } }
    $norm = { param($p) ($p -replace '\\', '/' -replace '^\./', '').ToLowerInvariant() }
    $mine = @($ContractPaths | ForEach-Object { & $norm $_ })
    $overlap = @($ChangedSinceApproval | Where-Object { (& $norm $_) -in $mine })
    if ($overlap.Count) { return [pscustomobject]@{ Stale = $true; Reason = "base changed contract paths: $($overlap -join ', ')" } }
    [pscustomobject]@{ Stale = $false; Reason = 'base moved without touching contract paths' }
}

function Test-ReplanAllowed {
    param($Policy, [int]$Replans)
    $Replans -lt $Policy.replan.maxReplans
}

function Compare-ChangeContract {
    # Contract items: @{ id; paths } ; Evidence: @{ id; kind ('tests'|'acceptance'); passed } ; ChangedPaths: what
    # the implementation touched. A contract item is verified only when every required evidence kind has a
    # passing record for it. Changed paths outside every item's paths are reported as unplanned. The result is
    # bounded by maxDiscrepancies; each discrepancy is a follow-up task title, never a verified label.
    param($Policy, $Items, $Evidence = @(), [string[]]$ChangedPaths = @())
    $disc = @()
    foreach ($item in $Items) {
        foreach ($kind in $Policy.convergence.requiredEvidence) {
            $ok = @($Evidence | Where-Object { $_.id -eq $item.id -and $_.kind -eq $kind -and $_.passed -eq $true }).Count -gt 0
            if (-not $ok) { $disc += [pscustomobject]@{ Id = $item.id; Kind = 'missing-evidence'; Task = "Provide passing $kind evidence for contract item $($item.id)" } }
        }
    }
    $planned = @($Items | ForEach-Object { $_.paths } | ForEach-Object { ($_ -replace '\\', '/').ToLowerInvariant() })
    foreach ($p in $ChangedPaths) {
        if (($p -replace '\\', '/').ToLowerInvariant() -notin $planned) {
            $disc += [pscustomobject]@{ Id = $null; Kind = 'unplanned-change'; Task = "Explain or add to the contract: changed path $p" }
        }
    }
    $total = $disc.Count
    $shown = @($disc | Select-Object -First $Policy.convergence.maxDiscrepancies)
    [pscustomobject]@{ Verified = ($total -eq 0 -and @($Items).Count -gt 0); Discrepancies = $shown; Truncated = ($total - $shown.Count) }
}
