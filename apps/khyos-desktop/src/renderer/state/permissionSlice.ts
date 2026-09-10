import { createSlice, PayloadAction } from '@reduxjs/toolkit'

/**
 * Permission levels for agent actions.
 * Maps to ZCode's mode system (§7.3 of DESIGN-ARCH-092).
 *
 * - default: Ask before high-risk operations
 * - plan: Plan first, confirm before executing
 * - acceptEdits: Auto-accept file edits
 * - dontAsk: Skip routine confirmations
 * - bypassPermissions: Skip all permission checks (dangerous)
 */
export type PermissionMode = 'default' | 'plan' | 'acceptEdits' | 'dontAsk' | 'bypassPermissions'

export type ToolRiskLevel = 'low' | 'medium' | 'high' | 'critical'

export interface ToolPermission {
  toolName: string
  riskLevel: ToolRiskLevel
  description: string
}

interface PermissionState {
  mode: PermissionMode
  provider: string
  /** Per-tool overrides: toolName -> 'allow' | 'ask' | 'deny' */
  toolOverrides: Record<string, 'allow' | 'ask' | 'deny'>
  /** Tools currently pending user confirmation */
  pendingConfirmations: ToolPermission[]
  /** Whether the agent is currently executing with elevated permissions */
  elevatedSession: boolean
}

const initialState: PermissionState = {
  mode: 'default',
  provider: 'glm',
  toolOverrides: {},
  pendingConfirmations: [],
  elevatedSession: false,
}

const permissionSlice = createSlice({
  name: 'permission',
  initialState,
  reducers: {
    setMode: (state, action: PayloadAction<PermissionMode>) => {
      state.mode = action.payload
      // Clear pending confirmations when mode changes
      state.pendingConfirmations = []
    },
    setProvider: (state, action: PayloadAction<string>) => {
      state.provider = action.payload
    },
    setToolOverride: (state, action: PayloadAction<{ toolName: string; decision: 'allow' | 'ask' | 'deny' }>) => {
      const { toolName, decision } = action.payload
      if (decision === 'ask') {
        delete state.toolOverrides[toolName]
      } else {
        state.toolOverrides[toolName] = decision
      }
    },
    clearToolOverride: (state, action: PayloadAction<string>) => {
      delete state.toolOverrides[action.payload]
    },
    addPendingConfirmation: (state, action: PayloadAction<ToolPermission>) => {
      const exists = state.pendingConfirmations.find(p => p.toolName === action.payload.toolName)
      if (!exists) {
        state.pendingConfirmations.push(action.payload)
      }
    },
    resolveConfirmation: (state, action: PayloadAction<{ toolName: string; allowed: boolean }>) => {
      const { toolName } = action.payload
      state.pendingConfirmations = state.pendingConfirmations.filter(p => p.toolName !== toolName)
    },
    setElevatedSession: (state, action: PayloadAction<boolean>) => {
      state.elevatedSession = action.payload
    },
  },
})

export const {
  setMode,
  setProvider,
  setToolOverride,
  clearToolOverride,
  addPendingConfirmation,
  resolveConfirmation,
  setElevatedSession,
} = permissionSlice.actions

export default permissionSlice.reducer
