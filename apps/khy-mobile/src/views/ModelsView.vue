<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { useModelsStore } from '@/stores/models';
import { fetchModels, streamChatCompletion } from '@/api/standalone';
import { operationStatus, statusText } from '@/api/status';

const models = useModelsStore();
const showKey = ref({});
const customBaseUrlInput = ref('');
const refreshing = ref(false);
const lastError = ref('');
const lastSuccess = ref('');
const status = ref(operationStatus('等待', '模型配置', '等待开始'));

// 测试连接状态：idle / testing / ok / fail + 详情
const testState = ref('idle'); // 'idle' | 'testing' | 'ok' | 'fail'
const testDetail = ref('');

// 测试发送状态：idle / sending / ok / fail + 耗时 + 收到内容预览
const sendTestState = ref('idle'); // 'idle' | 'sending' | 'ok' | 'fail'
const sendTestDetail = ref('');   // 错误信息 或 "1.2s 收到「OK」"
const sendTestLatency = ref(0);   // ms

// 当前正在编辑哪个 provider（卡片点击进入配置区）
const editing = ref(null);
// 当前编辑框的 key draft（受控输入）
const keyDraft = ref('');

// key 填充进度：内置 provider 里已配 key 的数量
const readyCount = computed(() =>
  models.providers.filter((p) => p.id !== 'custom' && models.standaloneApiKeys[p.id]).length
);
const totalCount = computed(() => models.providers.filter((p) => p.id !== 'custom').length);
const hasAnyKey = computed(() => readyCount.value > 0);

onMounted(async () => {
  await models.restore();
  await models.loadStandaloneKeys().catch(() => {});
  customBaseUrlInput.value = models.customBaseUrl;
  if (models.mode === 'standalone') {
    const firstReady = models.providers.find((p) => models.standaloneApiKeys[p.id]);
    editing.value = firstReady?.id || models.selectedProvider || 'openai';
  }
  if (models.mode === 'remote') {
    await models.refreshRemoteCatalog().catch(() => {});
  }
});

// 切换 editing 时，draft 跟 store 同步（已配的预填；未配的清空）
watch(editing, (id) => {
  if (!id) return;
  models.selectedProvider = id;
  keyDraft.value = models.standaloneApiKeys[id] || '';
  lastError.value = '';
  lastSuccess.value = '';
});

const isConfigured = (id) => Boolean(models.standaloneApiKeys[id]);

function selectProvider(id) {
  editing.value = id;
}

async function saveCurrentKey() {
  const id = editing.value;
  if (!id) return;
  if (id === 'custom') {
    models.customBaseUrl = customBaseUrlInput.value.trim();
  }
  const v = keyDraft.value.trim();
  if (!v) {
    await models.clearApiKey(id);
    flash('已清除', 'success');
  } else {
    await models.setApiKey(id, v);
    flash('已保存', 'success');
  }
  // 重新从 store 拿值（持久层可能 trim 过）
  keyDraft.value = models.standaloneApiKeys[id] || '';
}

function flash(text, tone) {
  if (tone === 'success') {
    lastSuccess.value = text;
    lastError.value = '';
  } else {
    lastError.value = text;
    lastSuccess.value = '';
  }
  setTimeout(() => {
    lastSuccess.value = '';
    lastError.value = '';
  }, 1800);
}

// 测试当前 draft 的 Key + BaseUrl：不动持久层，只发一次 /v1/models
// 独立模式关键通路：填了 Key 不知道对错 → 一键验证
async function testConnection() {
  const id = editing.value;
  if (!id) return;
  const apiKey = (keyDraft.value || models.standaloneApiKeys[id] || '').trim();
  if (!apiKey) {
    testState.value = 'fail';
    testDetail.value = '请先填 API Key';
    return;
  }
  let baseUrl = '';
  if (id === 'custom') {
    baseUrl = customBaseUrlInput.value.trim();
    if (!baseUrl) {
      testState.value = 'fail';
      testDetail.value = '请先填自定义 API 地址';
      return;
    }
  } else {
    baseUrl = models.providers.find((p) => p.id === id)?.baseUrl || '';
  }
  testState.value = 'testing';
  testDetail.value = `连 ${baseUrl}/v1/models …`;
  const start = Date.now();
  try {
    const list = await fetchModels(id, baseUrl, apiKey);
    const ms = Date.now() - start;
    testState.value = 'ok';
    testDetail.value = `连通（${ms}ms），可用模型 ${list.length} 个`;
  } catch (cause) {
    testState.value = 'fail';
    testDetail.value = formatApiError(cause, id, baseUrl);
  }
}

// 端到端「测试发送」：拉完模型后用当前 Key + 第一个可用模型发一条最小对话，
// 走完 /v1/chat/completions 全链路，验证能真收到 AI 回复（不只是 API key 有效）
async function testSendMessage() {
  const id = editing.value;
  if (!id) return;
  // 选第一个可用的模型（拉取过的列表里取），缺则用 provider 默认第一个
  const model = (currentModels.value[0]
    || models.providers.find((p) => p.id === id)?.models?.[0]
    || '').trim();
  if (!model) {
    sendTestState.value = 'fail';
    sendTestDetail.value = '请先点「拉取模型」拿到可用列表';
    return;
  }
  const apiKey = (keyDraft.value || models.standaloneApiKeys[id] || '').trim();
  if (!apiKey) {
    sendTestState.value = 'fail';
    sendTestDetail.value = '请先填 API Key';
    return;
  }
  let baseUrl = '';
  if (id === 'custom') {
    baseUrl = customBaseUrlInput.value.trim();
    if (!baseUrl) {
      sendTestState.value = 'fail';
      sendTestDetail.value = '请先填自定义 API 地址';
      return;
    }
  } else {
    baseUrl = models.providers.find((p) => p.id === id)?.baseUrl || '';
  }
  sendTestState.value = 'sending';
  sendTestDetail.value = `向 ${baseUrl} 发「hello」…`;
  sendTestLatency.value = 0;
  const start = Date.now();
  // 用一个最简单的 ping 请求：要求模型只回一个 OK。
  // 流式返回，收到任何 chunk 就算通；非空回复时长 < 30s 视为可用。
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);
  let acc = '';
  try {
    await streamChatCompletion({
      baseUrl,
      apiKey,
      model,
      messages: [
        { role: 'system', content: '你是一个测试助理。所有回答必须用一个字：「OK」。不要加任何标点或解释。' },
        { role: 'user', content: 'hello' },
      ],
      signal: controller.signal,
      temperature: 0,
      onChunk(chunk) { acc += chunk; },
      onDone() { /* 不需要在这里做事 — 抛出的错会进下面 catch */ },
    });
    clearTimeout(timeoutId);
    const ms = Date.now() - start;
    sendTestLatency.value = ms;
    const preview = acc.trim().slice(0, 60) || '(空回复)';
    sendTestState.value = acc.trim() ? 'ok' : 'fail';
    sendTestDetail.value = `${(ms / 1000).toFixed(2)}s 收到「${preview}${acc.length > 60 ? '…' : ''}」`;
  } catch (cause) {
    clearTimeout(timeoutId);
    const ms = Date.now() - start;
    sendTestLatency.value = ms;
    if (cause.name === 'AbortError') {
      sendTestState.value = 'fail';
      sendTestDetail.value = `超时（>30s）— 端点太慢或不可达`;
    } else {
      sendTestState.value = 'fail';
      sendTestDetail.value = `${(ms / 1000).toFixed(2)}s — ${formatApiError(cause, id, baseUrl)}`;
    }
  }
}

// 把 fetchModels / consumeSse 抛出的错翻译成对人话
function formatApiError(cause, providerId, baseUrl) {
  const msg = String(cause?.message || cause || '');
  // consumeSse 抛的：事件流连接失败（HTTP 400/401/...）
  const httpMatch = msg.match(/HTTP\s+(\d{3})/i);
  if (httpMatch) {
    const code = Number(httpMatch[1]);
    if (code === 401 || code === 403) return `鉴权失败（HTTP ${code}）— Key 不对或没权限访问该 provider`;
    if (code === 404) return `端点不存在（HTTP 404）— ${baseUrl} 路径不对，或 provider 拼写错了`;
    if (code === 400) return `请求被拒（HTTP 400）— 模型名该 provider 不支持 / 余额不足 / 上下文超长`;
    if (code === 429) return `请求太频繁（HTTP 429）— 稍等再试，或换 provider`;
    if (code >= 500) return `供应商服务端异常（HTTP ${code}）— 稍后重试`;
    return `请求被拒（HTTP ${code}）— ${msg}`;
  }
  if (/CORS|cors|opaque/i.test(msg)) return `浏览器拦了 CORS — 确认端点支持跨域（独立模式用 Key 直连通常 OK）`;
  if (/network|fetch|Failed to fetch/i.test(msg)) return `网络不通 — 检查 Wi-Fi / 数据`;
  if (/timeout|abort/i.test(msg)) return `请求超时 — 端点太慢或不可达`;
  return msg || '未知错误';
}

async function refreshCurrentModels() {
  const id = editing.value;
  if (!id) return;
  refreshing.value = true;
  lastError.value = '';
  try {
    if (id === 'custom') {
      if (!customBaseUrlInput.value.trim()) throw new Error('请填写自定义 API 地址');
      const apiKey = keyDraft.value || models.standaloneApiKeys.custom || '';
      models.customBaseUrl = customBaseUrlInput.value.trim();
      await models.refreshStandaloneModels('custom', customBaseUrlInput.value.trim(), apiKey);
    } else {
      const apiKey = keyDraft.value || models.standaloneApiKeys[id] || '';
      if (!apiKey) throw new Error('请先填 API Key');
      const config = models.providers.find((p) => p.id === id);
      await models.refreshStandaloneModels(id, config.baseUrl, apiKey);
    }
    status.value = operationStatus('拉取', `模型列表（${id}）`, '已更新', 'success');
    flash('已更新模型列表', 'success');
  } catch (cause) {
    lastError.value = cause.message || '模型列表拉取失败';
    status.value = operationStatus('拉取', `模型列表（${id}）`, '失败', 'error');
  } finally {
    refreshing.value = false;
  }
}

async function refreshRemote() {
  refreshing.value = true;
  lastError.value = '';
  try {
    await models.refreshRemoteCatalog();
    status.value = operationStatus('拉取', '网关模型目录', '已更新', 'success');
    flash('已更新网关模型', 'success');
  } catch (cause) {
    lastError.value = cause.message || '网关模型拉取失败';
    status.value = operationStatus('拉取', '网关模型目录', '失败', 'error');
  } finally {
    refreshing.value = false;
  }
}

const currentProvider = computed(() => models.providers.find((p) => p.id === editing.value));
const currentModels = computed(() => {
  if (!currentProvider.value) return [];
  if (editing.value === 'custom') {
    return models.customModels.length ? models.customModels : currentProvider.value.models;
  }
  return currentProvider.value.models;
});

const isCurrentConfigured = computed(() => {
  const id = editing.value;
  if (!id) return false;
  if (id === 'custom') return Boolean(models.customBaseUrl);
  return Boolean(models.standaloneApiKeys[id]);
});
</script>

<template>
  <div class="stack">
    <div>
      <h1 class="page-title">🌱 模型与密钥</h1>
      <p class="page-subtitle">API Key 加密存储于 Android Keystore，只在本机使用</p>
    </div>

    <!-- 模式：贴式二选一 -->
    <section class="panel">
      <h2>🌳 选住哪间小屋</h2>
      <div class="segmented" role="tablist">
        <button :class="{ active: models.mode === 'standalone' }" @click="models.setMode('standalone')">🌿 森林小屋</button>
        <button :class="{ active: models.mode === 'remote', 'mode-remote': models.mode === 'remote' }" @click="models.setMode('remote')">🌊 湖畔工坊</button>
      </div>
      <p class="muted hint">
        {{ models.mode === 'standalone'
          ? '消息直连你下面配置的 AI 供应商。'
          : '消息走当前配对节点，无需本地 Key。' }}
      </p>
    </section>

    <!-- 远程模式：拉取网关模型目录 -->
    <section v-if="models.mode === 'remote'" class="panel stack">
      <div class="row"><h2>网关模型</h2>
        <button class="button small" :disabled="refreshing" @click="refreshRemote">刷新</button>
      </div>
      <p class="status-line" :class="models.status.tone">{{ statusText(models.status) }}</p>
      <p v-if="models.error" class="alert">{{ models.error }}</p>
      <label class="field">
        <span>默认模型</span>
        <select :value="models.defaultModel" @change="(e) => models.setDefaultModel(e.target.value)">
          <option v-if="!models.remoteModels.length" value="" disabled>暂无模型，先点「刷新」</option>
          <option v-for="m in models.remoteModels" :key="m.id" :value="m.id">{{ m.label }}（{{ m.provider }}）</option>
        </select>
      </label>
    </section>

    <!-- 独立模式：进度条 + provider 网格 + 单 provider 配置区 -->
    <template v-if="models.mode === 'standalone'">
      <section class="panel progress-panel">
        <div class="row">
          <h2>🌱 API Key 进度</h2>
          <span class="badge" :class="hasAnyKey ? 'ok' : 'miss'">
            <span v-if="hasAnyKey">🌿</span><span v-else>🍂</span>
            {{ readyCount }} / {{ totalCount }} 已配置
          </span>
        </div>
        <div class="progress-track">
          <span :style="{ width: ((readyCount / totalCount) * 100) + '%' }"></span>
        </div>
        <p class="muted hint">
          <span v-if="readyCount === 0">还没填任何 Key —— 选一个厂商卡片开始</span>
          <span v-else-if="readyCount < totalCount">填了 {{ readyCount }} 个，可以再加几个备用</span>
          <span v-else>全配齐了 ✓</span>
        </p>
      </section>

      <section class="panel">
        <h2>选择供应商</h2>
        <div class="provider-grid">
          <button
            v-for="p in models.providers"
            :key="p.id"
            type="button"
            class="provider-chip"
            :class="{ selected: editing === p.id, configured: isConfigured(p.id) }"
            @click="selectProvider(p.id)"
          >
            <span class="logo">{{ p.logo }}</span>
            <span class="provider-name">{{ p.label }}</span>
            <span class="provider-state">
              <span v-if="isConfigured(p.id)" class="badge ok">🌿 已就绪</span>
              <span v-else-if="editing === p.id" class="badge miss">编辑中</span>
              <span v-else class="muted">未填</span>
            </span>
          </button>
        </div>
      </section>

      <section v-if="currentProvider" class="panel stack">
        <div class="row">
          <h2><span class="logo-inline">{{ currentProvider.logo }}</span> {{ currentProvider.label }}</h2>
          <span class="badge" :class="isCurrentConfigured ? 'ok' : 'miss'">
            <span v-if="isCurrentConfigured">🌿 已就绪</span><span v-else>未配置</span>
          </span>
        </div>
        <p v-if="currentProvider.baseUrl" class="muted hint">默认端点：{{ currentProvider.baseUrl }}</p>

        <label v-if="editing === 'custom'" class="field">
          <span>API 地址（自定义）</span>
          <input v-model="customBaseUrlInput" inputmode="url" placeholder="https://your-gateway.example" />
        </label>

        <div class="field">
          <span>API Key</span>
          <div class="row key-row">
            <input
              v-model="keyDraft"
              :type="showKey[editing] ? 'text' : 'password'"
              :placeholder="models.standaloneApiKeys[editing] ? '已配置（留空再保存 = 清除）' : 'sk-...'"
              autocomplete="off"
              @keydown.enter.prevent="testConnection"
            />
            <button class="button small ghost" type="button" @click="showKey[editing] = !showKey[editing]">
              {{ showKey[editing] ? '隐藏' : '显示' }}
            </button>
            <button class="button small primary" type="button" @click="saveCurrentKey">
              {{ models.standaloneApiKeys[editing] ? '更新' : '保存' }}
            </button>
          </div>
        </div>

        <!-- 测试连接：填完 Key 一键验证，不动持久层 -->
        <div class="row test-row">
          <button
            class="button small primary test-btn"
            type="button"
            :disabled="testState === 'testing'"
            :title="`用当前 Key 试连 ${currentProvider?.baseUrl || ''}/v1/models`"
            @click="testConnection"
          >
            <span aria-hidden="true">{{ testState === 'testing' ? '⏳' : '🧪' }}</span>
            {{ testState === 'testing' ? '测试中…' : '测试连接' }}
          </button>
          <span
            v-if="testState !== 'idle'"
            class="badge"
            :class="testState === 'ok' ? 'ok' : testState === 'fail' ? 'miss' : 'lake'"
          >
            <span v-if="testState === 'testing'">⏳</span>
            <span v-else-if="testState === 'ok'">🌿</span>
            <span v-else>⚠</span>
            {{ testDetail }}
          </span>
        </div>

        <div class="row action-row">
          <button class="button small" :disabled="refreshing" @click="refreshCurrentModels">
            {{ refreshing ? '拉取中…' : '拉取模型' }}
          </button>
          <button
            v-if="currentModels.length"
            class="button small primary test-send-btn"
            type="button"
            :disabled="sendTestState === 'sending'"
            :title="`用 ${currentModels[0]} 端到端验证 — 发 hello 收 OK`"
            @click="testSendMessage"
          >
            <span aria-hidden="true">{{ sendTestState === 'sending' ? '⏳' : '🧪' }}</span>
            {{ sendTestState === 'sending' ? '发送中…' : '测试发送' }}
          </button>
          <span v-if="lastSuccess" class="badge ok">{{ lastSuccess }}</span>
          <span v-if="lastError" class="badge miss">{{ lastError }}</span>
        </div>

        <!-- 端到端测试发送结果 -->
        <div v-if="sendTestState !== 'idle'" class="row send-test-row">
          <span
            class="badge"
            :class="sendTestState === 'ok' ? 'ok' : sendTestState === 'fail' ? 'miss' : 'lake'"
          >
            <span v-if="sendTestState === 'sending'">⏳</span>
            <span v-else-if="sendTestState === 'ok'">🌿</span>
            <span v-else>⚠</span>
            {{ sendTestDetail }}
          </span>
        </div>

        <label class="field">
          <span>默认模型（用于新对话）</span>
          <select :value="models.defaultModel" @change="(e) => models.setDefaultModel(e.target.value)">
            <option v-if="!currentModels.length" value="" disabled>暂无模型，点「拉取模型」</option>
            <option v-for="m in currentModels" :key="m" :value="m">{{ m }}</option>
          </select>
        </label>
      </section>
    </template>
  </div>
</template>

<style scoped>
.panel { padding: 16px; border-radius: var(--m-radius-lg); }
.panel h2 { margin: 0 0 10px; font-size: 15px; }
.hint { margin: 8px 0 0; font-size: 12px; }
.progress-panel { padding: 14px 16px; }
.provider-state { font-size: 10px; margin-top: 2px; min-height: 16px; display: inline-flex; }
.provider-name { font-weight: 600; font-size: 12px; }
.provider-chip { min-height: 88px; }
.provider-chip .logo { font-size: 22px; line-height: 1; }
.logo-inline { color: var(--m-accent); margin-right: 4px; }
.key-row { gap: 6px; align-items: stretch; }
.key-row input { flex: 1; }
.button.ghost { background: transparent; }
.button.small { padding: 6px 10px; font-size: 12px; }
.button.primary { color: var(--m-accent-on); background: var(--m-accent); border-color: var(--m-accent); }
.action-row { gap: 10px; flex-wrap: wrap; }

/* 测试连接行：贴在 API Key 下面，主色按钮 + 实时结果徽章 */
.test-row { gap: 10px; align-items: center; flex-wrap: wrap; }
.test-btn { gap: 4px; display: inline-flex; align-items: center; }
.test-btn[disabled] { opacity: .7; cursor: wait; }

/* 端到端测试发送 — 拉完模型后才出现；结果行贴在下面 */
.test-send-btn { gap: 4px; display: inline-flex; align-items: center; }
.test-send-btn[disabled] { opacity: .7; cursor: wait; }
.send-test-row { gap: 6px; align-items: center; flex-wrap: wrap; }
.send-test-row .badge { font-size: 12px; padding: 5px 12px; }
</style>
