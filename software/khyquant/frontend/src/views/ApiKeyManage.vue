<template>
  <div class="api-key-page">
    <!-- Warning banner -->
    <el-alert
      type="warning"
      show-icon
      :closable="false"
      style="margin-bottom: 24px"
    >
      <template #title>
        API Key 等同于您的密码，请勿泄露给任何人！
      </template>
    </el-alert>

    <el-row :gutter="24">
      <!-- ============================================================ -->
      <!-- Card 1: API Key Management                                   -->
      <!-- ============================================================ -->
      <el-col :xs="24" :lg="14">
        <el-card shadow="never">
          <template #header>
            <div class="card-header">
              <span class="card-title">API Key 管理</span>
              <el-tag v-if="currentKey" type="success" size="small">已激活</el-tag>
              <el-tag v-else type="info" size="small">暂无密钥</el-tag>
            </div>
          </template>

          <!-- Full key (shown only after generate/refresh) -->
          <div v-if="fullKey" class="full-key-section">
            <el-alert type="warning" :closable="false" show-icon>
              <template #title>请立即复制密钥，完整密钥仅显示一次</template>
            </el-alert>
            <div class="key-display-row">
              <code class="full-key-text">{{ fullKey }}</code>
              <el-button size="small" type="primary" @click="copyFullKey">
                {{ copied ? '已复制' : '复制' }}
              </el-button>
            </div>
          </div>

          <!-- Masked key info -->
          <div v-else-if="currentKey" class="key-meta">
            <el-descriptions :column="1" border size="small">
              <el-descriptions-item label="密钥">
                <code class="masked-key">{{ currentKey.keyPrefix }}••••••••••••</code>
                <el-button size="small" text type="primary" @click="copyPrefix" style="margin-left: 8px">
                  复制前缀
                </el-button>
              </el-descriptions-item>
              <el-descriptions-item label="标签">{{ currentKey.label }}</el-descriptions-item>
              <el-descriptions-item label="创建时间">{{ fmtDate(currentKey.createdAt) }}</el-descriptions-item>
              <el-descriptions-item label="最后使用">
                {{ currentKey.lastUsedAt ? fmtDate(currentKey.lastUsedAt) : '从未使用' }}
              </el-descriptions-item>
            </el-descriptions>
          </div>

          <!-- No key -->
          <div v-else class="no-key-hint">
            暂无有效的 API Key。生成一个新的密钥来调用外部信号 API。
          </div>

          <!-- Action buttons -->
          <div class="btn-row">
            <el-button type="primary" :loading="keyLoading" @click="generateKey">
              生成新密钥
            </el-button>
            <el-button type="warning" :loading="keyLoading" :disabled="!currentKey" @click="refreshKey">
              刷新密钥
            </el-button>
            <el-button type="danger" :loading="keyLoading" :disabled="!currentKey" @click="confirmRevoke">
              吊销密钥
            </el-button>
          </div>

          <!-- Usage example -->
          <el-divider content-position="left">使用示例</el-divider>
          <pre class="code-block"># 使用 API Key 提交交易信号
curl -X POST {{ baseUrl }}/api/external/signal \
  -H "Content-Type: application/json" \
  -H "X-API-Key: khy_your_key_here" \
  -d '{"symbol":"600519","signal":"BUY","price":1800,"confidence":0.92}'</pre>
        </el-card>
      </el-col>

      <!-- ============================================================ -->
      <!-- Card 2: SendKey Binding                                      -->
      <!-- ============================================================ -->
      <el-col :xs="24" :lg="10">
        <el-card shadow="never">
          <template #header>
            <div class="card-header">
              <span class="card-title">微信推送（Server酱）</span>
              <el-tag v-if="sendKeyBound" type="success" size="small">
                <el-icon style="vertical-align: -2px"><Check /></el-icon> 已绑定
              </el-tag>
              <el-tag v-else type="danger" size="small">
                <el-icon style="vertical-align: -2px"><Close /></el-icon> 未绑定
              </el-tag>
            </div>
          </template>

          <p class="hint">
            绑定您的
            <a href="https://sct.ftqq.com" target="_blank" rel="noopener">Server酱</a>
            SendKey，实时接收微信交易信号推送。
          </p>

          <el-form label-width="90px" style="margin-top: 16px">
            <el-form-item label="SendKey">
              <el-input
                v-model="sendKeyInput"
                placeholder="SCT..."
                clearable
                show-password
              />
            </el-form-item>
            <el-form-item>
              <el-button type="primary" :loading="skLoading" @click="saveSendKey">
                绑定
              </el-button>
              <el-button
                v-if="sendKeyBound"
                type="danger"
                plain
                :loading="skLoading"
                @click="unbindSendKey"
              >
                解绑
              </el-button>
            </el-form-item>
          </el-form>

          <el-divider content-position="left">使用说明</el-divider>
          <ol class="steps-list">
            <li>前往 <a href="https://sct.ftqq.com" target="_blank">sct.ftqq.com</a> 注册并获取您的 SendKey。</li>
            <li>将 SendKey 粘贴到上方输入框，点击"绑定"。</li>
            <li>当交易信号产生时，系统将自动推送通知到您的微信。</li>
          </ol>
        </el-card>
      </el-col>
    </el-row>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Check, Close } from '@element-plus/icons-vue'
import request from '@/utils/request'

const baseUrl = computed(() => window.location.origin)

// ── API Key state ──
const keyLoading = ref(false)
const currentKey = ref(null)
const fullKey = ref('')
const copied = ref(false)

// ── SendKey state ──
const skLoading = ref(false)
const sendKeyBound = ref(false)
const sendKeyInput = ref('')

function fmtDate(d) {
  return d ? new Date(d).toLocaleString() : ''
}

// ── Clipboard helpers ──
async function copyToClipboard(text, label) {
  try {
    await navigator.clipboard.writeText(text)
    ElMessage.success(`${label}已复制`)
    return true
  } catch {
    ElMessage.error('复制失败')
    return false
  }
}

async function copyFullKey() {
  if (await copyToClipboard(fullKey.value, 'API Key ')) {
    copied.value = true
    setTimeout(() => { copied.value = false }, 3000)
  }
}

function copyPrefix() {
  if (currentKey.value?.keyPrefix) {
    copyToClipboard(currentKey.value.keyPrefix, '密钥前缀')
  }
}

// ── API Key CRUD ──
async function fetchCurrentKey() {
  try {
    const res = await request({ url: '/api-keys/current', method: 'get' })
    currentKey.value = res.success ? res.data : null
  } catch {
    currentKey.value = null
  }
}

async function generateKey() {
  keyLoading.value = true
  fullKey.value = ''
  try {
    const res = await request({ url: '/api-keys/generate', method: 'post' })
    if (res.success) {
      fullKey.value = res.data.key
      currentKey.value = res.data
      ElMessage.success('API Key 已生成')
    } else {
      ElMessage.error(res.message || '生成失败')
    }
  } catch (e) {
    ElMessage.error(e.response?.data?.message || e.message)
  } finally {
    keyLoading.value = false
  }
}

async function refreshKey() {
  keyLoading.value = true
  fullKey.value = ''
  try {
    const res = await request({ url: '/api-keys/refresh', method: 'post' })
    if (res.success) {
      fullKey.value = res.data.key
      currentKey.value = res.data
      ElMessage.success('密钥已刷新，旧密钥已吊销')
    } else {
      ElMessage.error(res.message || '刷新失败')
    }
  } catch (e) {
    ElMessage.error(e.response?.data?.message || e.message)
  } finally {
    keyLoading.value = false
  }
}

async function confirmRevoke() {
  try {
    await ElMessageBox.confirm(
      '此操作将永久禁用当前 API Key。使用该密钥的所有脚本将立即失效。',
      '吊销 API Key',
      { confirmButtonText: '确认吊销', cancelButtonText: '取消', type: 'warning' }
    )
  } catch { return }

  keyLoading.value = true
  fullKey.value = ''
  try {
    const res = await request({ url: '/api-keys/revoke', method: 'post' })
    if (res.success) {
      currentKey.value = null
      ElMessage.success('API Key 已吊销')
    } else {
      ElMessage.error(res.message || '吊销失败')
    }
  } catch (e) {
    ElMessage.error(e.response?.data?.message || e.message)
  } finally {
    keyLoading.value = false
  }
}

// ── SendKey ──
async function fetchSendKeyStatus() {
  try {
    const res = await request({ url: '/users/sendkey-status', method: 'get' })
    sendKeyBound.value = res.success && res.data?.bound
  } catch {
    sendKeyBound.value = false
  }
}

async function saveSendKey() {
  if (!sendKeyInput.value.trim()) {
    ElMessage.warning('请输入 SendKey')
    return
  }
  skLoading.value = true
  try {
    const res = await request({
      url: '/users/sendkey',
      method: 'put',
      data: { sendKey: sendKeyInput.value.trim() }
    })
    if (res.success) {
      sendKeyBound.value = true
      sendKeyInput.value = ''
      ElMessage.success('SendKey 已保存')
    } else {
      ElMessage.error(res.message || '保存失败')
    }
  } catch (e) {
    ElMessage.error(e.response?.data?.message || e.message)
  } finally {
    skLoading.value = false
  }
}

async function unbindSendKey() {
  skLoading.value = true
  try {
    const res = await request({
      url: '/users/sendkey',
      method: 'put',
      data: { sendKey: '' }
    })
    if (res.success) {
      sendKeyBound.value = false
      sendKeyInput.value = ''
      ElMessage.success('SendKey 已解绑')
    } else {
      ElMessage.error(res.message || '解绑失败')
    }
  } catch (e) {
    ElMessage.error(e.response?.data?.message || e.message)
  } finally {
    skLoading.value = false
  }
}

// ── Init ──
onMounted(() => {
  fetchCurrentKey()
  fetchSendKeyStatus()
})
</script>

<style scoped>
.api-key-page {
  padding: 20px;
  max-width: 1200px;
  margin: 0 auto;
}
.card-header {
  display: flex;
  align-items: center;
  gap: 10px;
}
.card-title {
  font-size: 16px;
  font-weight: 600;
}
.full-key-section {
  margin-bottom: 16px;
}
.key-display-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 12px;
  padding: 12px;
  background: #fffbe6;
  border: 1px dashed #e6a23c;
  border-radius: 4px;
}
.full-key-text {
  flex: 1;
  word-break: break-all;
  font-size: 13px;
  color: #303133;
}
.masked-key {
  font-size: 13px;
  letter-spacing: 0.5px;
}
.key-meta {
  margin-bottom: 16px;
}
.no-key-hint {
  color: #909399;
  font-style: italic;
  padding: 12px 0;
}
.btn-row {
  display: flex;
  gap: 12px;
  margin: 20px 0;
  flex-wrap: wrap;
}
.code-block {
  background: #1e1e1e;
  color: #d4d4d4;
  padding: 14px;
  border-radius: 6px;
  font-size: 12px;
  line-height: 1.6;
  overflow-x: auto;
  white-space: pre-wrap;
  margin: 0;
}
.hint {
  color: #606266;
  font-size: 14px;
  margin: 0;
}
.hint a {
  color: #409eff;
}
.steps-list {
  color: #606266;
  font-size: 13px;
  line-height: 1.8;
  padding-left: 20px;
  margin: 0;
}
.steps-list a {
  color: #409eff;
}
</style>
