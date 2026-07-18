<template>
  <div class="api-key-manager">
    <h2>API Key Management</h2>
    <p class="subtitle">Generate, rotate, and revoke API keys for external integrations</p>

    <!-- Current Key Status -->
    <section class="key-card">
      <div class="key-header">
        <h3>Current API Key</h3>
        <el-tag v-if="currentKey" type="success" size="small">Active</el-tag>
        <el-tag v-else type="info" size="small">No Key</el-tag>
      </div>

      <!-- Full key display (only after generate/refresh) -->
      <div v-if="fullKey" class="full-key-display">
        <el-alert type="warning" :closable="false" show-icon>
          <template #title>Copy this key now — it will not be shown again in full</template>
        </el-alert>
        <div class="key-row">
          <code class="key-value">{{ fullKey }}</code>
          <el-button size="small" type="primary" @click="copyKey">
            {{ copied ? 'Copied' : 'Copy' }}
          </el-button>
        </div>
      </div>

      <!-- Masked key info (from /current endpoint) -->
      <div v-else-if="currentKey" class="key-info">
        <div class="info-row">
          <span class="info-label">Prefix:</span>
          <code>{{ currentKey.keyPrefix }}...</code>
        </div>
        <div class="info-row">
          <span class="info-label">Label:</span>
          <span>{{ currentKey.label }}</span>
        </div>
        <div class="info-row">
          <span class="info-label">Created:</span>
          <span>{{ formatDate(currentKey.createdAt) }}</span>
        </div>
        <div class="info-row">
          <span class="info-label">Last Used:</span>
          <span>{{ currentKey.lastUsedAt ? formatDate(currentKey.lastUsedAt) : 'Never' }}</span>
        </div>
      </div>

      <div v-else class="no-key">
        No active API key. Generate one to use the external signal API.
      </div>
    </section>

    <!-- Actions -->
    <section class="actions">
      <el-button type="primary" :loading="loading" @click="generateKey">
        Generate New Key
      </el-button>
      <el-button type="warning" :loading="loading" :disabled="!currentKey" @click="refreshKey">
        Refresh Key
      </el-button>
      <el-button type="danger" :loading="loading" :disabled="!currentKey" @click="confirmRevoke">
        Revoke Key
      </el-button>
    </section>

    <!-- Usage example -->
    <section class="usage-card">
      <h3>Usage</h3>
      <pre class="code-block"># Submit a signal using your API key (no JWT needed)
curl -X POST {{ baseUrl }}/api/external/signal \
  -H "Content-Type: application/json" \
  -H "X-API-Key: khy_your_key_here" \
  -d '{"symbol":"600519","signal":"BUY","price":1800,"confidence":0.92}'</pre>
    </section>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import request from '@/utils/request'

const baseUrl = computed(() => window.location.origin)
const loading = ref(false)
const currentKey = ref(null)
const fullKey = ref('')
const copied = ref(false)

function formatDate(dateStr) {
  if (!dateStr) return ''
  return new Date(dateStr).toLocaleString()
}

async function copyKey() {
  try {
    await navigator.clipboard.writeText(fullKey.value)
    copied.value = true
    ElMessage.success('API key copied to clipboard')
    setTimeout(() => { copied.value = false }, 3000)
  } catch {
    ElMessage.error('Copy failed — select the key manually')
  }
}

async function fetchCurrent() {
  try {
    const res = await request({ url: '/api-keys/current', method: 'get' })
    currentKey.value = res.success ? res.data : null
  } catch {
    currentKey.value = null
  }
}

async function generateKey() {
  loading.value = true
  fullKey.value = ''
  try {
    const res = await request({ url: '/api-keys/generate', method: 'post' })
    if (res.success) {
      fullKey.value = res.data.key
      currentKey.value = res.data
      ElMessage.success('API key generated')
    } else {
      ElMessage.error(res.message || 'Generation failed')
    }
  } catch (e) {
    ElMessage.error(e.response?.data?.message || e.message)
  } finally {
    loading.value = false
  }
}

async function refreshKey() {
  loading.value = true
  fullKey.value = ''
  try {
    const res = await request({ url: '/api-keys/refresh', method: 'post' })
    if (res.success) {
      fullKey.value = res.data.key
      currentKey.value = res.data
      ElMessage.success('API key refreshed — old key is now revoked')
    } else {
      ElMessage.error(res.message || 'Refresh failed')
    }
  } catch (e) {
    ElMessage.error(e.response?.data?.message || e.message)
  } finally {
    loading.value = false
  }
}

async function confirmRevoke() {
  try {
    await ElMessageBox.confirm(
      'This will permanently disable your current API key. Any scripts using it will stop working.',
      'Revoke API Key',
      { confirmButtonText: 'Revoke', cancelButtonText: 'Cancel', type: 'warning' }
    )
    await revokeKey()
  } catch {
    // User cancelled
  }
}

async function revokeKey() {
  loading.value = true
  fullKey.value = ''
  try {
    const res = await request({ url: '/api-keys/revoke', method: 'post' })
    if (res.success) {
      currentKey.value = null
      ElMessage.success('API key revoked')
    } else {
      ElMessage.error(res.message || 'Revocation failed')
    }
  } catch (e) {
    ElMessage.error(e.response?.data?.message || e.message)
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  fetchCurrent()
})
</script>

<style scoped>
.api-key-manager {
  max-width: 700px;
  margin: 0 auto;
  padding: 24px;
}
.subtitle {
  color: #909399;
  margin-bottom: 24px;
}
.key-card, .usage-card {
  background: #fafafa;
  border: 1px solid #ebeef5;
  border-radius: 8px;
  padding: 20px;
  margin-bottom: 20px;
}
.key-header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
}
.key-header h3 {
  margin: 0;
}
.full-key-display {
  margin-top: 12px;
}
.key-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 12px;
  padding: 12px;
  background: #fff;
  border: 1px dashed #e6a23c;
  border-radius: 4px;
}
.key-value {
  flex: 1;
  word-break: break-all;
  font-size: 13px;
  color: #303133;
}
.key-info {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.info-row {
  display: flex;
  gap: 8px;
}
.info-label {
  color: #909399;
  min-width: 80px;
}
.no-key {
  color: #909399;
  font-style: italic;
}
.actions {
  display: flex;
  gap: 12px;
  margin-bottom: 20px;
}
.usage-card h3 {
  margin: 0 0 12px;
}
.code-block {
  background: #1e1e1e;
  color: #d4d4d4;
  padding: 16px;
  border-radius: 6px;
  font-size: 13px;
  line-height: 1.6;
  overflow-x: auto;
  white-space: pre-wrap;
  margin: 0;
}
</style>
