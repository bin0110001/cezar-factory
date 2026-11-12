# Static contract between the Factory's scripts and the workflows that run them.
#
# Dot-source this file, then call Get-ScriptParseProblems and Get-WorkflowContractProblems. Each
# returns a list of human-readable problems; an empty list means the contract holds. Nothing here
# executes a Factory script, so the checks are fast and identical on Windows and Linux.
#
# Why it exists: a workflow `command:` step is the only caller of most scripts, and it runs for the
# first time on the host after merge. A renamed parameter, a deleted script, or a syntax error in a
# script no test happens to execute would otherwise be found by the next scheduled run.

$script:ContractCommonParameters = @(
    'Verbose', 'Debug', 'ErrorAction', 'WarningAction', 'InformationAction', 'ErrorVariable', 'WarningVariable',
    'OutVariable', 'OutBuffer', 'PipelineVariable', 'InformationVariable', 'ProgressAction', 'WhatIf', 'Confirm'
)

function Get-ScriptParseProblems {
    # Every PowerShell file under the given roots must parse without errors.
    param([Parameter(Mandatory)][string[]]$Roots)
    $problems = @()
    foreach ($root in $Roots) {
        if (-not (Test-Path $root)) { continue }
        foreach ($file in Get-ChildItem $root -Recurse -File -Filter *.ps1 | Where-Object { $_.FullName -notmatch '[\\/](node_modules|\.factory|\.ai)[\\/]' }) {
            $tokens = $null; $errors = $null
            [void][System.Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$tokens, [ref]$errors)
            foreach ($e in @($errors)) { $problems += "parse error in $($file.FullName):$($e.Extent.StartLineNumber): $($e.Message)" }
        }
    }
    , @($problems)
}

function Get-ScriptParameterContract([string]$Path) {
    $errors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($Path, [ref]$null, [ref]$errors)
    $parameters = if ($ast.ParamBlock) { @($ast.ParamBlock.Parameters) } else { @() }
    $names = @(); $mandatory = @()
    foreach ($p in $parameters) {
        $name = $p.Name.VariablePath.UserPath
        $names += $name
        foreach ($attribute in @($p.Attributes)) {
            if ($attribute -isnot [System.Management.Automation.Language.AttributeAst]) { continue }
            if ($attribute.TypeName.Name -eq 'Alias') { $names += @($attribute.PositionalArguments | ForEach-Object { $_.Value }) }
            if ($attribute.TypeName.Name -ne 'Parameter') { continue }
            foreach ($argument in @($attribute.NamedArguments)) {
                if ($argument.ArgumentName -eq 'Mandatory' -and ($argument.ExpressionOmitted -or $argument.Argument.Extent.Text -match '(?i)true')) { $mandatory += $name }
            }
        }
    }
    @{ Names = @($names); Mandatory = @($mandatory | Sort-Object -Unique) }
}

function Get-WorkflowContractProblems {
    # Every `command:` step must name a script that exists, pass only parameters the script declares,
    # and pass every mandatory one.
    param(
        [Parameter(Mandatory)][string]$WorkflowsPath,
        [Parameter(Mandatory)][string]$FactoryRoot
    )
    $problems = @(); $invocations = 0
    foreach ($workflow in Get-ChildItem $WorkflowsPath -Filter *.yaml) {
        $lineNumber = 0
        foreach ($line in Get-Content $workflow.FullName) {
            $lineNumber++
            if ($line -notmatch '^\s+command:\s*(.*)$') { continue }
            foreach ($match in [regex]::Matches($Matches[1], '\$FACTORY_RUNTIME_ROOT/(scripts/[A-Za-z0-9_/.\-]+\.(?:ps1|py|sh))([^;|&]*)')) {
                $invocations++
                $relative = $match.Groups[1].Value
                $where = "$($workflow.Name):$lineNumber $relative"
                $path = Join-Path $FactoryRoot $relative
                if (-not (Test-Path $path -PathType Leaf)) { $problems += "$where does not exist"; continue }
                if ($relative -notmatch '\.ps1$') { continue }
                $contract = Get-ScriptParameterContract $path
                # Quoted values may contain text that looks like a parameter; drop them before reading names.
                $arguments = [regex]::Replace($match.Groups[2].Value, '"[^"]*"|''[^'']*''', ' VALUE ')
                $passed = @([regex]::Matches($arguments, '(?<=\s)-([A-Za-z][A-Za-z0-9]*)') | ForEach-Object { $_.Groups[1].Value })
                foreach ($name in $passed) {
                    if (@($contract.Names + $script:ContractCommonParameters) -notcontains $name) {
                        $problems += "$where is passed -$name, which the script does not declare (declared: $($contract.Names -join ', '))"
                    }
                }
                foreach ($name in $contract.Mandatory) {
                    if ($passed -notcontains $name) { $problems += "$where is not passed mandatory -$name" }
                }
            }
        }
    }
    if ($invocations -eq 0) { $problems += "no script invocations were found under $WorkflowsPath; the contract check is not reading the workflows" }
    , @($problems)
}
