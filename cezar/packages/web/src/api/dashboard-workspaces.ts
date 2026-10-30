import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { cez, unwrap } from './client'
import { workspaceQueryKeys } from './queries'

export const workspaceLifecycleKey = [...workspaceQueryKeys.dashboard, 'workspaces'] as const

export async function getWorkspaceLifecycle(signal?: AbortSignal) {
  return unwrap(
    await cez.api.v1.workspace.dashboard.workspaces.$get({}, { init: { signal } }),
    '/workspace/dashboard/workspaces',
  )
}

export function useWorkspaceLifecycle(enabled = true) {
  return useQuery({
    queryKey: workspaceLifecycleKey,
    queryFn: ({ signal }) => getWorkspaceLifecycle(signal),
    enabled,
    refetchInterval: 30_000,
    retry: false,
  })
}

export async function runWorkspaceLifecycleAction(input: {
  projectId: string
  issue: string
  action: 'recover' | 'validate' | 'prune' | 'resume'
  force?: boolean
}) {
  return unwrap(
    await cez.api.v1.workspace.dashboard.workspaces.action.$post({
      json: { ...input, confirm: true },
    }),
    '/workspace/dashboard/workspaces/action',
  )
}

export function useWorkspaceLifecycleAction() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: runWorkspaceLifecycleAction,
    onSuccess: (result) => {
      queryClient.setQueryData(workspaceLifecycleKey, result.projects)
    },
  })
}
