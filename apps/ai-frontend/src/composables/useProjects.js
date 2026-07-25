import { ref } from 'vue'
import request from '@/api/request'
import { unwrap } from '@/api/unwrap'

/**
 * Per-user coding projects state ("项目工作区").
 *
 * Talks to `/api/ai/projects/*`: named multi-folder workspaces aligning to Hermes
 * v0.18.0 desktop coding projects. Mirrors `useProxies`: shared `unwrap(res)`
 * envelope handling (from `@/api/unwrap`) and ref-backed state. Everything is
 * scoped to the logged-in user on the backend (where:{userId}).
 *
 * `activeProjectId` is the current workspace filter, persisted in localStorage so
 * the chosen project survives reloads. null = "全部" (all conversations visible).
 * The chat sidebar reads it to filter history and to stamp new conversations.
 */

const ACTIVE_KEY = 'khy.activeProjectId'

function readActive() {
  try {
    const raw = localStorage.getItem(ACTIVE_KEY)
    if (raw == null || raw === '') return null
    const n = Number(raw)
    return Number.isInteger(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

function writeActive(id) {
  try {
    if (id == null) localStorage.removeItem(ACTIVE_KEY)
    else localStorage.setItem(ACTIVE_KEY, String(id))
  } catch {
    /* private mode / storage disabled → in-memory only */
  }
}

// Shared across composable instances so the sidebar selector and the projects
// view agree on the active workspace without prop-drilling.
const activeProjectId = ref(readActive())

export function useProjects() {
  const projects = ref([])
  const loading = ref(false)
  const busy = ref(false)

  // List the caller's projects. Pass { includeArchived:true } for the management
  // toggle; default hides archived rows.
  async function list(options = {}) {
    loading.value = true
    try {
      const url = options.includeArchived
        ? '/api/ai/projects?includeArchived=1'
        : '/api/ai/projects'
      const res = await request.get(url)
      const data = unwrap(res)
      projects.value = Array.isArray(data) ? data : []
      return projects.value
    } finally {
      loading.value = false
    }
  }

  async function get(id) {
    const res = await request.get(`/api/ai/projects/${id}`)
    return unwrap(res)
  }

  // Create a project. body: { name, description, icon, color, primaryPath, folders }.
  async function create(body) {
    busy.value = true
    try {
      const res = await request.post('/api/ai/projects', body || {})
      await list()
      return unwrap(res)
    } finally {
      busy.value = false
    }
  }

  async function update(id, body) {
    busy.value = true
    try {
      const res = await request.put(`/api/ai/projects/${id}`, body || {})
      await list()
      return unwrap(res)
    } finally {
      busy.value = false
    }
  }

  async function remove(id) {
    await request.delete(`/api/ai/projects/${id}`)
    // If the removed project was active, fall back to "全部".
    if (activeProjectId.value === Number(id)) setActiveProject(null)
    await list()
  }

  // Archive / restore. archived=false restores; default archives.
  async function archive(id, archived = true) {
    busy.value = true
    try {
      const res = await request.post(`/api/ai/projects/${id}/archive`, { archived })
      await list()
      return unwrap(res)
    } finally {
      busy.value = false
    }
  }

  // Set the active workspace filter (null = 全部). Persisted to localStorage.
  function setActiveProject(id) {
    const norm = id == null ? null : Number(id)
    activeProjectId.value = Number.isInteger(norm) && norm > 0 ? norm : null
    writeActive(activeProjectId.value)
  }

  return {
    projects, loading, busy, activeProjectId,
    list, get, create, update, remove, archive, setActiveProject,
  }
}
