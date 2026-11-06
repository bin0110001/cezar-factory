---
name: backlog
description: ARCHIVED Markdown backlog — for active work ("work the backlog", "fix some issues") use the work-the-backlog skill instead. Historical reference for how the project's bug/feature backlog under requirements/Bug Reports/ and requirements/Planned Features/ — finding, prioritizing, implementing, and marking items complete using this project's filename/checklist conventions.
---

# Backlog Skill

## Cutover

GitHub Issues and the TableFlux Work Project replaced the active Markdown
backlog on 2026-09-21. Do not select, create, or mark work in the archived
requirements tree. Use github-issues-workflow for all active work; consult the
archive only for provenance and context.

**Requests like "work the backlog" / "work on the backlog" are handled by the
`work-the-backlog` skill (GitHub Issues), not this one.** Read this skill only
for archived-Markdown provenance. The rest of this file describes the
historical process.

Historically this skill was used when asked to "work on the backlog," "fix some bugs," "pick up
a planned feature," or similarly open-ended requests to pull work from
`requirements/Bug Reports/` or `requirements/Planned Features/` rather than
from a specific ticket the user hands you directly.

This skill is about *finding and sequencing* work and *marking it done*
correctly. It is not a substitute for this project's existing engineering
conventions (CLAUDE.md, the animation/combat migration logs, the
`.agents/skills/*_creation` skills for building a new plugin of a given
type, testing conventions) — once you've picked an item, follow those as
normal.

## The two backlog sources

### `requirements/Bug Reports/`

One file per day, named `YYYY-MM-DD.md`. Each bug is a checklist line:

```markdown
- [ ] Door interaction hitbox too small in the cave room
- [x] Chat history not preserved between launches
```

To find open bugs: search every file in this folder for `- [ ]` lines.
`Grep` with pattern `^- \[ \]` across `requirements/Bug Reports/*.md` is the
fast path. The file's date (from its filename) is the bug's age — sort
oldest-file-first.

If you find a bug-report file that isn't named a bare `YYYY-MM-DD.md` (no
date, or a date plus extra words), that's a live note the user jotted down
without following the naming convention — rename it by prepending today's
date (`YYYY-MM-DD `) rather than reinterpreting or discarding the existing
name. Never touch the date portion of an already-correctly-dated filename.

### `requirements/Planned Features/`

One file (or, for a large area, a subfolder of files — see `VTT Roadmap/`)
per feature/design area. Status lives in the filename as a bracketed
prefix:

- `[WIP] <name>.md` — in progress. Pick these up before untagged files if
  the user wants existing work finished rather than new work started.
- No tag — not started yet. This is the open/default state.

There is no `[DONE]` tag used in place — once a feature is actually
finished, its file moves entirely out of `Planned Features/` into
`requirements/Completed/`, dropping any tag on the way (the folder itself
means done; see the Mark-it-done step below). So everything found directly
under `Planned Features/` (recursively) is, by construction, still open.

To find open features: `Glob` for `*.md` under `requirements/Planned
Features/` (including subfolders). Skip `FEATURE_PRIORITY.md` itself — it's
the index, not a work item.

A multi-file design area (a subfolder like `VTT Roadmap/`) is tracked
file-by-file, not as a whole — the folder itself and any top-level index
file (e.g. `00-architecture-and-build-order.md`) never get a status tag or
move to `Completed/`; only the individual section files do, as each is
actually finished. `VTT Roadmap/`'s `01`–`15` numeric prefixes are stable
section IDs, not a priority order — see below.

### `requirements/Planned Features/FEATURE_PRIORITY.md`

The single ranked list of all open feature work, across every file/subfolder
in `Planned Features/`. This is the priority order — not filename numbering,
not file modification time. Read it to know what's next; edit it (cut/paste
rows) to reorder; remove an item's row when its file moves to `Completed/`.

### `requirements/Completed/`

Finished plan/status docs live here, untagged, purely as historical
record. Nothing here is backlog — don't scan this folder when looking for
work, only when researching why something was built a certain way.

## Intake: new feature requests from the user

This skill isn't just for pulling from the backlog — it also covers *adding
to* it. Trigger this whenever the user asks for a new feature that's more
than a small/simple update, regardless of whether they used the word
"backlog." A substantial ask shouldn't pass through as pure conversation
with nothing captured in `Planned Features/`.

"Substantial" vs. "small/simple" is a judgment call, same as other
ambiguous-scope decisions elsewhere in this project — when it's not
obvious, say which way you're calling it ("this is a small tweak, skipping
the doc" / "this is substantial, creating a doc") so the user can correct
you in the moment.

**Always create the doc first, then implement against it** (if
implementing at all) — same "read/write the design doc before coding"
discipline as picking up existing backlog items, and it means the request
survives even if work gets interrupted.

Where the new file and its `FEATURE_PRIORITY.md` row land depends on what
the user actually asked for — this is the one place priority is dictated
by the user rather than derived from the list:

- **"Build this" / "implement this now"** → create the file (untagged, or
  `[WIP]` if implementation starts the same turn) and insert it as **row
  #1** in `FEATURE_PRIORITY.md`, above every other row. This bumps
  whatever was previously first — that's intentional, not a bug to avoid.
- **"Add this to the list" / "we should do this eventually"** → create the
  file untagged and append it as the **last** row in `FEATURE_PRIORITY.md`.

If it's unclear which of those two the user means, ask — don't guess,
since the difference determines whether other in-flight priorities get
displaced.

## Priority order for "work on the backlog"

Unless the user says otherwise for a given request:

1. **Bugs before features.** A regression or broken behavior blocks
   players today; a planned feature does not yet exist for anyone to miss.
2. **Within bugs: oldest file first**, top-to-bottom within a file. Do not
   skip around picking "easy" bugs over old ones without saying so — if an
   old bug looks disproportionately large, say that and ask whether to
   defer it rather than silently reordering.
3. **Within features: follow `FEATURE_PRIORITY.md` top to bottom.** That
   file already encodes "`[WIP]` generally before untagged" and whatever
   build-order/dependency reasoning was current when it was last edited —
   don't re-derive priority from scratch or from the VTT Roadmap's numeric
   prefixes, which are IDs, not order. If a feature you're about to start
   isn't listed in `FEATURE_PRIORITY.md` yet (e.g. a new file just landed
   in `Planned Features/`), add it to the list — ranked by your best
   judgment, flagged to the user — before or as part of picking it up,
   rather than working it silently unranked.

This is a priority-list default, not a rigid law — if the user asks for
"quick wins" or names a specific area, follow that instead and say so.

## Workflow

1. **Scan.** Grep bug files for `- [ ]`, glob Planned Features for
   untagged/`[WIP]` files. Build a short candidate list (don't dump every
   open item — a handful ranked by the priority order above is enough to
   start a conversation or begin work).
2. **Pick.** If the user said "work on the backlog" with no further detail,
   pick the top item per the priority order and say what you picked and
   why in one sentence before starting. If multiple similarly-old bugs
   exist, it's fine to batch a few small ones in one pass — say so.
3. **Investigate before implementing.** For a bug, read any existing
   context already in the checklist item (sub-bullets left by a prior
   investigation) and check the relevant troubleshooting logs this project
   already maintains (`ANIMATION_TROUBLESHOOTING_LOG.md`,
   `COMBAT_CAMERA_MIGRATION_PLAN.md`, etc.) before assuming it's
   undiagnosed. For a feature, read the *entire* design file(s) for that
   feature — they're written to be detailed design docs, not just
   one-liners, and skipping straight to code will miss authority/network/
   persistence decisions already made in the doc.
4. **Implement**, following this project's normal engineering standards —
   use the matching `*_creation` skill if the feature is a new plugin of a
   type one exists for (puzzle, minigame, rules package, map renderer,
   asset importer, scripted entity, cypher), write/run tests per this
   project's test conventions, and don't invent new architecture the
   design doc didn't call for.
5. **Mark it done:**
   - **Bug:** flip `- [ ]` to `- [x]` on that line. If you learned
     something worth keeping (root cause, a gotcha), add an indented
     sub-bullet under the item rather than deleting the line once checked
     — this mirrors the project's existing troubleshooting-log convention
     of never discarding diagnostic history.
   - **Feature:** move the file (dropping any `[WIP]` tag) from
     `Planned Features/` into `requirements/Completed/`, and delete its row
     from `FEATURE_PRIORITY.md`. If only part of a multi-file design area
     is actually finished, move only the finished section file(s) out —
     leave the rest of that area's files (and its index file, if any) in
     place, and only delete that one item's row from
     `FEATURE_PRIORITY.md`, not the whole area's.
   - If you only got partway through a feature, tag it `[WIP] ` in place
     (adding the tag if it was untagged) rather than moving or leaving it
     unmarked, so the next backlog pass picks it up as in-progress instead
     of re-triaging it as new. Leave its `FEATURE_PRIORITY.md` row as-is
     (or add one if it was missing).
6. **Report** what changed: which file(s) got marked/moved, what's still
   open in that area if anything, and what you'd suggest picking up next
   per `FEATURE_PRIORITY.md` — don't just silently stop after one item
   unless the user asked for exactly one.

## Filename mechanics

Renames and moves should preserve git history where the file is tracked —
prefer `git mv "old name.md" "[WIP] old name.md"` or
`git mv "Planned Features/old name.md" "Completed/old name.md"` (or an
editor rename/move tracked by git) over delete+recreate. Bracket characters
are safe in Windows/NTFS and in git; no escaping needed beyond normal shell
quoting of the whole filename.
