# The Factory issue lifecycle, read from policies/lifecycle.json. Dot-source this file.
#
# The lifecycle used to be repeated as literal `factory:*` lists in every script that selects or
# moves work, and the copies drifted apart. This is the one loader; scripts ask it which states are
# automated, which belong to a person, and what a state may move to. A project changes its process
# (for example adding a design sign-off step) by selecting or overriding a profile, not by editing
# scripts.

function Get-FactoryLifecycle {
    # Returns the selected profile as a hashtable: Name, Initial, States (ordered name -> definition),
    # and Markers. -Profile overrides the file's defaultProfile.
    param(
        [string]$Path = (Join-Path $PSScriptRoot '../policies/lifecycle.json'),
        [string]$Profile = ''
    )
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "lifecycle policy not found: $Path" }
    $model = Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json -AsHashtable
    if ($model['schemaVersion'] -ne 'factory-lifecycle/v1') { throw "unsupported lifecycle schemaVersion '$($model['schemaVersion'])' in $Path" }
    $name = if ($Profile) { $Profile } else { [string]$model['defaultProfile'] }
    $profiles = $model['profiles']
    if (-not $profiles -or -not $profiles.ContainsKey($name)) { throw "lifecycle profile '$name' is not defined in $Path" }
    $selected = $profiles[$name]
    @{
        Name    = $name
        Initial = [string]$selected['initial']
        States  = $selected['states']
        Markers = if ($model.ContainsKey('markers')) { $model['markers'] } else { @{} }
    }
}

function Get-FactoryLifecycleStates {
    # State names of the given kinds (all states when -Kind is omitted).
    param([Parameter(Mandatory)][hashtable]$Lifecycle, [string[]]$Kind = @())
    @($Lifecycle.States.Keys | Where-Object { -not $Kind.Count -or $Kind -contains [string]$Lifecycle.States[$_]['kind'] })
}

function Get-FactoryLifecycleOwnerWorkflows([hashtable]$State) {
    $owner = $State['owner']
    if (-not $owner) { return @() }
    @(@($owner['workflow']) + @($owner['workflows']) | Where-Object { $_ })
}

function Test-FactoryLifecycle {
    # Soundness of one profile. Returns problems; an empty list means every state has an owner, a way
    # out and a deadline. -StateLabels is the label taxonomy the profile must agree with;
    # -Automations is the list of automation definitions (name, kind, filters.allLabels,
    # task.workflow) that must contain a consumer for every automated state.
    param(
        [Parameter(Mandatory)][hashtable]$Lifecycle,
        [string[]]$StateLabels = @(),
        [object[]]$Automations = @()
    )
    $kinds = 'automated', 'in-run', 'human', 'delivery', 'terminal'
    $timeouts = 'retrigger', 'investigate', 'report', 'escalate'
    $problems = @()
    $states = $Lifecycle.States
    $names = @($states.Keys)
    if (-not $names.Count) { return , @("profile '$($Lifecycle.Name)' defines no states") }
    if ($names -notcontains $Lifecycle.Initial) { $problems += "initial state '$($Lifecycle.Initial)' is not defined" }
    if (-not @($names | Where-Object { $states[$_]['kind'] -eq 'terminal' }).Count) { $problems += 'no terminal state is defined' }

    foreach ($name in $names) {
        $state = $states[$name]
        $kind = [string]$state['kind']
        if ($kinds -notcontains $kind) { $problems += "$name has unknown kind '$kind'"; continue }
        if ($Lifecycle.Markers.ContainsKey($name)) { $problems += "$name is both a state and a marker" }
        $exits = @($state['exits'] | Where-Object { $_ })
        if ($kind -eq 'terminal') {
            if ($exits.Count) { $problems += "$name is terminal but has exits" }
            continue
        }
        if (-not $exits.Count) { $problems += "$name has no exit: work that reaches it can never leave" }
        foreach ($exit in $exits) {
            if ($names -notcontains [string]$exit['to']) { $problems += "$name exits to undefined state '$($exit['to'])'" }
            if (-not $exit['on']) { $problems += "$name -> $($exit['to']) does not name the event that causes it" }
        }
        if (-not ($state['maxDwellHours'] -gt 0)) { $problems += "$name has no deadline (maxDwellHours)" }
        if ($timeouts -notcontains [string]$state['onTimeout']) { $problems += "$name does not say what happens at its deadline (onTimeout: $($timeouts -join ', '))" }
        $workflows = @(Get-FactoryLifecycleOwnerWorkflows $state)
        $role = if ($state['owner']) { [string]$state['owner']['role'] } else { '' }
        if ($kind -eq 'human') {
            if (-not $role) { $problems += "$name is a human state with no owner role" }
        }
        elseif (-not $workflows.Count) { $problems += "$name has no owning workflow" }
        if ($kind -eq 'automated' -and $Automations.Count) {
            $consumers = @($Automations | Where-Object { $_.kind -eq 'github' -and @($_.filters.allLabels) -contains $name -and $workflows -contains [string]$_.task.workflow })
            if (-not $consumers.Count) { $problems += "$name is automated but no automation is triggered by it and runs $($workflows -join ' or ')" }
        }
    }

    # Every state must be reachable from the initial state, and able to reach a terminal state.
    $reached = @($Lifecycle.Initial); $queue = @($Lifecycle.Initial)
    while ($queue.Count) {
        $head = $queue[0]; $queue = @($queue | Select-Object -Skip 1)
        if (-not $states.ContainsKey($head)) { continue }
        foreach ($exit in @($states[$head]['exits'] | Where-Object { $_ })) {
            $to = [string]$exit['to']
            if ($reached -notcontains $to) { $reached += $to; $queue += $to }
        }
    }
    # A state a person enters by hand (blocked, human-review) is allowed to be unreachable by exits.
    foreach ($name in $names) {
        if ($reached -notcontains $name -and $states[$name]['kind'] -ne 'human') { $problems += "$name cannot be reached from $($Lifecycle.Initial)" }
    }
    $finishing = @($names | Where-Object { $states[$_]['kind'] -eq 'terminal' })
    do {
        $grew = $false
        foreach ($name in $names) {
            if ($finishing -contains $name) { continue }
            if (@($states[$name]['exits'] | Where-Object { $_ -and $finishing -contains [string]$_['to'] }).Count) { $finishing += $name; $grew = $true }
        }
    } while ($grew)
    foreach ($name in $names) { if ($finishing -notcontains $name) { $problems += "$name can never reach a terminal state" } }

    if ($StateLabels.Count) {
        foreach ($label in $StateLabels) { if ($names -notcontains $label) { $problems += "label taxonomy has state '$label' that the profile does not define" } }
        foreach ($name in $names) { if ($StateLabels -notcontains $name) { $problems += "$name is not in the label taxonomy (policies/labels.yaml factory-state)" } }
    }
    , @($problems)
}
