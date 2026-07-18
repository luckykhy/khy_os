import { ref } from 'vue'
import request from '@/api/request'
import { unwrap } from '@/api/unwrap'

/**
 * Composable for AI Gateway admin state.
 */
export function useGateway() {
  const status = ref(null)
  const pool = ref(null)
  const config = ref(null)
  const modelCatalog = ref([])
  const catalogEdges = ref([])
  const catalogSources = ref(null)
  const slots = ref(null)
  const protocols = ref([])
  const plugins = ref([])
  const oauth = ref(null)
  const oauthProviders = ref([])
  const tls = ref(null)
  const loading = ref(false)
  const modelSlots = ref(null)
const imageConfig = ref(null)

  async function fetchStatus() {
    try {
      loading.value = true
      const res = await request.get('/api/ai-gateway/status')
      status.value = unwrap(res)
    } catch { /* ignore */ } finally { loading.value = false }
  }

  async function fetchPool() {
    try {
      const res = await request.get('/api/ai-gateway/pool')
      pool.value = unwrap(res)
    } catch { /* ignore */ }
  }

  async function fetchConfig() {
    try {
      const res = await request.get('/api/ai-gateway/config')
      config.value = unwrap(res)
    } catch { /* ignore */ }
  }

  async function fetchSlots() {
    try {
      const res = await request.get('/api/ai-gateway/slots')
      slots.value = unwrap(res)
    } catch { /* ignore */ }
  }

  async function fetchModelCatalog() {
    try {
      const res = await request.get('/api/ai-gateway/models')
      modelCatalog.value = unwrap(res) || []
    } catch { /* ignore */ }
  }

  // Unified multi-pivot catalog: the single joined edge list (providers + keys +
  // env maps + image/video namespaces). Powers every "by-*" view; see
  // composables/useModelPivots.js for the client-side grouping.
  async function fetchCatalog() {
    try {
      const res = await request.get('/api/ai-gateway/catalog')
      const payload = unwrap(res) || {}
      catalogEdges.value = Array.isArray(payload.edges) ? payload.edges : []
      catalogSources.value = payload.sources || null
    } catch { catalogEdges.value = []; catalogSources.value = null }
  }

  async function fetchProtocols() {
    try {
      const res = await request.get('/api/ai-gateway/protocols')
      protocols.value = unwrap(res).protocols || []
    } catch { /* ignore */ }
  }

  async function fetchPlugins() {
    try {
      const res = await request.get('/api/ai-gateway/plugins')
      plugins.value = unwrap(res)
    } catch { /* ignore */ }
  }

  async function fetchOAuth() {
    try {
      const res = await request.get('/api/ai-gateway/oauth/status')
      oauth.value = unwrap(res)
    } catch { /* ignore */ }
  }

  async function fetchOAuthProviders() {
    try {
      const res = await request.get('/api/ai-gateway/oauth/providers')
      const payload = unwrap(res) || {}
      oauthProviders.value = Array.isArray(payload.providers) ? payload.providers : []
      if (payload.status && typeof payload.status === 'object') {
        oauth.value = payload.status
      }
      return payload
    } catch {
      oauthProviders.value = []
      return null
    }
  }

  async function fetchTls() {
    try {
      const res = await request.get('/api/ai-gateway/tls/status')
      tls.value = unwrap(res)
    } catch { /* ignore */ }
  }

  async function togglePlugin(name, enabled) {
    await request.post(`/api/ai-gateway/plugins/${name}/toggle`, { enabled })
    await fetchPlugins()
  }

  async function refreshOAuth(provider) {
    await request.post(`/api/ai-gateway/oauth/${provider}/refresh`)
    await Promise.all([fetchOAuth(), fetchOAuthProviders()])
  }

  async function fetchOAuthCredential(provider) {
    const res = await request.get(`/api/ai-gateway/oauth/credentials/${provider}`)
    return unwrap(res)
  }

  async function saveOAuthCredentials(provider, payload) {
    const res = await request.put(`/api/ai-gateway/oauth/credentials/${provider}`, payload)
    await Promise.all([fetchOAuth(), fetchOAuthProviders()])
    return unwrap(res)
  }

  async function deleteOAuthCredentials(provider) {
    await request.delete(`/api/ai-gateway/oauth/credentials/${provider}`)
    await Promise.all([fetchOAuth(), fetchOAuthProviders()])
  }

  async function startTls(opts = {}) {
    await request.post('/api/ai-gateway/tls/start', opts)
    await fetchTls()
  }

  async function stopTls() {
    await request.post('/api/ai-gateway/tls/stop')
    await fetchTls()
  }

  async function addPoolKey(provider, keyData) {
    const res = await request.post(`/api/ai-gateway/pool/${provider}/keys`, keyData)
    await fetchPool()
    return unwrap(res)
  }

  async function removePoolKey(provider, keyId) {
    await request.delete(`/api/ai-gateway/pool/${provider}/keys/${keyId}`)
    await fetchPool()
  }

  async function updatePoolKey(provider, keyId, updates) {
    const res = await request.put(`/api/ai-gateway/pool/${provider}/keys/${keyId}`, updates)
    await fetchPool()
    return unwrap(res)
  }

  async function updateConfig(payload) {
    const res = await request.put('/api/ai-gateway/config', payload)
    await fetchConfig()
    return unwrap(res)
  }

  // ── Claude Code Model Slots ──

  async function fetchModelSlots() {
    try {
      const res = await request.get('/api/ai-gateway/model-slots')
      modelSlots.value = unwrap(res)
    } catch { /* ignore */ }
  }

  async function updateModelSlots(payload) {
    const res = await request.put('/api/ai-gateway/model-slots', payload)
    await fetchModelSlots()
    return unwrap(res)
  }

  // ── Image-generation model selection ──

  async function fetchImageConfig() {
    try {
      const res = await request.get('/api/ai-gateway/image-config')
      imageConfig.value = unwrap(res)
    } catch { /* ignore */ }
  }

  async function updateImageConfig(payload) {
    const res = await request.put('/api/ai-gateway/image-config', payload)
    await fetchImageConfig()
    return unwrap(res)
  }

  // ── Plugin CRUD ──

  async function fetchPluginCode(name) {
    const res = await request.get(`/api/ai-gateway/plugins/${name}/code`)
    return unwrap(res).code
  }

  async function createPlugin(name, code) {
    const res = await request.post('/api/ai-gateway/plugins', { name, code })
    await fetchPlugins()
    return unwrap(res)
  }

  async function updatePlugin(name, code) {
    const res = await request.put(`/api/ai-gateway/plugins/${name}`, { code })
    await fetchPlugins()
    return unwrap(res)
  }

  async function deletePlugin(name) {
    await request.delete(`/api/ai-gateway/plugins/${name}`)
    await fetchPlugins()
  }

  async function validatePlugin(code) {
    const res = await request.post('/api/ai-gateway/plugins/validate', { code })
    return unwrap(res)
  }

  async function fetchTemplate() {
    const res = await request.get('/api/ai-gateway/plugins/template')
    return unwrap(res).code
  }

  async function reloadPlugins() {
    const res = await request.post('/api/ai-gateway/plugins/reload')
    await fetchPlugins()
    return unwrap(res)
  }

  // ── Custom Providers (OpenAI-compatible) ──

  const customProviders = ref([])
  const customProviderPresets = ref([])

  async function fetchCustomProviders() {
    try {
      const res = await request.get('/api/ai-gateway/custom-providers')
      const payload = unwrap(res)
      customProviders.value = payload?.providers || []
      customProviderPresets.value = payload?.presets || []
    } catch { customProviders.value = []; customProviderPresets.value = [] }
  }

  async function addCustomProvider(payload) {
    const res = await request.post('/api/ai-gateway/custom-providers', payload)
    await Promise.all([fetchCustomProviders(), fetchPool()])
    return unwrap(res)
  }

  async function removeCustomProvider(poolKey, options = {}) {
    const qs = options.removeKeys ? '?removeKeys=true' : ''
    await request.delete(`/api/ai-gateway/custom-providers/${poolKey}${qs}`)
    await Promise.all([fetchCustomProviders(), fetchPool()])
  }

  async function replaceCustomProviderKey(poolKey, key) {
    const res = await request.put(`/api/ai-gateway/custom-providers/${poolKey}`, { key })
    await Promise.all([fetchCustomProviders(), fetchPool()])
    return unwrap(res)
  }

  // ── Model Curation (per-adapter overrides + verify) ──

  const modelOverrides = ref({})

  async function fetchModelOverrides() {
    try {
      const res = await request.get('/api/ai-gateway/model-overrides')
      modelOverrides.value = unwrap(res)?.overrides || {}
    } catch { modelOverrides.value = {} }
  }

  async function updateModelOverrides(adapter, patch) {
    const res = await request.put(`/api/ai-gateway/model-overrides/${adapter}`, patch)
    await Promise.all([fetchModelOverrides(), fetchModelCatalog()])
    return unwrap(res)
  }

  async function verifyAdapterModels(adapter, model = '') {
    const qs = model ? `?model=${encodeURIComponent(model)}` : ''
    const res = await request.post(`/api/ai-gateway/models/${adapter}/verify${qs}`)
    await fetchModelCatalog()
    return unwrap(res)
  }

  // ── Account Pool ──

  const accounts = ref([])

  async function fetchAccounts(provider = '') {
    try {
      const params = provider ? `?provider=${encodeURIComponent(provider)}` : ''
      const res = await request.get(`/api/ai-gateway/accounts${params}`)
      const payload = unwrap(res)
      accounts.value = payload?.accounts || payload || []
    } catch { accounts.value = [] }
  }

  async function usePoolAccount(provider, id) {
    const res = await request.post(`/api/ai-gateway/accounts/${provider}/use/${id}`)
    await fetchAccounts()
    return unwrap(res)
  }

  async function importAccounts(provider) {
    const res = await request.post(`/api/ai-gateway/accounts/${provider}/import`)
    await fetchAccounts()
    return unwrap(res)
  }

  async function removePoolAccount(id) {
    await request.delete(`/api/ai-gateway/accounts/${id}`)
    await fetchAccounts()
  }

  async function togglePoolAccount(id, enabled) {
    if (enabled) await request.post(`/api/ai-gateway/accounts/${id}/enable`)
    else await request.post(`/api/ai-gateway/accounts/${id}/disable`)
    await fetchAccounts()
  }

  async function unbanPoolAccount(id) {
    await request.post(`/api/ai-gateway/accounts/${id}/unban`)
    await fetchAccounts()
  }

  async function fetchAll() {
    await Promise.all([
      fetchStatus(),
      fetchPool(),
      fetchConfig(),
      fetchModelCatalog(),
      fetchCatalog(),
      fetchSlots(),
      fetchProtocols(),
      fetchPlugins(),
      fetchOAuth(),
      fetchOAuthProviders(),
      fetchModelSlots(),
      fetchImageConfig(),
      fetchTls(),
      fetchAccounts(),
      fetchCustomProviders(),
    ])
  }

  return {
    status, pool, config, modelCatalog, catalogEdges, catalogSources, modelSlots, imageConfig, slots, protocols, plugins, oauth, oauthProviders, tls, loading, accounts,
    customProviders, customProviderPresets, modelOverrides,
    fetchModelOverrides, updateModelOverrides, verifyAdapterModels,
    fetchStatus, fetchPool, fetchConfig, fetchModelCatalog, fetchCatalog, fetchModelSlots, fetchSlots, fetchProtocols, fetchPlugins, fetchOAuth, fetchOAuthProviders, fetchTls,
    togglePlugin, refreshOAuth, fetchOAuthCredential, saveOAuthCredentials, deleteOAuthCredentials, startTls, stopTls, addPoolKey, removePoolKey, updatePoolKey,
    updateConfig, updateModelSlots, fetchImageConfig, updateImageConfig,
    fetchPluginCode, createPlugin, updatePlugin, deletePlugin, validatePlugin, fetchTemplate, reloadPlugins,
    fetchAccounts, usePoolAccount, importAccounts, removePoolAccount, togglePoolAccount, unbanPoolAccount,
    fetchCustomProviders, addCustomProvider, removeCustomProvider, replaceCustomProviderKey,
    fetchAll,
  }
}
