import { createSlice, PayloadAction } from '@reduxjs/toolkit'

export type ToolExecutionStatus = 'pending' | 'running' | 'success' | 'error' | 'cancelled'

export interface ToolExecution {
  id: string
  name: string
  input: Record<string, unknown>
  status: ToolExecutionStatus
  result?: string
  error?: string
  startedAt: number
  completedAt?: number
  affectedFiles?: string[]
  requiresConfirmation: boolean
}

interface ToolExecutionState {
  executions: ToolExecution[]
  activeIds: string[]
  history: ToolExecution[]
  /** 本轮被编辑类工具改过的文件（去重）；P2 的 DiffSummary 数据源 */
  affectedFiles: string[]
}

const initialState: ToolExecutionState = {
  executions: [],
  activeIds: [],
  history: [],
  affectedFiles: [],
}

const toolExecutionSlice = createSlice({
  name: 'toolExecution',
  initialState,
  reducers: {
    startToolExecution: (state, action: PayloadAction<Omit<ToolExecution, 'status' | 'startedAt'>>) => {
      const execution: ToolExecution = { ...action.payload, status: 'running', startedAt: Date.now() }
      state.executions.push(execution)
      state.activeIds.push(execution.id)
    },
    updateToolExecution: (state, action: PayloadAction<{ id: string; status: ToolExecutionStatus; result?: string; error?: string }>) => {
      const { id, status, result, error } = action.payload
      const execution = state.executions.find(e => e.id === id)
      if (execution) {
        execution.status = status
        if (result !== undefined) execution.result = result
        if (error !== undefined) execution.error = error
        if (status === 'success' || status === 'error' || status === 'cancelled') {
          execution.completedAt = Date.now()
          state.activeIds = state.activeIds.filter(aid => aid !== id)
          state.history.unshift(execution)
          if (state.history.length > 50) state.history.pop()
        }
      }
    },
    cancelToolExecution: (state, action: PayloadAction<string>) => {
      const execution = state.executions.find(e => e.id === action.payload)
      if (execution) {
        execution.status = 'cancelled'
        execution.completedAt = Date.now()
        state.activeIds = state.activeIds.filter(aid => aid !== action.payload)
      }
    },
    recordAffectedFiles: (state, action: PayloadAction<string[]>) => {
      for (const f of action.payload) {
        if (f && !state.affectedFiles.includes(f)) state.affectedFiles.push(f)
      }
    },
    clearExecutions: (state) => {
      state.executions = []
      state.activeIds = []
      state.affectedFiles = []
    },
    clearHistory: (state) => {
      state.history = []
    },
  },
})

export const {
  startToolExecution, updateToolExecution, cancelToolExecution,
  recordAffectedFiles, clearExecutions, clearHistory,
} = toolExecutionSlice.actions

export default toolExecutionSlice.reducer
