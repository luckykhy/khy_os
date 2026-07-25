import { defineStore } from 'pinia'
import request from '@/api/request'

const USER_STORAGE_KEY = 'khy_ai_user'
const WORKSPACE_STORAGE_KEY = 'khy_ai_workspace'

function safeParseJson(raw, fallback = null) {
  if (!raw || typeof raw !== 'string') return fallback
  try {
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

function normalizeRole(user) {
  const role = String(user?.role || '').trim().toLowerCase()
  return role === 'admin' ? 'admin' : 'user'
}

function normalizeWorkspace(next, isAdmin) {
  if (!isAdmin) return 'user'
  return next === 'admin' ? 'admin' : 'user'
}

export const useUserStore = defineStore('user', {
  state: () => {
    const storedUser = safeParseJson(localStorage.getItem(USER_STORAGE_KEY), null)
    const role = normalizeRole(storedUser)
    const storedWorkspace = String(localStorage.getItem(WORKSPACE_STORAGE_KEY) || '').trim()
    return {
      token: localStorage.getItem('token') || '',
      user: storedUser,
      workspace: normalizeWorkspace(storedWorkspace || 'user', role === 'admin'),
    }
  },
  getters: {
    role: (state) => normalizeRole(state.user),
    isAdmin: (state) => normalizeRole(state.user) === 'admin',
    preferredHome(state) {
      if (normalizeRole(state.user) === 'admin' && state.workspace === 'admin') return '/dashboard'
      return '/home'
    },
  },
  actions: {
    async login(username, password) {
      const { data } = await request.post('/api/auth/login', { username, password })
      const payload = (data && typeof data.data === 'object' && data.data) ? data.data : data
      const token = String(payload?.token || '').trim()
      if (!token) throw new Error('登录响应缺少令牌')

      this.token = token
      this.user = payload?.user || null
      // Requirement: login starts in user view, even for admins.
      this.workspace = 'user'

      localStorage.setItem('token', token)
      localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(this.user || null))
      localStorage.setItem(WORKSPACE_STORAGE_KEY, this.workspace)
      return payload
    },
    async fetchProfile() {
      const { data } = await request.get('/api/auth/me')
      const payload = (data && typeof data.data === 'object' && data.data) ? data.data : data
      this.user = payload?.user || null
      localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(this.user || null))
      // Keep workspace legal for current role.
      this.workspace = normalizeWorkspace(this.workspace, this.isAdmin)
      localStorage.setItem(WORKSPACE_STORAGE_KEY, this.workspace)
      return this.user
    },
    async ensureSession() {
      if (!this.token) return false
      if (this.user) return true
      try {
        await this.fetchProfile()
        return true
      } catch {
        this.logout()
        return false
      }
    },
    setWorkspace(next) {
      const target = normalizeWorkspace(String(next || '').trim(), this.isAdmin)
      this.workspace = target
      localStorage.setItem(WORKSPACE_STORAGE_KEY, target)
      return target
    },
    toggleWorkspace() {
      if (!this.isAdmin) return this.setWorkspace('user')
      return this.setWorkspace(this.workspace === 'admin' ? 'user' : 'admin')
    },
    logout() {
      this.token = ''
      this.user = null
      this.workspace = 'user'
      localStorage.removeItem('token')
      localStorage.removeItem(USER_STORAGE_KEY)
      localStorage.removeItem(WORKSPACE_STORAGE_KEY)
    },
    isAuthenticated() {
      return !!this.token
    },
  },
})
