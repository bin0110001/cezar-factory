import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LANE_TRIGGER_LABELS } from './backlog-lanes'

interface PolicyState { kind: string; lane?: string }
const policyPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../policies/lifecycle.json')
const states = (JSON.parse(readFileSync(policyPath, 'utf8')) as { profiles: { standard: { states: Record<string, PolicyState> } } }).profiles.standard.states

describe('backlog lanes agree with the Factory lifecycle policy', () => {
  it('lists, for every lane, exactly the automated states the policy puts in it', () => {
    const lanes = new Set(Object.values(states).flatMap((state) => (state.lane ? [state.lane] : [])))
    for (const lane of new Set([...lanes, ...Object.keys(LANE_TRIGGER_LABELS)])) {
      const automated = Object.entries(states).filter(([, state]) => state.lane === lane && state.kind === 'automated').map(([label]) => label)
      expect([...(LANE_TRIGGER_LABELS[lane] ?? [])].sort(), `lane ${lane}`).toEqual(automated.sort())
    }
  })
})
