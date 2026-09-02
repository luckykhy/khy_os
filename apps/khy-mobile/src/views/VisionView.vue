<script setup>
import { onMounted, ref, computed } from 'vue';
import {
  getVlmProviders,
  getVlmSelection,
  setVlmSelection,
  getVlmApiKey,
  saveVlmApiKey,
} from '@/api/visionProvider';
import { operationStatus, statusText } from '@/api/status';

const providers = ref(getVlmProviders());
const sel = ref({ provider: '', model: '' });
const apiKeyDraft = ref('');
const showKey = ref(false);
const configured = ref(false);
const status = ref(operationStatus('读取', '视觉模型', '等待开始'));

const currentProvider = computed(() => providers.value.find((p) => p.id === sel.value.provider));

onMounted(async () => {
  sel.value = await getVlmSelection();
  await refreshKeyState();
  status.value = operationStatus('读取', '视觉模型', sel.value.provider ? '就绪' : '未配置', 'success');
});

async function refreshKeyState() {
  if (!sel.value.provider) { configured.value = false; return; }
  const k = await getVlmApiKey(sel.value.provider);
  configured.value = Boolean(k);
}

async function chooseProvider(id) {
  sel.value.provider = id;
  sel.value.model = providers.value.find((p) => p.id === id)?.models?.[0] || '';
  await setVlmSelection(sel.value);
  await refreshKeyState();
}

async function chooseModel(model) {
  sel.value.model = model;
  await setVlmSelection(sel.value);
}

async function saveKey() {
  if (!sel.value.provider) return;
  await saveVlmApiKey(sel.value.provider, apiKeyDraft.value);
  apiKeyDraft.value = '';
  await refreshKeyState();
  status.value = operationStatus('保存', '视觉模型 API Key', '已更新', 'success');
}
</script>

<template>
  <div class="stack">
    <div>
      <h1 class="page-title">视觉模型</h1>
      <p class="page-subtitle">给手机里 AI 一个"看屏" / 看图的能力（多模态 VLM）</p>
    </div>

    <section class="panel">
      <h2>选 Provider</h2>
      <p class="muted">填一次 Key 之后，AI 调 <code>khy.local.lookScreen</code> / <code>khy.local.understandImage</code> 就能用。Key 加密存 Android Keystore。</p>
      <div class="provider-grid">
        <button
          v-for="p in providers"
          :key="p.id"
          type="button"
          class="provider-chip"
          :class="{ selected: sel.provider === p.id }"
          @click="chooseProvider(p.id)"
        >
          <span class="logo">{{ p.id === 'dashscope' ? '⌘' : p.id === 'openai' ? '✦' : '✎' }}</span>
          <span class="provider-name">{{ p.label }}</span>
          <span v-if="sel.provider === p.id && configured" class="badge ok">已配</span>
          <span v-else-if="sel.provider === p.id" class="badge miss">未配</span>
        </button>
      </div>
    </section>

    <section v-if="currentProvider" class="panel stack">
      <div class="row">
        <h2><span class="logo">{{ currentProvider.id === 'dashscope' ? '⌘' : currentProvider.id === 'openai' ? '✦' : '✎' }}</span> {{ currentProvider.label }}</h2>
        <span v-if="configured" class="badge ok">✓ 已配</span>
        <span v-else class="badge miss">未配</span>
      </div>
      <p v-if="currentProvider.baseUrl" class="muted hint">默认端点：{{ currentProvider.baseUrl }}</p>

      <label class="field">
        <span>模型</span>
        <select :value="sel.model" @change="(e) => chooseModel(e.target.value)">
          <option v-for="m in currentProvider.models" :key="m" :value="m">{{ m }}</option>
        </select>
      </label>

      <div class="field">
        <span>API Key</span>
        <div class="row key-row">
          <input
            v-model="apiKeyDraft"
            :type="showKey ? 'text' : 'password'"
            :placeholder="configured ? '已配置（输入新值替换）' : 'sk-...'"
            autocomplete="off"
          />
          <button class="button small ghost" type="button" @click="showKey = !showKey">{{ showKey ? '隐藏' : '显示' }}</button>
          <button class="button small primary" type="button" @click="saveKey">保存</button>
        </div>
      </div>
    </section>

    <section class="panel">
      <h2>什么是 VLM</h2>
      <p class="muted">VLM = Vision-Language Model，能"看图说话"。AI 调 <code>khy.local.lookScreen</code> 时，会把你当前手机屏幕截图发给这个 VLM，让它把视觉内容转成文字描述，AI 就能基于屏幕状态做决定。</p>
      <p class="muted">当前 WebView 抓屏需要 html2canvas 等库（+1MB），APK 体积约束下暂不集成，所以 <code>lookScreen</code> 工具会先返回提示让你"截图后传图"。等接入完整抓屏后这个限制会消失。</p>
    </section>

    <p class="status-line" :class="status.tone">{{ statusText(status) }}</p>
  </div>
</template>

<style scoped>
.panel { padding: 16px; border-radius: var(--m-radius-lg); }
.panel h2 { margin: 0 0 10px; font-size: 15px; }
.hint { margin: 8px 0 0; font-size: 12px; }
.key-row { gap: 6px; align-items: stretch; }
.key-row input { flex: 1; }
.button.ghost { background: transparent; }
.button.small { padding: 6px 10px; font-size: 12px; }
.button.primary { color: var(--m-accent-on); background: var(--m-accent); border-color: var(--m-accent); }
.logo { color: var(--m-accent); margin-right: 4px; }
.badge { padding: 2px 8px; border-radius: var(--m-radius-pill); font-size: 11px; font-weight: 600; }
.badge.ok { color: var(--m-success); background: var(--m-success-bg); border: 1px solid var(--m-success-border); }
.badge.miss { color: var(--m-warn); background: #2a2310; border: 1px solid #5a4818; }
</style>
