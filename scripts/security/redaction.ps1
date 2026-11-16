# Shared collection-boundary secret redaction (#579). Reads the same redaction-patterns.json as redaction.py.
$script:FactoryRedactionData = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'redaction-patterns.json') | ConvertFrom-Json

function Invoke-FactoryRedact {
    param([string]$Text, [hashtable]$Env, [switch]$Strict, [string]$Marker)
    if ($null -eq $Text) { return '' }
    $data = $script:FactoryRedactionData
    $m = if ($Marker) { $Marker } else { $data.marker }
    $sentinel = [string][char]0 + 'M' + [char]0
    $pairs = if ($Env) { $Env.GetEnumerator() | ForEach-Object { [pscustomobject]@{ Name = [string]$_.Key; Value = [string]$_.Value } } }
             else { Get-ChildItem Env: | ForEach-Object { [pscustomobject]@{ Name = $_.Name; Value = [string]$_.Value } } }
    $values = $pairs | Where-Object { $_.Name -match $data.envNamePattern -and $_.Value.Length -ge $data.envMinLength } |
        ForEach-Object { $_.Value } | Sort-Object -Unique { $_.Length } -Descending
    $out = $Text
    foreach ($v in $values) { $out = $out.Replace($v, $sentinel) }
    $rules = @($data.rules); if ($Strict) { $rules += @($data.strictRules) }
    foreach ($r in $rules) { $out = [regex]::Replace($out, $r.pattern, $r.replacement.Replace($data.marker, $sentinel)) }
    return $out.Replace($sentinel, $m)
}
