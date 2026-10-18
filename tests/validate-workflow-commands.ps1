[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$InputPath,
    [Parameter(Mandatory)][string]$FactoryRoot
)

$ErrorActionPreference = 'Stop'
$workflows = Get-Content -Raw -LiteralPath $InputPath | ConvertFrom-Json
$failures = [System.Collections.Generic.List[string]]::new()

function Add-Failure([string]$Message) { $failures.Add($Message) }

foreach ($workflow in $workflows) {
    $startupRequired = @()
    foreach ($step in $workflow.steps) {
        if (-not $step.command) { continue }

        $tokens = $null
        $parseErrors = $null
        $ast = [System.Management.Automation.Language.Parser]::ParseInput(
            [string]$step.command, [ref]$tokens, [ref]$parseErrors)
        if ($parseErrors.Count -gt 0) {
            Add-Failure "$($workflow.file)/$($step.id): unsupported PowerShell syntax: $($parseErrors[0].Message)"
            continue
        }

        $commands = @($ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.CommandAst] }, $true))
        $topCommands = @($ast.EndBlock.Statements | Where-Object { $_ -is [System.Management.Automation.Language.PipelineAst] } |
            ForEach-Object { $_.PipelineElements } | Where-Object { $_ -is [System.Management.Automation.Language.CommandAst] })
        if ($commands.Count -ne 1 -or $topCommands.Count -ne 1) {
            Add-Failure "$($workflow.file)/$($step.id): unsupported Factory command form; expected one direct pwsh command"
            continue
        }

        $commandAst = $topCommands[0]
        if ($commandAst.GetCommandName() -notin @('pwsh', 'powershell')) {
            Add-Failure "$($workflow.file)/$($step.id): unsupported Factory command executable '$($commandAst.GetCommandName())'"
            continue
        }
        $elements = @($commandAst.CommandElements | ForEach-Object { $_.Extent.Text })
        $fileIndex = [Array]::FindIndex($elements, [Predicate[string]]{ param($item) $item -eq '-File' })
        if ($fileIndex -lt 0 -or $fileIndex + 1 -ge $elements.Count) {
            Add-Failure "$($workflow.file)/$($step.id): unsupported PowerShell command form; expected -File <Factory script>"
            continue
        }
        $scriptArgument = $elements[$fileIndex + 1].Trim('"', "'")
        if ($scriptArgument -notmatch '\$FACTORY_RUNTIME_ROOT[/\\]scripts[/\\](.+\.ps1)$') {
            Add-Failure "$($workflow.file)/$($step.id): unsupported script path '$scriptArgument'; expected `$FACTORY_RUNTIME_ROOT/scripts/<path>.ps1"
            continue
        }
        $relativeScript = $Matches[1] -replace '[\\]', '/'
        $scriptPath = Join-Path $FactoryRoot (Join-Path 'scripts' ($relativeScript -replace '/', [IO.Path]::DirectorySeparatorChar))
        if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) {
            Add-Failure "$($workflow.file)/$($step.id): missing script scripts/$relativeScript"
            continue
        }

        $scriptTokens = $null
        $scriptErrors = $null
        $scriptAst = [System.Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$scriptTokens, [ref]$scriptErrors)
        if ($scriptErrors.Count -gt 0) {
            Add-Failure "$($workflow.file)/$($step.id): target script has parse errors: scripts/$relativeScript"
            continue
        }
        $declared = @()
        if ($scriptAst.ParamBlock) {
            $declared = @($scriptAst.ParamBlock.Parameters | ForEach-Object { $_.Name.VariablePath.UserPath })
        }
        $common = @('Verbose','Debug','ErrorAction','WarningAction','InformationAction','ProgressAction','ErrorVariable','WarningVariable','InformationVariable','OutVariable','OutBuffer','PipelineVariable','WhatIf','Confirm')
        $args = @()
        if ($fileIndex + 2 -lt $elements.Count) { $args = @($elements[($fileIndex + 2)..($elements.Count - 1)]) }
        foreach ($arg in $args) {
            if ($arg -match '^-([A-Za-z][A-Za-z0-9_-]*)(?::|$)') {
                $parameter = $Matches[1]
                if ($parameter -notin $declared -and $parameter -notin $common) {
                    Add-Failure "$($workflow.file)/$($step.id): unknown parameter -$parameter for scripts/$relativeScript"
                }
            }
        }

        if ($relativeScript -eq 'factory-startup.ps1') {
            $requiredArg = [Array]::FindIndex($elements, [Predicate[string]]{ param($item) $item -eq '-RequiredScripts' })
            if ($requiredArg -lt 0 -or $requiredArg + 1 -ge $elements.Count) {
                Add-Failure "$($workflow.file)/$($step.id): startup preflight is missing -RequiredScripts"
            } else {
                $startupRequired = @($elements[$requiredArg + 1].Trim('"', "'") -split ',' | Where-Object { $_ })
            }
        }
    }

    $calledScripts = @($workflow.steps | Where-Object { $_.command } | ForEach-Object {
        if ($_.command -match '\$FACTORY_RUNTIME_ROOT[/\\]scripts[/\\](.+?\.ps1)(?:\s|$)') { $Matches[1] -replace '[\\]', '/' }
    } | Where-Object { $_ -and $_ -ne 'factory-startup.ps1' } | Sort-Object -Unique)
    foreach ($script in $calledScripts) {
        if ($script -notin $startupRequired) { Add-Failure "$($workflow.file): startup preflight does not cover scripts/$script" }
    }
    Write-Output "  ok   $($workflow.file): workflow commands, parameters and startup coverage"
}

if ($failures.Count) {
    foreach ($failure in $failures) { [Console]::Error.WriteLine("FAIL $failure") }
    exit 1
}
