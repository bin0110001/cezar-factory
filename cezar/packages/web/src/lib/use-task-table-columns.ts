import { useQueryClient } from '@tanstack/react-query'
import * as React from 'react'

import { putWorkspaceUiState } from '@/api/client'
import { useWorkspaceUiState, workspaceQueryKeys } from '@/api/queries'
import { toast } from '@/components/ui/toaster'
import type { WorkspaceUiState } from '@open-mercato/cezar-api-client'
import {
  isColumnExpanded,
  normalizeExpandedColumns,
  TASK_COLUMNS,
  toggleExpandedColumn,
  type NormalizedExpandedColumns,
  type TaskColumnId,
} from './task-columns'
import type { TaskSortState } from './tasks-table'

const TASK_SORT_STORAGE_KEY = 'cezar.tasks.table.sort'
const DEFAULT_TASK_SORT: TaskSortState = { column: 'started', direction: 'desc' }

function readTaskSort(): TaskSortState {
  if (typeof window === 'undefined') return DEFAULT_TASK_SORT
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(TASK_SORT_STORAGE_KEY) ?? 'null')
    if (parsed === null || typeof parsed !== 'object') return DEFAULT_TASK_SORT
    const value = parsed as Partial<TaskSortState>
    const column = TASK_COLUMNS.find((item) => item.id === value.column)
    return column && (!('sortable' in column) || column.sortable !== false) &&
      (value.direction === 'asc' || value.direction === 'desc')
      ? { column: value.column!, direction: value.direction }
      : DEFAULT_TASK_SORT
  } catch {
    return DEFAULT_TASK_SORT
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/**
 * Session-global controller for desktop Tasks-table density. Reads the shared workspace query,
 * composes every click from its optimistic cache, and serializes bounded keepalive writes so an
 * older response can never resurrect stale column state.
 */
export function useTaskTableColumns(): {
  expandedColumns: NormalizedExpandedColumns
  isExpanded: (id: TaskColumnId) => boolean
  toggleColumn: (id: TaskColumnId) => void
  isPending: boolean
  sort: TaskSortState
  setSort: (sort: TaskSortState) => void
} {
  const queryClient = useQueryClient()
  const uiState = useWorkspaceUiState()
  const sequence = React.useRef(0)
  const newestSequence = React.useRef(0)
  const writeChain = React.useRef<Promise<void>>(Promise.resolve())
  const [sort, setSortState] = React.useState<TaskSortState>(readTaskSort)

  const expandedColumns = React.useMemo(
    () => normalizeExpandedColumns(uiState.data?.taskTable?.expandedColumns),
    [uiState.data?.taskTable?.expandedColumns],
  )
  const setSort = React.useCallback((next: TaskSortState) => {
    setSortState(next)
    try {
      window.localStorage.setItem(TASK_SORT_STORAGE_KEY, JSON.stringify(next))
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), { tone: 'danger' })
    }
  }, [])

  const toggleColumn = React.useCallback(
    (id: TaskColumnId) => {
      if (!TASK_COLUMNS.find((column) => column.id === id)?.canFold) return

      const current = queryClient.getQueryData<WorkspaceUiState>(workspaceQueryKeys.uiState)
      // A shallow taskTable write can only preserve forward-compatible siblings after the
      // authoritative GET has populated the cache. The route also disables its controls while
      // this is undefined, but keep the controller safe for every caller and failed-query path.
      if (current === undefined) return
      const currentTaskTable = asRecord(current?.taskTable)
      const taskTable = {
        ...currentTaskTable,
        expandedColumns: toggleExpandedColumn(currentTaskTable.expandedColumns, id),
      }
      queryClient.setQueryData<WorkspaceUiState>(workspaceQueryKeys.uiState, {
        ...current,
        taskTable,
      })

      const writeSequence = ++sequence.current
      newestSequence.current = writeSequence
      const write = writeChain.current.then(async () => {
        const merged = await putWorkspaceUiState({ taskTable }, { keepalive: true })
        if (writeSequence === newestSequence.current) {
          queryClient.setQueryData<WorkspaceUiState>(workspaceQueryKeys.uiState, merged)
        }
      })
      writeChain.current = write.catch((error: unknown) => {
        toast(error instanceof Error ? error.message : String(error), { tone: 'danger' })
        if (writeSequence === newestSequence.current) {
          void queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.uiState })
        }
      })
    },
    [queryClient],
  )

  const isExpanded = React.useCallback(
    (id: TaskColumnId) => isColumnExpanded(id, expandedColumns),
    [expandedColumns],
  )

  return { expandedColumns, isExpanded, toggleColumn, isPending: uiState.isPending, sort, setSort }
}
