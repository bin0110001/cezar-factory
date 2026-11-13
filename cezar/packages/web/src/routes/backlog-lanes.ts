/**
 * What each backlog lane is for, and which `factory:*` states in it have an automation that works them (the lane's
 * trigger labels). The trigger labels are the lane's `automated` states in `policies/lifecycle.json`; `backlog-lanes.test.ts`
 * fails when they drift (STABILIZATION-PLAN.md item 1.4f).
 */
export const LANE_WORK: Record<string, string> = {
  Inbox: 'intake and investigation',
  Backlog: 'triage',
  Refinement: 'planning',
  Ready: 'implementation',
  Active: 'in progress and requested fixes',
  Review: 'review',
  Done: 'complete',
}
export const LANE_TRIGGER_LABELS: Record<string, string[]> = {
  Inbox: ['factory:new', 'factory:investigate'],
  Backlog: [],
  Refinement: ['factory:needs-plan'],
  Ready: ['factory:ready'],
  Active: ['factory:changes-requested'],
  Review: ['factory:review'],
  Done: [],
}
