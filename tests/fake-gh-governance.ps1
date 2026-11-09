# Fake `gh` for tests/protect-governance.ps1. $env:FAKE_GOV_STATE names JSON: { head, author, actor, reviews: [...] }.
$s = Get-Content -Raw $env:FAKE_GOV_STATE | ConvertFrom-Json -AsHashtable
$a = @($args)
if ($a[0] -eq 'api' -and $a[1] -eq 'user') { $s.actor; exit 0 }
if ($a[0] -eq 'api' -and $a[1] -match '/pulls/\d+/reviews$') { ConvertTo-Json -InputObject @($s.reviews) -Depth 6 -Compress; exit 0 }
if ($a[0] -eq 'api' -and $a[1] -match '/pulls/\d+$') { @{ head = @{ sha = $s.head }; user = @{ login = $s.author } } | ConvertTo-Json -Depth 4 -Compress; exit 0 }
Write-Error "fake gh: unexpected: $($a -join ' ')"; exit 2
