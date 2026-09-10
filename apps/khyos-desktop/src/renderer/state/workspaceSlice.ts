import { createSlice } from '@reduxjs/toolkit'

export interface Task {
  id: string; title: string; workspacePath: string
  createdAt: number; updatedAt: number; archived: boolean
}

interface WorkspaceState {
  currentWorkspace: { kind: string; workspacePath: string; purpose: string } | null
  tasks: Task[]; archivedTasks: Task[]
  viewMode: 'grouped' | 'chronological'; sortBy: 'createdAt' | 'updatedAt'
  searchQuery: string; loading: boolean
}

const initialState: WorkspaceState = {
  currentWorkspace: null,
  tasks: [
    { id: 'sess_001', title: '实现登录功能', workspacePath: 'D:\\\\Portable\\\\khy-os', createdAt: Date.now() - 86400000, updatedAt: Date.now() - 3600000, archived: false },
    { id: 'sess_002', title: '修复终端渲染问题', workspacePath: 'D:\\\\Portable\\\\khy-os', createdAt: Date.now() - 172800000, updatedAt: Date.now() - 7200000, archived: false }
  ],
  archivedTasks: [], viewMode: 'grouped', sortBy: 'updatedAt', searchQuery: '', loading: false
}

const workspaceSlice = createSlice({
  name: 'workspace', initialState,
  reducers: {
    setViewMode: (state, action) => { state.viewMode = action.payload },
    setSortBy: (state, action) => { state.sortBy = action.payload },
    setSearchQuery: (state, action) => { state.searchQuery = action.payload },
    archiveTask: (state, action) => {
      const task = state.tasks.find(t => t.id === action.payload)
      if (task) { task.archived = true; state.archivedTasks.push({ ...task }); state.tasks = state.tasks.filter(t => t.id !== action.payload) }
    }
  }
})

export const { setViewMode, setSortBy, setSearchQuery, archiveTask } = workspaceSlice.actions
export default workspaceSlice.reducer
