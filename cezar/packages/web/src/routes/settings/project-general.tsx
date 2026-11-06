import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'

import { useFactoryRelease, useProjects, useRunFullRegression, useUpdateProject, useWorkspaceConfig } from '@/api/queries'
import type { Capabilities, FullRegressionPolicy, ProjectListEntry } from '@open-mercato/cezar-api-client'
import { Button } from '@/components/ui/button'
import { useActiveProjectId } from '@/lib/project-router'
import { ProjectFolderField } from './project-location'
import { AddBootProjectButton, MaxParallelStepper, STATUS_LABEL } from './projects-section'
import { RemoveProjectDialog, useProjectRemoval } from './remove-project'
import { SettingsField } from './settings-field'

/**
 * Project settings → General: what THIS project is, and the few knobs that belong to the project
 * as a whole rather than to agents, worktrees or templates.
 *
 * It exists because every other section answers a narrow question and none of them answered the
 * broad one. Where is this checkout? Is its folder still there? How many of its tasks may run at
 * once? How do I get rid of it? Those last two lived only in the GLOBAL registry table — a row
 * in a list of every project, reached from the other settings area — which is a strange place to
 * go to act on the project you are already inside.
 *
 * Two things are deliberately NOT duplicated here: anything machine-wide (appearance, host
 * resources, accounts — the index's footer links to Global settings for those), and the section
 * list, which is the left nav on desktop and only renders as cards on small screens.
 *
 * Reuse over restatement: the folder row, the concurrency select, and the removal wording+dialog
 * are the same components the registry table uses. Two pages disagreeing about what "Remove"
 * does is exactly the failure this page could otherwise introduce.
 *
 * Split in two halves, because `CEZ_SINGLE_PROJECT=1` treats them differently. DESCRIBING the
 * project (folder, registry facts) stays true in every mode. MANAGING the registry — the
 * concurrency ceiling, Remove — is what single-project mode takes away: `PATCH`/`DELETE
 * /api/v1/projects/:id` both answer 409 there (server.ts), and `visibleSettingsSections` already
 * drops the whole global Projects section for the same reason. Rendering those two fields anyway
 * would offer a knob that can only fail, which is the opposite of what capabilities.ts asks for
 * ("the UI hides what the server says isn't there, and the matching endpoints refuse as defense
 * in depth").
 */

/** `2026-07-20T…` → a full local date. Unlike the registry table's compact `Jul 20`, this page has
 *  the room and is the place someone comes to check WHEN. An unparseable stamp degrades to an em
 *  dash rather than `Invalid Date`. */
function fullDate(iso: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return '—'
  return at.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

export function ProjectGeneral({ capabilities }: { capabilities?: Partial<Pick<Capabilities, 'singleProject'>> }) {
  const projectId = useActiveProjectId()
  const projects = useProjects()
  const config = useWorkspaceConfig()
  const factoryRelease = useFactoryRelease()
  const updateProject = useUpdateProject()
  const fullRegression = useRunFullRegression()

  if (projects.isPending) {
    return (
      <p data-slot="project-general-loading" className="text-[13px] text-soft-foreground">
        Loading project…
      </p>
    )
  }
  // An unreadable registry is SAID, not skipped. Defense in depth rather than a path a user
  // reaches today: `ProjectScopeRoute` keeps a scoped URL on "Loading…" while the registry query
  // is unresolved, so this branch only renders where the gate is not in front of it. It belongs
  // here anyway — on desktop the section cards are `md:hidden` (the left nav already lists them),
  // so a silent `null` would leave the whole pane blank with no hint that anything went wrong.
  if (projects.isError) {
    return (
      <p data-slot="project-general-error" className="text-[13px] text-danger">
        Could not read the project registry — {projects.error.message}
      </p>
    )
  }
  const registry = projects.data
  const project = registry?.projects.find((entry) => entry.id === projectId)
  // No registry entry for this URL (an unscoped mount, or an id the registry does not have):
  // there is nothing true to say about a project that isn't one.
  if (!registry || !project) return null
  // See the header comment: single-project mode keeps the description, drops the management.
  // An UNREGISTERED boot folder drops it for a different reason: there is no registry row to
  // manage. `PATCH`/`DELETE /api/v1/projects/:id` would both 404, so the page offers the one
  // thing that does apply — adding it — and says why it is not there yet.
  const managesRegistry = capabilities?.singleProject !== true && project.unregistered !== true

  return (
    <div data-slot="project-general" className="mx-auto flex w-full max-w-2xl flex-col gap-7">
      <ProjectFolderField />
      <ProjectFacts project={project} canRemove={managesRegistry} />
      {project.unregistered ? (
        <SettingsField
          title="Add to your projects"
          hint="cezar is serving this folder because you started it here — starting cezar somewhere new never adds it to your project list for you. Adding it keeps it in the sidebar between runs and gives it a registry entry to hold settings like the task cap. Nothing on disk changes either way."
        >
          <AddBootProjectButton root={project.root} name={project.name} />
        </SettingsField>
      ) : null}
      {managesRegistry ? (
        <>
          <SettingsField
            title="Factory channel"
            hint="New tasks resolve this channel to one verified Factory version and keep that version for retries and resumes. Existing tasks keep their saved version."
          >
            {factoryRelease.data?.status === 'resolved' ? (
              <div className="flex flex-col items-start gap-2">
                <select
                  aria-label="Factory channel"
                  data-slot="factory-channel"
                  className="h-9 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  value={project.factoryChannel ?? factoryRelease.data.channel}
                  disabled={updateProject.isPending}
                  onChange={(event) => updateProject.mutate({ id: project.id, factoryChannel: event.target.value as 'dev' | 'stable' })}
                >
                  <option value="stable">stable</option>
                  <option value="dev">dev</option>
                </select>
                <span className="text-[11px] text-soft-foreground">Current version: {factoryRelease.data.sourceSha.slice(0, 12)}</span>
              </div>
            ) : factoryRelease.data?.status === 'legacy' ? (
              <p className="text-[13px] text-soft-foreground">Channel releases are not configured for this Cezar instance.</p>
            ) : factoryRelease.isError || factoryRelease.data?.status === 'error' ? (
              <p className="text-[13px] text-danger">Factory release unavailable: {factoryRelease.data?.status === 'error' ? factoryRelease.data.error : factoryRelease.error?.message ?? 'request failed'}</p>
            ) : (
              <p className="text-[13px] text-soft-foreground">Loading Factory release status…</p>
            )}
            {updateProject.isError ? <p role="alert" className="text-[13px] text-danger">{updateProject.error.message}</p> : null}
          </SettingsField>
          <SettingsField
            title="Full regression cadence"
            hint="Focused checks run with each task. This policy controls expensive full suites; missing settings mean on-demand only. Runs share this project's task concurrency cap and coalesce updates into at most one follow-up."
          >
            <FullRegressionPolicyEditor
              project={project}
              disabled={updateProject.isPending}
              onSave={(fullRegressionPolicy) => updateProject.mutate({ id: project.id, fullRegressionPolicy })}
            />
            <div className="mt-3 flex flex-col items-start gap-1">
              <Button type="button" size="sm" variant="outline" disabled={fullRegression.isPending} onClick={() => fullRegression.mutate(project.id)}>
                {fullRegression.isPending ? 'Queueing…' : 'Run full regression now'}
              </Button>
              {fullRegression.data ? <span role="status" className="text-xs text-soft-foreground">
                {fullRegression.data.status === 'limited' || fullRegression.data.status === 'not-configured'
                  ? fullRegression.data.reason
                  : `Run ${fullRegression.data.runId} will test ${fullRegression.data.testedHead.slice(0, 12)}${fullRegression.data.followUpPending ? ' · one follow-up is pending' : ''}`}
              </span> : null}
              {fullRegression.isError ? <span role="alert" className="text-xs text-danger">{fullRegression.error.message}</span> : null}
            </div>
          </SettingsField>
          {updateProject.isError ? <p role="alert" className="text-[13px] text-danger">{updateProject.error.message}</p> : null}
          <SettingsField
            title="Max parallel tasks"
            hint={
              config.data
                ? `How many of this project's tasks may run at once — leave it empty to inherit the workspace limit. The workspace limit (${config.data.resources.maxParallel}) still applies as an overall ceiling, so a higher value here has no extra effect until that one is raised.`
                : "How many of this project's tasks may run at once — leave it empty to inherit the workspace limit. The workspace limit still applies as an overall ceiling."
            }
          >
            {config.data ? (
              <MaxParallelStepper project={project} workspaceMax={config.data.resources.maxParallel} />
            ) : (
              // The stepper's "Inherit (N)" placeholder has to name N, and guessing it would be
              // the one thing this control must not do.
              <p className="text-[13px] text-soft-foreground">Loading the workspace limit…</p>
            )}
          </SettingsField>
          <RemoveProject project={project} bootProject={registry.bootProject} />
        </>
      ) : null}
    </div>
  )
}

function defaultFullRegressionPolicy(): FullRegressionPolicy {
  return { mode: 'on-demand', windowHours: 168, maxRunsPerWindow: 1, maxUpdatesPerWindow: 100, maxQueuedRuns: 1 }
}

function FullRegressionPolicyEditor({
  project,
  disabled,
  onSave,
}: {
  project: ProjectListEntry
  disabled: boolean
  onSave: (policy: FullRegressionPolicy) => void
}) {
  const [draft, setDraft] = useState<FullRegressionPolicy>(project.fullRegressionPolicy ?? defaultFullRegressionPolicy())
  useEffect(() => setDraft(project.fullRegressionPolicy ?? defaultFullRegressionPolicy()), [project.id, project.fullRegressionPolicy])
  const budget = {
    windowHours: draft.windowHours,
    maxRunsPerWindow: draft.maxRunsPerWindow,
    maxUpdatesPerWindow: draft.maxUpdatesPerWindow,
    maxQueuedRuns: draft.maxQueuedRuns,
  }
  const setNumber = (key: 'windowHours' | 'maxRunsPerWindow' | 'maxUpdatesPerWindow', value: string) => {
    const number = Number(value)
    const bounds = key === 'windowHours' ? [1, 8760] : key === 'maxRunsPerWindow' ? [1, 100] : [1, 100000]
    if (!Number.isInteger(number) || number < bounds[0]! || number > bounds[1]!) return
    setDraft((current) => ({ ...current, [key]: number }))
  }
  return (
    <div className="flex w-full max-w-lg flex-col gap-3" data-slot="full-regression-policy">
      <select
        aria-label="Full regression mode"
        className="h-9 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
        value={draft.mode}
        disabled={disabled}
        onChange={(event) => {
          const common = budget
          if (event.target.value === 'scheduled') {
            setDraft({ ...common, mode: 'scheduled', schedule: draft.mode === 'scheduled' ? draft.schedule : { type: 'daily', hour: 3, minute: 0 } })
          } else if (event.target.value === 'after_changes') {
            setDraft({ ...common, mode: 'after_changes', changesPerBatch: draft.mode === 'after_changes' ? draft.changesPerBatch : 25 })
          } else {
            setDraft({ ...common, mode: 'on-demand' })
          }
        }}
      >
        <option value="on-demand">On demand</option>
        <option value="scheduled">Scheduled</option>
        <option value="after_changes">After a change batch</option>
      </select>
      {draft.mode === 'scheduled' ? (
        <div className="grid grid-cols-2 gap-2">
          <select
            aria-label="Full regression schedule"
            className="h-9 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
            value={draft.schedule.type}
            disabled={disabled}
            onChange={(event) => setDraft((current) => {
              const type = event.target.value
              const prior = current.mode === 'scheduled' && current.schedule.type !== 'hours' ? current.schedule : undefined
              if (type === 'hours') return { ...current, mode: 'scheduled', schedule: { type, every: 6 } }
              if (type === 'weekly') return { ...current, mode: 'scheduled', schedule: { type, hour: prior?.hour ?? 3, minute: prior?.minute ?? 0, day: current.mode === 'scheduled' && current.schedule.type === 'weekly' ? current.schedule.day : 1 } }
              return { ...current, mode: 'scheduled', schedule: { type: type === 'weekdays' ? 'weekdays' : 'daily', hour: prior?.hour ?? 3, minute: prior?.minute ?? 0 } }
            })}
          >
            <option value="daily">Daily</option>
            <option value="weekdays">Weekdays</option>
            <option value="weekly">Weekly</option>
            <option value="hours">Every few hours</option>
          </select>
          {draft.schedule.type === 'hours' ? (
            <select
              aria-label="Schedule interval hours"
              className="h-9 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
              value={draft.schedule.every ?? 6}
              disabled={disabled}
              onChange={(event) => setDraft((current) => current.mode === 'scheduled'
                ? { ...current, schedule: { type: 'hours', every: Number(event.target.value) as 1 | 2 | 3 | 4 | 6 | 8 | 12 } }
                : current)}
            >
              {[1, 2, 3, 4, 6, 8, 12].map((hours) => <option key={hours} value={hours}>{hours} hours</option>)}
            </select>
          ) : (
            <div className="flex items-center gap-2">
              <label className="text-xs text-soft-foreground">Hour
                <input type="number" min={0} max={23} value={draft.schedule.hour ?? 3} disabled={disabled} onChange={(event) => {
                  const hour = Number(event.target.value)
                  if (Number.isInteger(hour) && hour >= 0 && hour <= 23) setDraft((current) => current.mode === 'scheduled' && current.schedule.type !== 'hours' ? { ...current, schedule: { ...current.schedule, hour } } : current)
                }} className="ml-1 h-8 w-16 rounded-md border border-input bg-background px-2 text-sm text-foreground" />
              </label>
              <label className="text-xs text-soft-foreground">Minute
                <input type="number" min={0} max={59} value={draft.schedule.minute ?? 0} disabled={disabled} onChange={(event) => {
                  const minute = Number(event.target.value)
                  if (Number.isInteger(minute) && minute >= 0 && minute <= 59) setDraft((current) => current.mode === 'scheduled' && current.schedule.type !== 'hours' ? { ...current, schedule: { ...current.schedule, minute } } : current)
                }} className="ml-1 h-8 w-16 rounded-md border border-input bg-background px-2 text-sm text-foreground" />
              </label>
              {draft.schedule.type === 'weekly' ? <label className="text-xs text-soft-foreground">Day
                <select aria-label="Weekly regression day" value={draft.schedule.day ?? 1} disabled={disabled} onChange={(event) => {
                  const day = Number(event.target.value) as 1 | 2 | 3 | 4 | 5 | 6 | 7
                  setDraft((current) => current.mode === 'scheduled' && current.schedule.type === 'weekly' ? { ...current, schedule: { ...current.schedule, day } } : current)
                }} className="ml-1 h-8 rounded-md border border-input bg-background px-2 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50">
                  {[['1', 'Monday'], ['2', 'Tuesday'], ['3', 'Wednesday'], ['4', 'Thursday'], ['5', 'Friday'], ['6', 'Saturday'], ['7', 'Sunday']].map(([day, name]) => <option key={day} value={day}>{name}</option>)}
                </select>
              </label> : null}
            </div>
          )}
        </div>
      ) : null}
      {draft.mode === 'after_changes' ? (
        <label className="flex items-center gap-2 text-sm">
          <span>Run after</span>
          <input aria-label="Changes per full regression batch" type="number" min={1} max={100000} value={draft.changesPerBatch} disabled={disabled} onChange={(event) => {
            const value = Number(event.target.value)
            if (Number.isInteger(value) && value >= 1 && value <= 100000) setDraft((current) => current.mode === 'after_changes' ? { ...current, changesPerBatch: value } : current)
          }} className="h-9 w-24 rounded-md border border-input bg-background px-3 text-sm" />
          <span>integrated changes</span>
        </label>
      ) : null}
      <div className="grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-1 text-xs text-soft-foreground">Maximum runs per window
          <input type="number" min={1} max={100} value={draft.maxRunsPerWindow} disabled={disabled} onChange={(event) => setNumber('maxRunsPerWindow', event.target.value)} className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground" />
        </label>
        <label className="flex flex-col gap-1 text-xs text-soft-foreground">Window hours
          <input type="number" min={1} max={8760} value={draft.windowHours} disabled={disabled} onChange={(event) => setNumber('windowHours', event.target.value)} className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground" />
        </label>
        <label className="flex flex-col gap-1 text-xs text-soft-foreground">Maximum updates per window
          <input type="number" min={1} max={100000} value={draft.maxUpdatesPerWindow} disabled={disabled} onChange={(event) => setNumber('maxUpdatesPerWindow', event.target.value)} className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground" />
        </label>
        <label className="flex flex-col gap-1 text-xs text-soft-foreground">Queued follow-ups
          <select value={draft.maxQueuedRuns} disabled={disabled} onChange={(event) => setDraft((current) => ({ ...current, maxQueuedRuns: Number(event.target.value) as 0 | 1 }))} className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50">
            <option value={0}>None</option><option value={1}>One coalesced follow-up</option>
          </select>
        </label>
      </div>
      <Button type="button" size="sm" disabled={disabled} onClick={() => onSave(draft)}>Save regression policy</Button>
    </div>
  )
}

/** The registry entry, read out: what cezar probed about this folder the last time it looked.
 *  `canRemove` is whether the Remove field is rendered below — the missing-folder hint points at
 *  it, and must not point at a field single-project mode took away. */
function ProjectFacts({ project, canRemove }: { project: ProjectListEntry; canRemove: boolean }) {
  return (
    <SettingsField
      title="Project"
      hint="The registry entry for this checkout — re-probed every time the project list is read."
    >
      <dl
        data-slot="project-facts"
        className="grid grid-cols-[8rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 rounded-md border border-border bg-card p-3 text-[13px]"
      >
        <dt className="text-muted-foreground">Name</dt>
        <dd className="min-w-0 truncate text-foreground">{project.name}</dd>

        <dt className="text-muted-foreground">Status</dt>
        <dd data-slot="project-general-status" className={project.status === 'missing' ? 'text-danger' : 'text-foreground'}>
          {STATUS_LABEL[project.status]}
          {/* A registered folder that has been deleted or moved is the one status worth acting
              on, and "folder not found" alone does not say what to do about it. */}
          {project.status === 'missing'
            ? canRemove
              ? ' — remove it below, or restore the folder'
              : ' — restore the folder at the path above'
            : null}
        </dd>

        {/* Omitted rather than dashed when git could not name one (unborn HEAD): an empty row
            invites the reader to wonder which branch is checked out, a missing row does not. */}
        {project.branch !== undefined ? (
          <>
            <dt className="text-muted-foreground">Branch</dt>
            <dd className="min-w-0 truncate font-mono text-xs text-foreground">{project.branch}</dd>
          </>
        ) : null}

        {/* A folder cezar is serving but has never registered has no registry dates to read out
            — inventing them (or dashing two rows) would say less than naming the state once. */}
        {project.unregistered ? (
          <>
            <dt className="text-muted-foreground">In your projects</dt>
            <dd data-slot="project-general-unregistered" className="text-foreground">
              No — served because cezar was started here
            </dd>
          </>
        ) : (
          <>
            <dt className="text-muted-foreground">Added</dt>
            <dd className="text-foreground">
              {fullDate(project.addedAt)}
              <span className="text-soft-foreground">
                {project.source === 'checkout' ? ' · cloned from GitHub' : ' · opened locally'}
              </span>
            </dd>

            <dt className="text-muted-foreground">Last opened</dt>
            <dd className="text-foreground">{fullDate(project.lastOpenedAt)}</dd>
          </>
        )}
      </dl>
    </SettingsField>
  )
}

/**
 * Deregister this project — the registry table's per-row Remove, offered where the user already
 * is. Same hook, same dialog, same words (remove-project.tsx).
 *
 * The boot project cannot be removed from the cockpit: this server is serving that folder, and
 * dropping its registry row would break the session's own sidebar, so the server 409s. Disabling
 * here means the explanation arrives before the click rather than as an error toast after it —
 * and the offline gesture (`cezar projects remove`, which has no such refusal) is what the
 * message points at.
 *
 * On success the URL this page lives at (`/p/<id>/settings`) has just stopped resolving, so the
 * navigation is part of the action, not a nicety. It targets the BOOT project explicitly rather
 * than `/`: the bare root restores the last saved location, and whether the removed project has
 * already left the registry cache when that check runs is a race — this is the one project that
 * is always registered.
 */
function RemoveProject({ project, bootProject }: { project: ProjectListEntry; bootProject: string }) {
  const [confirming, setConfirming] = useState<ProjectListEntry | null>(null)
  const remove = useProjectRemoval()
  const navigate = useNavigate()
  const isBoot = project.id === bootProject

  return (
    <SettingsField
      title="Remove from workspace"
      hint="Unregisters this project so it leaves the sidebar and the project list. Nothing on disk is deleted — the folder, its git history and its task history all stay, and adding it back later finds everything intact."
    >
      <div className="flex items-center gap-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-action="project-general-remove"
          // Leads with the words on the button (WCAG 2.5.3 Label in Name) so speech input can
          // reach it, then says what "Remove" actually does — the row context that makes a bare
          // "Remove" safe-sounding isn't read out with it.
          aria-label={`Remove ${project.name} from the workspace — unregisters it, no files are deleted`}
          title={isBoot ? 'cezar is serving this project — stop it and use `cezar projects remove`' : undefined}
          disabled={isBoot || remove.isPending}
          onClick={() => setConfirming(project)}
          className="text-danger"
        >
          Remove {project.name}
        </Button>
        {isBoot ? (
          <span data-slot="project-general-remove-boot" className="text-[11px] text-soft-foreground">
            cezar is serving this project — stop cezar and run `cezar projects remove` to drop it.
          </span>
        ) : null}
      </div>
      <RemoveProjectDialog
        project={confirming}
        onOpenChange={(open) => !open && setConfirming(null)}
        onConfirm={() => {
          setConfirming(null)
          // A 409 (running tasks) leaves the project registered, so the navigation is inside the
          // success path only — `useProjectRemoval` toasts the server's refusal and stays put.
          remove.confirm(project, () => void navigate(`/p/${encodeURIComponent(bootProject)}`))
        }}
      />
    </SettingsField>
  )
}
