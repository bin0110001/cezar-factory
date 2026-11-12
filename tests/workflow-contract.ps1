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

function Get-PortabilityProblems {
    # The Factory is developed on Windows and runs on Linux. These constructs pass on the first and fail
    # on the second, and each has already broken a deploy: a cmdlet parameter that only exists on Windows,
    # a .cmd shim, a drive-letter path, a Windows-only environment variable used without a fallback.
    # A line that is deliberately Windows-only says so with a trailing `# windows-only` comment.
    param([Parameter(Mandatory)][string[]]$Roots)
    $windowsOnlyParameters = '-WindowStyle', '-Verb'
    $windowsOnlyEnvironment = '^env:(LOCALAPPDATA|APPDATA|USERPROFILE|ProgramFiles|ProgramData|windir|SystemRoot|COMPUTERNAME|HOMEDRIVE|HOMEPATH)$'
    $problems = @()
    foreach ($root in $Roots) {
        if (-not (Test-Path $root)) { continue }
        foreach ($file in Get-ChildItem $root -Recurse -File -Filter *.ps1 | Where-Object { $_.FullName -notmatch '[\\/](node_modules|\.factory|\.ai|fixtures)[\\/]' }) {
            $tokens = $null; $errors = $null
            [void][System.Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$tokens, [ref]$errors)
            $lines = @(Get-Content -LiteralPath $file.FullName)
            foreach ($token in @($tokens)) {
                $lineNumber = $token.Extent.StartLineNumber
                $line = if ($lineNumber -ge 1 -and $lineNumber -le $lines.Count) { [string]$lines[$lineNumber - 1] } else { '' }
                if ($line -match '#\s*windows-only\b') { continue }
                $where = "$($file.FullName):$lineNumber"
                switch ($token.Kind) {
                    'Parameter' {
                        if ($windowsOnlyParameters -contains $token.Text) { $problems += "$where uses $($token.Text), which Linux PowerShell does not have" }
                    }
                    'Variable' {
                        $path = $token.VariablePath.UserPath
                        # Reading the variable is fine when the same line tests it or supplies a fallback.
                        if ($path -match $windowsOnlyEnvironment -and $line -notmatch '(?i)\bif\s*\(|\?\?|-and\s|-or\s|Test-Path') { $problems += "$where reads `$$path with no fallback; it is empty on Linux" }
                    }
                    { $_ -in 'StringLiteral', 'StringExpandable' } {
                        $value = [string]$token.Value
                        if ($value -match '^[A-Za-z]:[\\/]') { $problems += "$where holds a drive-letter path ($value)" }
                        # A test may name a shim it builds only on Windows; deployed scripts may not depend on one.
                        elseif ($value -match '(?i)\.(cmd|bat)$' -and $file.FullName -match '[\\/]scripts[\\/]') { $problems += "$where names a Windows command shim ($value)" }
                    }
                }
            }
        }
    }
    , @($problems)
}

function Get-HostCommandProblems {
    # Python entry points are started by workflow `command:` steps and by the systemd units in
    # integrations/bazzite. A flag the script does not define, or a subcommand it does not know, fails at
    # the next scheduled run on the host. Every `--flag` and the first positional word of each such command
    # must appear in the script as an argument-parser literal.
    param(
        [Parameter(Mandatory)][string]$FactoryRoot,
        [string[]]$CommandFiles = @()
    )
    $problems = @(); $checked = 0
    if (-not $CommandFiles.Count) {
        $CommandFiles = @(Get-ChildItem (Join-Path $FactoryRoot 'workflows') -Filter *.yaml | ForEach-Object { $_.FullName })
        $units = Join-Path $FactoryRoot 'integrations/bazzite'
        if (Test-Path $units) { $CommandFiles += @(Get-ChildItem $units -Filter *.service | ForEach-Object { $_.FullName }) }
    }
    foreach ($commandFile in $CommandFiles) {
        $lineNumber = 0
        foreach ($line in Get-Content -LiteralPath $commandFile) {
            $lineNumber++
            if ($line -notmatch '^\s*(command:|ExecStart=)') { continue }
            foreach ($match in [regex]::Matches($line, '(?:\$FACTORY_RUNTIME_ROOT|%h/cezar-factory)/(scripts/[A-Za-z0-9_/.\-]+\.py)([^;|&]*)')) {
                $relative = $match.Groups[1].Value
                $where = "$(Split-Path $commandFile -Leaf):$lineNumber $relative"
                $path = Join-Path $FactoryRoot $relative
                if (-not (Test-Path $path -PathType Leaf)) { $problems += "$where does not exist"; continue }
                $checked++
                $source = Get-Content -Raw -LiteralPath $path
                $arguments = [regex]::Replace($match.Groups[2].Value, '"[^"]*"|''[^'']*''', ' VALUE ')
                foreach ($flag in @([regex]::Matches($arguments, '(?<=\s)(--[a-z][a-z0-9-]*)') | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique)) {
                    if ($source -notmatch ('["'']' + [regex]::Escape($flag) + '["'']')) { $problems += "$where is passed $flag, which the script's argument parser does not define" }
                }
                $first = @($arguments.Trim() -split '\s+' | Where-Object { $_ })[0]
                if ($first -and $first -match '^[a-z][a-z0-9-]*$' -and $source -notmatch ('["'']' + [regex]::Escape($first) + '["'']')) {
                    $problems += "$where is started with '$first', which the script does not name as a command"
                }
            }
        }
    }
    if ($checked -eq 0) { $problems += 'no Python entry point was found in the workflows or systemd units; the host command check is not reading them' }
    , @($problems)
}

function Get-ScriptStartProblems {
    # Starts each listed script the way its workflow step does, in an empty directory, with a `gh` that
    # refuses every call and no reachable Cezar API. The script is expected to stop with its own message
    # (a missing result file, a refused `gh` call). What it must not do is die on a defect in its own code:
    # a cmdlet or parameter that does not exist on this platform, a property that is not there, a syntax
    # error. Those are the failures that used to appear on the first real run on the host.
    param(
        [Parameter(Mandatory)][string]$FactoryRoot,
        [Parameter(Mandatory)][hashtable]$Invocations,
        [Parameter(Mandatory)][string]$WorkDirectory
    )
    $defects = 'ParserError', 'is not recognized as a name of a cmdlet', 'is not recognized as the name of a cmdlet',
        'A parameter cannot be found that matches parameter name', 'cannot be found on this object',
        'Cannot bind argument to parameter', 'The term ''', 'Missing an argument for parameter', 'You cannot call a method on a null-valued expression'
    $problems = @()
    $shimDirectory = Join-Path $WorkDirectory 'bin'
    New-Item -ItemType Directory -Force -Path $shimDirectory | Out-Null
    'Write-Error "gh is not available in the start-up smoke test: $($args -join '' '')"; exit 1' | Set-Content (Join-Path $shimDirectory 'gh.ps1')
    $saved = @{ PATH = $env:PATH; CEZ_API_URL = $env:CEZ_API_URL; CEZAR_API_URL = $env:CEZAR_API_URL; FACTORY_RUNTIME_ROOT = $env:FACTORY_RUNTIME_ROOT }
    try {
        $env:PATH = $shimDirectory + [IO.Path]::PathSeparator + $env:PATH
        $env:CEZ_API_URL = 'http://127.0.0.1:9'; $env:CEZAR_API_URL = 'http://127.0.0.1:9'
        $env:FACTORY_RUNTIME_ROOT = $FactoryRoot
        foreach ($relative in $Invocations.Keys) {
            $path = Join-Path $FactoryRoot $relative
            if (-not (Test-Path $path -PathType Leaf)) { $problems += "$relative does not exist"; continue }
            $directory = Join-Path $WorkDirectory ([IO.Path]::GetFileNameWithoutExtension($relative))
            New-Item -ItemType Directory -Force -Path $directory | Out-Null
            Push-Location $directory
            try { $output = & pwsh -NoProfile -File $path @($Invocations[$relative]) *>&1 | Out-String }
            finally { Pop-Location }
            foreach ($defect in $defects) {
                if ($output.Contains($defect)) { $problems += "$relative dies on a code defect when started as its workflow starts it: $(($output -split "`n" | Where-Object { $_.Contains($defect) } | Select-Object -First 1).Trim())"; break }
            }
        }
    }
    finally { foreach ($key in $saved.Keys) { if ($null -eq $saved[$key]) { Remove-Item "Env:$key" -ErrorAction SilentlyContinue } else { Set-Item "Env:$key" $saved[$key] } } }
    , @($problems)
}