[CmdletBinding()]
param([string]$Path = (Join-Path $PSScriptRoot '..\routing\automation-catalog.json'))

$ErrorActionPreference = 'Stop'
$catalog = Get-Content -Raw $Path | ConvertFrom-Json
$profiles = $catalog.automationProfiles
if (-not $profiles) { throw 'Catalog must define automationProfiles.' }
foreach ($profile in $profiles.PSObject.Properties) {
    if ($profile.Value.runner -notin @('claude', 'codex', 'opencode')) { throw "Automation profile '$($profile.Name)' has an invalid runner." }
    if (-not $profile.Value.model) { throw "Automation profile '$($profile.Name)' has no model." }
}
$required = 'id','purpose','inputs','maxContextChars','tier','workers','fallback','verifier','retryBudget','timeoutSeconds','terminal','persistenceAuthority','approval','artifact','observability'
$ids = @{}
foreach ($job in $catalog.jobs) {
    foreach ($field in $required) { if ($null -eq $job.$field) { throw "Catalog job '$($job.id)' is missing '$field'." } }
    if ($ids.ContainsKey($job.id)) { throw "Catalog job id '$($job.id)' is duplicated." }; $ids[$job.id] = $true
    if ($job.maxContextChars -lt 0 -or $job.maxContextChars -gt 12000) { throw "Catalog job '$($job.id)' has an invalid context limit." }
    if ($job.retryBudget -lt 0 -or $job.retryBudget -gt 3) { throw "Catalog job '$($job.id)' has an invalid retry budget." }
    if ($job.tier -notin @('tool','local','premium','human')) { throw "Catalog job '$($job.id)' has an invalid tier." }
    if (-not $job.artifact.StartsWith('.factory/')) { throw "Catalog job '$($job.id)' artifact must be under .factory/." }
    if ($job.tier -eq 'local') {
        if (-not $job.promotion -or $job.promotion.sampleSize -lt 1 -or $job.promotion.schemaValidRate -lt 0 -or $job.promotion.schemaValidRate -gt 1 -or $job.promotion.verifiedSuccessRate -lt 0 -or $job.promotion.verifiedSuccessRate -gt 1) { throw "Catalog local job '$($job.id)' needs valid predeclared promotion gates." }
    }
}
$localPath = Join-Path $PSScriptRoot '..\routing\local-jobs.yaml'
$local = Get-Content -Raw $localPath
$localJobIds = @([regex]::Matches($local, '(?m)^  ([a-z][a-z0-9-]+):\s*$') | ForEach-Object { $_.Groups[1].Value })
$catalogLocalJobIds = @($catalog.jobs | Where-Object { $_.tier -eq 'local' } | ForEach-Object { @($_.localJobs) })
if (@($localJobIds | Where-Object { $_ -notin $catalogLocalJobIds }).Count) { throw "Local routing has unmapped jobs: $(@($localJobIds | Where-Object { $_ -notin $catalogLocalJobIds }) -join ', ')." }
if (@($catalogLocalJobIds | Where-Object { $_ -notin $localJobIds }).Count) { throw "Catalog maps jobs absent from local routing: $(@($catalogLocalJobIds | Where-Object { $_ -notin $localJobIds }) -join ', ')." }
$default = Get-Content -Raw (Join-Path $PSScriptRoot '..\routing\default.yaml')
if ($default -notmatch 'worker: local' -or $default -notmatch 'preferred: codex' -or $default -notmatch 'preferred: claude') { throw 'Default routing is inconsistent with catalog local and premium worker classes.' }
$automationDir = Join-Path $PSScriptRoot '..\automations'
foreach ($file in Get-ChildItem $automationDir -Filter *.json) {
    $automation = Get-Content -Raw $file.FullName | ConvertFrom-Json
    $workflow = [string]$automation.task.workflow
    $profile = $profiles.$workflow
    if (-not $profile) { throw "Automation '$($file.Name)' workflow '$workflow' has no catalog automation profile." }
    if ($automation.task.runner -ne $profile.runner -or $automation.task.model -ne $profile.model) { throw "Automation '$($file.Name)' must use $($profile.runner)/$($profile.model) from the catalog profile for '$workflow'." }
}
Write-Host "Automation catalog valid: $($catalog.jobs.Count) jobs"
