# Shared by scripts/lib.ps1 (changed-test selection) and scripts/factory/protect-governance.ps1. Dot-source it.
# Deliberately sets no strict mode or preference of its own.

function Get-FactoryEffectiveBase {
    # The commit an implementation's own changes are measured from.
    #
    # The prepared handoff records the base the run started from. The agent is required to merge the current origin/dev
    # into its branch before handing over (AGENTS.md), and anything merged to dev since the run started then shows up
    # in `base..HEAD` as if the agent had written it: fixture issue #528, a docs-only change, was refused by the
    # governance guard for two "added" files that another run's merged feature had brought in (STABILIZATION-PLAN.md
    # item 3.3). So when the branch has merged the real remote's dev, measure from where that merge joined it.
    #
    # The remote is fetched; the local `origin/dev` ref is not trusted, because the branch's own agent could point it at
    # HEAD and hide its changes. The base only ever moves forward, from the recorded base to a commit that descends from
    # it. Any failure (no remote, no network, no credential) leaves the recorded base untouched, which can only make
    # the guard stricter.
    param([Parameter(Mandatory)][string]$Root, [Parameter(Mandatory)][string]$Base, [string[]]$Branches = @('dev', 'stable'))
    $sha = '^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$'
    if ($Base -notmatch $sha) { return $Base }
    $previousPrompt = $env:GIT_TERMINAL_PROMPT; $env:GIT_TERMINAL_PROMPT = '0'
    try {
        foreach ($branch in $Branches) {
            $null = & git -C $Root fetch --quiet origin $branch 2>$null
            if ($LASTEXITCODE -ne 0) { continue }
            $tip = ((& git -C $Root rev-parse --verify 'FETCH_HEAD^{commit}' 2>$null) -join '').Trim()
            if ($LASTEXITCODE -ne 0 -or $tip -notmatch $sha) { continue }
            $joined = ((& git -C $Root merge-base HEAD $tip 2>$null) -join '').Trim()
            if ($LASTEXITCODE -ne 0 -or $joined -notmatch $sha) { continue }
            $null = & git -C $Root merge-base --is-ancestor $Base $joined 2>$null
            if ($LASTEXITCODE -eq 0) { return $joined }
        }
    }
    catch { }
    finally { if ($null -eq $previousPrompt) { Remove-Item Env:GIT_TERMINAL_PROMPT -ErrorAction SilentlyContinue } else { $env:GIT_TERMINAL_PROMPT = $previousPrompt } }
    $Base
}
