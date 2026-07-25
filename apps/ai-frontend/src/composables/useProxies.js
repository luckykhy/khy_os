import { ref } from 'vue'
import request from '@/api/request'
import { unwrap } from '@/api/unwrap'

/**
 * Per-user proxy subscription state ("代理管理").
 *
 * Talks to `/api/proxy-subscriptions/*`: paste a subscription URL → the backend
 * fetches it (through an SSRF guard), decodes + parses the proxy nodes, and
 * stores them as a subscription group (订阅组). Mirrors `useMarketplace`: shared
 * `unwrap(res)` envelope handling (from `@/api/unwrap`) and ref-backed state.
 * Everything is scoped to the logged-in user on the backend.
 */

export function useProxies() {
  const groups = ref([])
  const loading = ref(false)
  const busy = ref(false)
  // 出站状态(选节点实际路由 + 启用/停用开关)。additive:不影响订阅浏览。
  const egressStatus = ref(null)

  // List the caller's subscription groups (summary — no node detail).
  async function listGroups() {
    loading.value = true
    try {
      const res = await request.get('/api/proxy-subscriptions')
      const data = unwrap(res)
      groups.value = Array.isArray(data?.subscriptions) ? data.subscriptions : (Array.isArray(data) ? data : [])
      return groups.value
    } finally {
      loading.value = false
    }
  }

  // Fetch a single group WITH its parsed nodes.
  async function getGroup(id) {
    const res = await request.get(`/api/proxy-subscriptions/${id}`)
    return unwrap(res)
  }

  // Add a subscription group from a URL. Returns the created group.
  async function addSubscription(url, name) {
    busy.value = true
    try {
      const res = await request.post('/api/proxy-subscriptions', { url, name: name || undefined })
      await listGroups()
      return unwrap(res)
    } finally {
      busy.value = false
    }
  }

  // Add a subscription group from raw content (clipboard / file import). No fetch,
  // no SSRF surface — the backend parses the text directly.
  async function addByContent(content, name) {
    busy.value = true
    try {
      const res = await request.post('/api/proxy-subscriptions', { content, name: name || undefined })
      await listGroups()
      return unwrap(res)
    } finally {
      busy.value = false
    }
  }

  // Re-fetch a group and refresh its nodes.
  async function refreshGroup(id) {
    busy.value = true
    try {
      const res = await request.post(`/api/proxy-subscriptions/${id}/refresh`, {})
      await listGroups()
      return unwrap(res)
    } finally {
      busy.value = false
    }
  }

  async function removeGroup(id) {
    await request.delete(`/api/proxy-subscriptions/${id}`)
    await listGroups()
  }

  // ── 出站桥(/api/proxy-egress):选节点实际路由 + 启用/停用 ──────────────
  // 当前出站状态:enabled/activeNode/coreStatus(附内核是否装、是否在跑)。
  async function fetchEgressStatus() {
    const res = await request.get('/api/proxy-egress')
    egressStatus.value = unwrap(res)
    return egressStatus.value
  }

  // 用选中节点激活真实出站。传**整个节点对象**(clash-native 字段)。返回结构化结果:
  // { success, egressMode, reason?, guidance?, mixedPort? }——core-required 内核缺失时
  // success=false 且带 guidance(绝不谎报生效),调用方须显式提示,不静默。
  async function enableNode(node, mixedPort) {
    busy.value = true
    try {
      const body = { node }
      if (mixedPort) body.mixedPort = mixedPort
      const res = await request.post('/api/proxy-egress/enable', body)
      const result = unwrap(res)
      await fetchEgressStatus()
      return result
    } finally {
      busy.value = false
    }
  }

  // 停用出站(清 env + 停内核)。
  async function disableEgress() {
    busy.value = true
    try {
      const res = await request.post('/api/proxy-egress/disable', {})
      const result = unwrap(res)
      await fetchEgressStatus()
      return result
    } finally {
      busy.value = false
    }
  }

  return {
    groups, loading, busy, egressStatus,
    listGroups, getGroup, addSubscription, addByContent, refreshGroup, removeGroup,
    fetchEgressStatus, enableNode, disableEgress,
  }
}
