<template>
  <el-card class="gw-card" shadow="never">
    <template #header>
      <div class="gw-card-head">
        <div class="gw-card-title">
          <el-icon><Link /></el-icon>
          <span>{{ title }}</span>
        </div>
        <el-tag size="small" effect="light" type="info">{{ activeCount }} 个活跃 Token</el-tag>
      </div>
    </template>

    <p class="gw-card-desc">{{ description }}</p>

    <!-- Endpoint -->
    <div class="gw-endpoint">
      <div class="gw-kv">
        <span class="gw-k">统一接入地址</span>
        <div class="gw-v-row">
          <code class="gw-v">{{ endpoint?.endpoint || '—' }}</code>
          <el-button v-if="endpoint?.endpoint" text size="small" @click="copy(endpoint.endpoint)">复制</el-button>
        </div>
      </div>
      <div class="gw-usage" v-if="endpoint?.usage">
        <p class="gw-usage-hint">{{ endpoint.usage.hint }}</p>
        <pre class="gw-usage-pre">export ANTHROPIC_BASE_URL="{{ endpoint.usage.anthropicBaseUrl }}"
export ANTHROPIC_AUTH_TOKEN="&lt;你的 CC Token&gt;"</pre>
      </div>
    </div>

    <el-divider />

    <!-- Issue -->
    <div class="gw-issue">
      <el-input v-model="label" placeholder="Token 备注（可选）" class="gw-issue-input" />
      <el-button type="primary" :loading="busy" @click="onIssue">签发新 Token</el-button>
    </div>

    <!-- One-time plaintext reveal -->
    <el-alert
      v-if="revealed"
      class="gw-reveal"
      type="success"
      :closable="true"
      show-icon
      @close="revealed = null"
    >
      <template #title>新 Token（仅此一次完整显示，请立即复制）</template>
      <div class="gw-reveal-row">
        <code class="gw-reveal-key">{{ revealed }}</code>
        <el-button text size="small" @click="copy(revealed)">复制</el-button>
      </div>
    </el-alert>

    <!-- Token list -->
    <div v-if="tokens.length === 0" class="gw-empty">还没有签发任何 CC Token</div>
    <div v-for="t in tokens" :key="t.id" class="gw-token">
      <div class="gw-token-meta">
        <code class="gw-token-prefix">{{ t.keyPrefix }}…</code>
        <span class="gw-token-label">{{ t.label || 'default' }}</span>
        <el-tag :type="t.isActive ? 'success' : 'info'" size="small" effect="plain">{{ t.isActive ? '活跃' : '已撤销' }}</el-tag>
        <span v-if="t.lastUsedAt" class="gw-token-time">最近使用 {{ fmt(t.lastUsedAt) }}</span>
      </div>
      <el-button v-if="t.isActive" text type="danger" size="small" @click="onRevoke(t.id)">撤销</el-button>
    </div>
  </el-card>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import { Link } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'

const props = defineProps({
  scope: { type: String, default: 'user' },
  endpoint: { type: Object, default: null },
  tokens: { type: Array, default: () => [] },
  busy: { type: Boolean, default: false },
  // Plaintext of a just-issued token, surfaced once by the parent after a
  // successful issue. The card reveals it then owns its own dismissal.
  justIssued: { type: String, default: '' },
})
const emit = defineEmits(['issue', 'revoke'])

const isUser = computed(() => props.scope !== 'global')
const title = computed(() => (isUser.value ? '我的 CC 接入' : '全局 CC 接入'))
const description = computed(() => (isUser.value
  ? '把 Claude Code 指向下面的统一地址，用你签发的 Token 鉴权。请求会路由到你自己的上游。'
  : '全局 CC 接入地址与 Token。'))

const activeCount = computed(() => props.tokens.filter((t) => t.isActive).length)

const label = ref('')
const revealed = ref(null)

// Parent surfaces the one-time plaintext via justIssued after a successful issue.
watch(() => props.justIssued, (val) => {
  if (val) {
    revealed.value = val
    label.value = ''
  }
})

function onIssue() {
  emit('issue', label.value.trim())
}

async function onRevoke(id) {
  try {
    await ElMessageBox.confirm('确认撤销该 Token 吗？使用它的客户端将立即失效。', '撤销 Token', { type: 'warning' })
    emit('revoke', id)
  } catch { /* cancelled */ }
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text)
    ElMessage.success('已复制')
  } catch {
    ElMessage.warning('复制失败，请手动选择')
  }
}

function fmt(ts) {
  try { return new Date(ts).toLocaleString() } catch { return '' }
}
</script>

<style scoped>
.gw-card { border: 1px solid var(--khy-border); border-radius: var(--khy-radius); }
.gw-card-head { display: flex; align-items: center; justify-content: space-between; }
.gw-card-title { display: flex; align-items: center; gap: 8px; font-weight: 700; color: var(--khy-text-strong); }
.gw-card-desc { margin: 0 0 14px; color: var(--khy-text-secondary); font-size: 13px; line-height: 1.5; }
.gw-endpoint { display: flex; flex-direction: column; gap: 12px; }
.gw-kv { display: flex; flex-direction: column; gap: 4px; }
.gw-k { font-size: 12px; color: var(--khy-text-muted); font-weight: 600; }
.gw-v-row { display: flex; align-items: center; gap: 8px; }
.gw-v { font-family: var(--khy-font-mono, monospace); font-size: 13px; color: var(--khy-text-main); word-break: break-all; }
.gw-usage-hint { margin: 0 0 6px; font-size: 12px; color: var(--khy-text-secondary); }
.gw-usage-pre { margin: 0; padding: 10px 12px; background: var(--khy-bg-soft); border-radius: var(--khy-radius-sm); font-size: 12px; font-family: var(--khy-font-mono, monospace); color: var(--khy-text-main); white-space: pre-wrap; word-break: break-all; }
.gw-issue { display: flex; gap: 10px; margin-bottom: 12px; }
.gw-issue-input { flex: 1; }
.gw-reveal { margin-bottom: 12px; }
.gw-reveal-row { display: flex; align-items: center; gap: 8px; margin-top: 4px; }
.gw-reveal-key { font-family: var(--khy-font-mono, monospace); font-size: 12px; word-break: break-all; }
.gw-empty { color: var(--khy-text-muted); font-size: 13px; padding: 8px 0; }
.gw-token { display: flex; align-items: center; justify-content: space-between; padding: 7px 10px; border: 1px solid var(--khy-border-light); border-radius: var(--khy-radius-sm); margin-bottom: 6px; }
.gw-token-meta { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; min-width: 0; }
.gw-token-prefix { font-family: var(--khy-font-mono, monospace); font-size: 12px; color: var(--khy-text-main); }
.gw-token-label { color: var(--khy-text-secondary); font-size: 13px; }
.gw-token-time { color: var(--khy-text-muted); font-size: 12px; }
</style>
