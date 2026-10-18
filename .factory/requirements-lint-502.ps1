<#
.SYNOPSIS
Checks requirements references, including the archived backlog after the
GitHub Issues cutover.

.DESCRIPTION
This is a lightweight, code-free consistency check over requirements/ and
the top-level docs that reference it (`CLAUDE.md`, `.agents/`). When
requirements/README.md declares the backlog retired, historical references
may resolve under Documentation/Archived Requirements and the obsolete
FEATURE_PRIORITY/status checks do not apply. A path missing from both
locations still fails. In the legacy active-backlog layout, it reports:

- a `Planned Features/`, `Completed/`, or `Reference/` markdown path
  referenced from any `.md` under `requirements/`, `CLAUDE.md`, or
  `.agents/` that does not exist on disk;
- a file named in `FEATURE_PRIORITY.md` that does not exist under
  `Planned Features/` (recursively), or a file that exists there but is
  not named anywhere in `FEATURE_PRIORITY.md` (other than the priority
  list itself, `VTT Roadmap/00-architecture-and-build-order.md`, and this
  cleanup plan's own follow-up docs, which are index/reference files, not
  work items);
- a numbered row in `FEATURE_PRIORITY.md`'s body that duplicates an
  earlier row number;
- a file directly under `requirements/Completed/` whose first `**Status`
  line contains `[WIP]` or `Proposed`;
- a file directly under `requirements/Bug Reports/` not named exactly
  `YYYY-MM-DD.md`.

This is a heuristic scan over prose, not a strict parser — false positives
are possible (e.g. a filename mentioned only as a hypothetical example).
Treat a finding as a prompt to check by hand, not an infallible verdict.

.PARAMETER ProjectRoot
Path to the repository root. If omitted, it searches upward for
project.godot the same way tools/gdscript-code-quality.ps1 does.

.PARAMETER ReportPath
Optional path to write a JSON report to, same shape as
tools/gdscript-code-quality.ps1's report.
#>

[CmdletBinding()]
param(
    [string]$ProjectRoot = $null,
    [string]$ReportPath = $null
)

$script:IssueCount = 0
$script:Issues = [System.Collections.Generic.List[object]]::new()

function Get-ProjectRoot {
    param([string]$ExplicitRoot)

    if (-not [string]::IsNullOrWhiteSpace($ExplicitRoot)) {
        $resolved = (Resolve-Path $ExplicitRoot -ErrorAction Stop).Path
        if (-not (Test-Path (Join-Path $resolved 'project.godot'))) {
            throw "No project.godot found under explicit ProjectRoot: $resolved"
        }
        return $resolved
    }

    $dir = Get-Location
    while ($null -ne $dir) {
        if (Test-Path (Join-Path $dir 'project.godot')) {
            return $dir.Path
        }
        $parent = Split-Path $dir -Parent
        if ([string]::IsNullOrWhiteSpace($parent) -or $parent -eq $dir) {
            break
        }
        $dir = $parent
    }

    throw 'Could not find project.godot by searching upward from the current directory. Pass -ProjectRoot explicitly.'
}

function Write-Issue {
    param(
        [string]$File,
        [int]$Line = 1,
        [string]$Kind,
        [string]$Message
    )

    $location = $File + '(' + $Line + ')'
    # NOTE: no -ForegroundColor on issue lines — matches gdscript-code-quality.ps1's
    # convention, since ANSI codes can break a remote agent's stdout parser.
    $script:IssueCount += 1
    $script:Issues.Add(@{ kind = $Kind; file = $File; line = $Line; message = $Message })
    Write-Host ("[requirements-lint] {0}: {1} - {2}" -f $Kind, $location, $Message)
}

function Invoke-RequirementsLint {
    param([string]$Root)

    $reqRoot = Join-Path $Root 'requirements'
    if (-not (Test-Path $reqRoot)) {
        throw "No requirements/ folder found under $Root"
    }

    $plannedRoot = Join-Path $reqRoot 'Planned Features'
    $completedRoot = Join-Path $reqRoot 'Completed'
    $bugRoot = Join-Path $reqRoot 'Bug Reports'
    $priorityFile = Join-Path $plannedRoot 'FEATURE_PRIORITY.md'
    $archiveRoot = Join-Path $Root 'Documentation/Archived Requirements'
    $requirementsReadme = Join-Path $reqRoot 'README.md'
    $isRetired = (Test-Path -LiteralPath $requirementsReadme) -and
        ((Get-Content -LiteralPath $requirementsReadme -Raw) -match '(?m)^# Retired Requirements\s*$')
    if ($isRetired -and -not (Test-Path -LiteralPath $archiveRoot)) {
        Write-Issue -File $archiveRoot -Kind 'MissingRequirementsArchive' -Message 'retired backlog archive is missing'
    }

    # ---- 1. Path-reference check ---------------------------------------
    # Scan every .md under requirements/, plus CLAUDE.md and .agents/, for
    # a "Planned Features/...", "Completed/...", or "Reference/..." path
    # ending in .md, and confirm it resolves relative to requirements/.
    $scanTargets = @()
    $scanTargets += Get-ChildItem -Path $reqRoot -Filter '*.md' -Recurse -File
    $claudeMd = Join-Path $Root 'CLAUDE.md'
    if (Test-Path $claudeMd) { $scanTargets += Get-Item $claudeMd }
    $agentsDir = Join-Path $Root '.agents'
    if (Test-Path $agentsDir) {
        $scanTargets += Get-ChildItem -Path $agentsDir -Filter '*.md' -Recurse -File
    }

    # Matches e.g. `Planned Features/Foo.md`, `Completed/VTT Roadmap/Bar.md`,
    # `requirements/Reference/Baz.md`. Deliberately conservative: only
    # flags the three known backlog-folder names as anchors.
    $pathPattern = '(?:requirements[\\/])?(Planned Features|Completed|Reference)[\\/][^`\r\n\]]*?\.md'

    foreach ($target in $scanTargets) {
        $lines = Get-Content -LiteralPath $target.FullName
        for ($i = 0; $i -lt $lines.Count; $i++) {
            # Skip `git mv "old name.md" ...`-style illustrative command
            # examples — these show filename *syntax*, not a real reference.
            if ($lines[$i] -match 'git mv') { continue }

            $lineMatches = [regex]::Matches($lines[$i], $pathPattern)
            foreach ($m in $lineMatches) {
                $relPath = $m.Value -replace '^requirements[\\/]', ''
                $candidate = Join-Path $reqRoot $relPath
                $archived = Join-Path $archiveRoot $relPath
                if (-not (Test-Path -LiteralPath $candidate) -and
                    -not ($isRetired -and (Test-Path -LiteralPath $archived))) {
                    Write-Issue -File $target.FullName -Line ($i + 1) -Kind 'DanglingRequirementsPath' `
                        -Message "referenced path does not exist: $relPath"
                }
            }
        }
    }

    # ---- 2. FEATURE_PRIORITY.md consistency -----------------------------
    if (-not $isRetired -and -not (Test-Path $priorityFile)) {
        Write-Issue -File $priorityFile -Kind 'MissingFeaturePriority' -Message 'FEATURE_PRIORITY.md is missing'
    } elseif (-not $isRetired) {
        $priorityText = Get-Content -LiteralPath $priorityFile -Raw
        $priorityLines = Get-Content -LiteralPath $priorityFile

        # Duplicate row numbers: a line starting with "N. " where N repeats.
        $seenNumbers = @{}
        for ($i = 0; $i -lt $priorityLines.Count; $i++) {
            if ($priorityLines[$i] -match '^(\d+)\.\s') {
                $num = $matches[1]
                if ($seenNumbers.ContainsKey($num)) {
                    Write-Issue -File $priorityFile -Line ($i + 1) -Kind 'DuplicatePriorityRow' `
                        -Message "row number $num already used at line $($seenNumbers[$num] + 1)"
                } else {
                    $seenNumbers[$num] = $i
                }
            }
        }

        # Files that exist under Planned Features/ (recursively) but are never
        # named in FEATURE_PRIORITY.md's body. Index/reference files are
        # exempt since they're not work items.
        $exemptNames = @(
            'FEATURE_PRIORITY.md',
            '00-architecture-and-build-order.md',
            'Requirements Backlog Cleanup.md'
        )
        $plannedFiles = Get-ChildItem -Path $plannedRoot -Filter '*.md' -Recurse -File
        foreach ($f in $plannedFiles) {
            if ($exemptNames -contains $f.Name) { continue }
            $bareName = $f.Name -replace '^\[WIP\] ', ''
            $escapedFull = [regex]::Escape($f.Name)
            $escapedBare = [regex]::Escape($bareName)
            $matched = ($priorityText -match $escapedFull) -or ($priorityText -match $escapedBare)

            # VTT Roadmap section files (e.g. "02-rules-aware-automation.md",
            # "[WIP] 04-content-pipeline.md") are conventionally referenced
            # by their numeric prefix as a [VTT-NN] tag rather than by
            # filename — accept that form too.
            if (-not $matched -and $bareName -match '^(\d{2})-') {
                $sectionNum = $matches[1]
                if ($priorityText -match [regex]::Escape("[VTT-$sectionNum]")) {
                    $matched = $true
                }
            }

            if (-not $matched) {
                Write-Issue -File $f.FullName -Kind 'UnlistedPlannedFeature' `
                    -Message "not referenced anywhere in FEATURE_PRIORITY.md"
            }
        }
    }

    # ---- 3. Completed/ status-header check ------------------------------
    if (-not $isRetired -and (Test-Path $completedRoot)) {
        $completedFiles = Get-ChildItem -Path $completedRoot -Filter '*.md' -File
        foreach ($f in $completedFiles) {
            $statusLine = (Get-Content -LiteralPath $f.FullName | Select-String -Pattern '^\*\*Status' | Select-Object -First 1)
            if ($null -ne $statusLine -and ($statusLine.Line -match '\[WIP\]' -or $statusLine.Line -match '\bProposed\b')) {
                Write-Issue -File $f.FullName -Line $statusLine.LineNumber -Kind 'IncompleteInCompleted' `
                    -Message "file is under Completed/ but its Status line says $($statusLine.Line.Trim())"
            }
        }
    }

    # ---- 4. Bug Reports/ filename check ---------------------------------
    if (-not $isRetired -and (Test-Path $bugRoot)) {
        $bugFiles = Get-ChildItem -Path $bugRoot -Filter '*.md' -File
        foreach ($f in $bugFiles) {
            if ($f.Name -notmatch '^\d{4}-\d{2}-\d{2}\.md$') {
                Write-Issue -File $f.FullName -Kind 'MisnamedBugReport' `
                    -Message "expected a bare YYYY-MM-DD.md filename"
            }
        }
    }

    if (-not [string]::IsNullOrWhiteSpace($script:ReportPath)) {
        $reportDir = Split-Path $script:ReportPath -Parent
        if ($reportDir -and -not (Test-Path -LiteralPath $reportDir)) {
            New-Item -ItemType Directory -Force -Path $reportDir | Out-Null
        }
        @{
            schemaVersion = 1
            totalIssues   = $script:IssueCount
            issues        = $script:Issues
        } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $script:ReportPath -Encoding UTF8
        Write-Host "[requirements-lint] Report written to $script:ReportPath"
    }

    if ($script:IssueCount -gt 0) {
        throw "Found $script:IssueCount issue(s)."
    }

    Write-Host '[requirements-lint] Completed checks.' -ForegroundColor Green
}

try {
    $root = Get-ProjectRoot -ExplicitRoot $ProjectRoot
    $script:ReportPath = $ReportPath
    Invoke-RequirementsLint -Root $root
} catch {
    Write-Error "[requirements-lint] $_"
    exit 1
}
