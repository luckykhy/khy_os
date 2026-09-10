<script setup>
import { computed, nextTick, ref } from 'vue';
import { consumeSse } from '@/api/sse';
import { operationStatus, statusText } from '@/api/status';
import { getSetting } from '@/api/localDb';
import { useModelsStore } from '@/stores/models';
import { streamChatCompletion, getStandaloneApiKey } from '@/api/standalone';

const models = useModelsStore();
const messages = ref([]);
const question = ref('');
const busy = ref(false);
const status = ref(operationStatus('等待', 'AI 对话', '可发送'));
const error = ref('');
let controller = null;

// 运行模式：standalone = 直连 API，remote = 通过 khy-os 网关
const mode = ref('');
const isStandalone = computed(() => mode.value === 'standalone');

async function loadMode() {
  mode.value = await getSetting('settings_mode') || '';
}

async function send() {
  const text = question.value.trim();
  if (!text || busy.value) return;
  const history = messages.value.map(({ role, content }) => ({ role, content })).slice(-10);
  messages.value.push({ id: crypto.randomUUID(), role: 'user', content: text });
  const assistant = { id: crypto.randomUUID(), role: 'assistant', content: '', thinking: '', controls: [] };
  messages.value.push(assistant);
  question.value = '';
  error.value = '';
  busy.value = true;
  controller = new AbortController();
  status.value = operationStatus('生成', 'AI 回复', '连接中');

  if (isStandalone.value) {
    await sendStandalone(text, history, assistant);
  } else {
    await sendRemote(text, history, assistant);
  }
}

async function sendStandalone(text, history, assistant) {
  try {
    const providerId = models.effectiveStandaloneProvider;
    const provider = models.providers.find((p) => p.id === providerId);
    if (!provider) throw new Error('请先配置 AI 供应商');

    const apiKey = await getStandaloneApiKey(providerId);
    if (!apiKey) throw new Error('请先配置 API Key');

    const baseUrl = providerId === 'custom' ? models.customBaseUrl : provider.baseUrl;
    const model = models.defaultModel || provider.models?.[0] || 'gpt-4o-mini';

    const fullMessages = [
      ...history.map((m) => ({ role: m.role, content: m.content })),
      { role: 'user', content: text },
    ];

    await streamChatCompletion({
      baseUrl,
      apiKey,
      model,
      messages: fullMessages,
      signal: controller.signal,
      onChunk(chunk) { assistant.content += chunk; },
      onDone() { /* stream completed */ },
    });
    status.value = operationStatus('生成', 'AI 回复', '已完成', 'success');
  } catch (cause) {
    if (cause.name !== 'AbortError') {
      error.value = cause.message || 'AI 对话失败';
      status.value = operationStatus('生成', 'AI 回复', '失败', 'error');
    }
  } finally {
    busy.value = false;
    controller = null;
  }
}

async function sendRemote(text, history, assistant) {
  try {
    await consumeSse('/api/ai/chat/stream', {
      method: 'POST',
      body: JSON.stringify({ question: text, conversationHistory: history }),
      signal: controller.signal,
      onEvent({ data }) {
        const event = data && typeof data === 'object' ? data : {};
        if (event.type === 'chunk') assistant.content += event.content || '';
        else if (event.type === 'done') assistant.content = event.content || assistant.content;
        else if (event.type === 'thinking_content') assistant.thinking += event.text || '';
        else if (event.type === 'control_request') assistant.controls.push(event);
        else if (event.type === 'error') throw new Error(event.message || 'AI 响应失败');
        status.value = operationStatus('接收', 'AI 回复', event.type || '数据到达', event.type === 'error' ? 'error' : 'success');
        nextTick(() => document.querySelector('.chat-end')?.scrollIntoView({ behavior: 'smooth' }));
      },
    });
    status.value = operationStatus('生成', 'AI 回复', '已完成', 'success');
  } catch (cause) {
    if (cause.name !== 'AbortError') {
      error.value = cause.message || 'AI 对话失败';
      status.value = operationStatus('生成', 'AI 回复', '失败', 'error');
    }
  } finally {
    busy.value = false;
    controller = null;
  }
}

function stop() {
  controller?.abort();
  status.value = operationStatus('停止', 'AI 回复', '已完成');
}

// 已配置的 providers（有 API Key 的）
const configuredProviders = computed(() =>
  models.providers.filter((p) => models.standaloneApiKeys[p.id])
);

// 当前 provider 的模型列表
const currentModelOptions = computed(() => {
  const provider = models.providers.find((p) => p.id === models.selectedProvider);
  if (!provider) return [];
  return provider.models || [];
});

// 切换 provider
async function onProviderChange(providerId) {
  models.selectedProvider = providerId;
  // 自动选择该 provider 的第一个模型
  const provider = models.providers.find((p) => p.id === providerId);
  if (provider?.models?.length) {
    await models.setDefaultModel(provider.models[0]);
  }
}

// 切换模型
async function onModelChange(model) {
  await models.setDefaultModel(model);
}

// 初始化时加载模式和密钥
async function init() {
  // 先恢复设置（包括 providers 和 mode）
  await models.restore().catch(() => {});
  // 再加载 API Key
  await models.loadStandaloneKeys().catch(() => {});
  // 加载运行模式
  await loadMode();
}

init();
</script>

<template>
  <div class="chat-page">
    <div class="row">
      <div>
        <h1 class="page-title">AI 对话</h1>
        <p class="page-subtitle">{{ isStandalone ? '直连 AI 供应商（独立模式）' : '与 Khy-OS 节点上的 AI 服务通信' }}</p>
      </div>
      <div class="row" style="gap: 8px;">
        <span v-if="isStandalone" class="mode-badge standalone">独立模式</span>
        <button v-if="messages.length" class="button" @click="messages = []">清空</button>
      </div>
    </div>

    <!-- 独立模式未配置提示 -->
    <div v-if="isStandalone && !models.firstProviderWithKey" class="config-hint">
      <p>尚未配置 API Key，对话功能不可用。</p>
      <button class="button primary" @click="$router.push('/models')">前往配置模型与密钥</button>
    </div>

    <!-- 模型选择器 -->
    <div v-if="isStandalone && models.firstProviderWithKey" class="model-selector">
      <div class="model-selector-row">
        <select
          :value="models.selectedProvider"
          @change="onProviderChange($event.target.value)"
          class="model-select"
        >
          <option
            v-for="p in configuredProviders"
            :key="p.id"
            :value="p.id"
          >
            {{ p.label }}
          </option>
        </select>
        <select
          :value="models.defaultModel"
          @change="onModelChange($event.target.value)"
          class="model-select"
        >
          <option
            v-for="m in currentModelOptions"
            :key="m"
            :value="m"
          >
            {{ m }}
          </option>
        </select>
      </div>
    </div>

    <section class="messages">
      <div v-if="!messages.length" class="empty-chat">
        <strong>开始一个新问题</strong>
        <p>{{ isStandalone ? `当前使用: ${models.providers.find(p => p.id === models.effectiveStandaloneProvider)?.label || 'AI 供应商'} / ${models.defaultModel || '默认模型'}` : '消息通过当前配对节点发送。' }}</p>
      </div>
      <article v-for="message in messages" :key="message.id" class="message" :class="message.role">
        <small>{{ message.role === 'user' ? '你' : 'Khy AI' }}</small>
        <p>{{ message.content || (busy ? '正在生成…' : '暂无内容') }}</p>
        <details v-if="message.thinking"><summary>思考过程</summary><p>{{ message.thinking }}</p></details>
        <div v-for="control in message.controls" :key="control.requestId" class="control-note">检测到控制请求 {{ control.requestId || '待处理' }}，请前往审批页核对。</div>
      </article>
      <div class="chat-end"></div>
    </section>
    <div class="composer stack">
      <p class="status-line" :class="status.tone">{{ statusText(status) }}</p>
      <p v-if="error" class="alert">{{ error }}</p>
      <textarea
        v-model="question"
        placeholder="输入消息，按 Enter 发送，Shift + Enter 换行"
        @keydown.enter.exact.prevent="send"
        @keydown.ctrl.enter.prevent="send"
      ></textarea>
      <div class="row">
        <button v-if="busy" class="button danger" @click="stop">停止</button>
        <span v-else class="muted">Enter 发送 · Shift + Enter 换行</span>
        <button
          class="button primary"
          :disabled="busy || !question.trim() || (isStandalone && !models.firstProviderWithKey)"
          @click="send"
        >发送</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.chat-page { display: grid; gap: 14px; }.messages { display: grid; gap: 12px; min-height: 42vh; }.empty-chat { display: grid; place-content: center; min-height: 34vh; text-align: center; color: #8ca0b5; }.empty-chat strong { color: #e9eef5; }.message { width: min(88%, 620px); padding: 12px 14px; border: 1px solid #243241; border-radius: 8px; background: #111a24; }.message.user { justify-self: end; background: #16312d; border-color: #275149; }.message small { color: #68d5c0; }.message p { margin: 6px 0 0; white-space: pre-wrap; line-height: 1.6; overflow-wrap: anywhere; }.message details { margin-top: 8px; color: #8ca0b5; font-size: 12px; }.control-note { margin-top: 9px; padding: 8px; color: #f0cf83; background: #302a18; border-radius: 5px; font-size: 12px; }.composer { position: sticky; bottom: 72px; padding-top: 8px; background: #0b1118; }.composer textarea { min-height: 72px; }
.mode-badge { padding: 4px 10px; border-radius: 12px; font-size: 11px; font-weight: 600; }
.mode-badge.standalone { background: #16312d; color: #68d5c0; border: 1px solid #275149; }
.config-hint { padding: 16px; background: #162232; border: 1px solid #243241; border-radius: 8px; text-align: center; display: grid; gap: 10px; }
.config-hint p { color: #8ca0b5; margin: 0; }
.model-selector { padding: 10px 14px; background: #162232; border: 1px solid #243241; border-radius: 8px; }
.model-selector-row { display: flex; gap: 8px; }
.model-select { flex: 1; padding: 8px 10px; background: #0d151e; border: 1px solid #324354; border-radius: 6px; color: #e9eef5; font-size: 13px; }
.model-select:focus { border-color: #68d5c0; }
.button.small { padding: 6px 12px; font-size: 12px; }
</style>
