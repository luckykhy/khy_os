<script setup>
// AgentView —— 让用户"说一句意图" → 启动 Roubao 风格多 Agent 协作闭环。
//
// 这是 ChatView 之外的"复合任务"入口：
//   - ChatView：通用对话（用户与 AI 闲聊，最多 5 轮 tool_call 循环）
//   - AgentView：复合任务（用户一句话，AI 自动跑 Manager→Executor→Reflector→Notetaker 闭环）
//
// 类比：ChatView 是 Claude Code 的"对话模式"，AgentView 是它的"非交互模式"。
// 参考：Turbo1123/roubao 的 MobileAgent.run() 主循环。

import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { run, listRecentRuns, clearRuns, ensureGuiSkillSample } from '@/api/mobileAgent';
import { getStandaloneApiKey } from '@/api/standalone';
import { useModelsStore } from '@/stores/models';
import { operationStatus, statusText } from '@/api/status';
import { showOverlay, updateOverlay, hideOverlay, onOverlayUserStop, canShowOverlay, checkOverlayStatus, requestOverlayPermission } from '@/api/overlay';

const router = useRouter();
const models = useModelsStore();

const question = ref('');
const busy = ref(false);
const phases = ref([]);     // [{ role, text, at }]
const toolLog = ref([]);    // [{ name, args, result, ok, ts }]
const notes = ref([]);      // Notetaker 写的笔记
const error = ref('');
const lastSummary = ref('');
const lastRunMeta = ref(null);
const recentRuns = ref([]);
const status = ref(operationStatus('等待', 'Agent 任务', '可发送'));
const overlayEnabled = ref(false);
const overlayNotifOk = ref(false);
const overlayAndroid = ref(0);
const overlayBanner = ref(''); // 横幅文案
let controller = null;
let unsubscribeStop = null;

const mode = computed(() => models.mode);
const currentModel = computed(() => models.defaultModel || '');

// "快速路径"建议示例（点一下就填到输入框里）
const QUICK_EXAMPLES = [
  { label: '点外卖（美团）', text: '帮我在美团点一份猪脚饭' },
  { label: '导航（高德）', text: '帮我在高德搜"国贸三期"' },
  { label: '打车（滴滴）', text: '帮我叫滴滴去"北京站"' },
  { label: '看天气', text: '帮我看北京现在天气' },
  { label: '查股票', text: '帮我看 000001 的当前股价' },
];

onMounted(async () => {
  if (!models.mode) await models.restore();
  // 把 SecureStorage 里的 key 读出来，避免 send() 拿空 key
  await models.ensureKeysLoaded().catch(() => {});
  await refreshRuns();
  // 首次进入：装一个 GUI 自动化 Skill 示例（演示双模式）
  ensureGuiSkillSample().catch(() => {});
  // 询问是否启用悬浮窗
  const status = await checkOverlayStatus();
  overlayEnabled.value = status.ok;
  overlayNotifOk.value = status.notifications;
  overlayAndroid.value = status.androidVersion;
  // 监听"用户在悬浮窗点停止"
  unsubscribeStop = onOverlayUserStop(() => {
    if (busy.value) stop();
  });
});

onUnmounted(() => {
  controller?.abort();
  try { hideOverlay(); } catch { /* */ }
  if (typeof unsubscribeStop === 'function') unsubscribeStop();
});

async function refreshRuns() {
  recentRuns.value = await listRecentRuns(10).catch(() => []);
}

async function send() {
  const text = question.value.trim();
  if (!text || busy.value) return;
  error.value = '';
  phases.value = [];
  toolLog.value = [];
  notes.value = [];
  lastSummary.value = '';
  lastRunMeta.value = null;
  busy.value = true;
  controller = new AbortController();

  try {
    if (mode.value !== 'standalone') {
      // 强制走独立模式（Agent 循环需要直接调 VLM + Tool，不走远程网关）
      await models.setMode('standalone');
    }
    // 用 effectiveStandaloneProvider：用户可能只在某家填了 key，
    // selectedProvider 仍停在默认 openai，按它取 key 会拿空。
    const provider = models.effectiveStandaloneProvider;
    const apiKey = await getStandaloneApiKey(provider);
    if (!apiKey) {
      throw new Error('未配置独立模式 API Key，请到「模型与密钥」配置');
    }
    const providerConfig = models.providers.find((p) => p.id === provider);
    const baseUrl = provider === 'custom' ? models.customBaseUrl : (providerConfig?.baseUrl || '');
    if (!baseUrl) throw new Error('未配置供应商 API 地址');
    const model = currentModel.value || (providerConfig?.models?.[0]);

    status.value = operationStatus('启动', 'Agent 任务', '匹配 Skill 中…');
    // 启动悬浮窗：第一次会检查权限，没授的话不会强弹（横幅提醒）
    if (overlayEnabled.value) {
      showOverlay({ phase: 'planner', tool: '准备中…', summary: text, steps: 0, expanded: true }).catch(() => {});
    }
    let lastOverlaySteps = 0;
    let lastOverlayPhase = 'planner';
    let lastOverlayTool = '';
    const result = await run({
      userInput: text,
      baseUrl, apiKey, model,
      signal: controller.signal,
      onPhase(p) {
        phases.value = [...phases.value, p].slice(-200);
        status.value = operationStatus(p.role, 'Agent', p.text?.slice(0, 40) || '');
        if (overlayEnabled.value) {
          lastOverlayPhase = p.role;
          if (p.role === 'executor') lastOverlayTool = p.text || '';
          const summaryText = lastSummary.value || text;
          updateOverlay({ phase: lastOverlayPhase, tool: lastOverlayTool, summary: summaryText, steps: lastOverlaySteps, expanded: true }).catch(() => {});
        }
      },
      onToolCall(t) {
        toolLog.value = [...toolLog.value, t].slice(-50);
        lastOverlayTool = `${t.name}${t.ok ? '' : ' (失败)'}`;
        lastOverlaySteps += 1;
        if (overlayEnabled.value) {
          updateOverlay({ phase: lastOverlayPhase, tool: lastOverlayTool, summary: t.result?.slice(0, 100) || text, steps: lastOverlaySteps, expanded: true }).catch(() => {});
        }
      },
      onNote(n) { notes.value = [...notes.value, { text: n, at: new Date().toISOString() }].slice(-30); },
    });
    lastSummary.value = result.finalSummary || (result.stoppedReason ? `已停止：${result.stoppedReason}` : '已达步数上限');
    lastRunMeta.value = { steps: result.steps, finishReason: result.finishReason, startedAt: result.startedAt, finishedAt: result.finishedAt, skill: result.skill };
    status.value = operationStatus('完成', 'Agent 任务', result.finishReason, result.finishReason === 'finished' ? 'success' : 'info');
  } catch (cause) {
    if (cause.name !== 'AbortError') {
      error.value = cause.message || 'Agent 任务失败';
      status.value = operationStatus('失败', 'Agent 任务', cause.message || '', 'error');
    } else {
      status.value = operationStatus('取消', 'Agent 任务', '用户取消', 'info');
    }
  } finally {
    busy.value = false;
    controller = null;
    // 任务结束（成功/失败/取消/上限）→ 收悬浮窗
    if (overlayEnabled.value) hideOverlay().catch(() => {});
    refreshRuns();
  }
}

function stop() {
  controller?.abort();
  if (overlayEnabled.value) hideOverlay().catch(() => {});
}

async function enableOverlayNow() {
  const r = await requestOverlayPermission();
  const status = await checkOverlayStatus();
  overlayEnabled.value = status.ok;
  overlayNotifOk.value = status.notifications;
  overlayAndroid.value = status.androidVersion;
  if (status.ok) {
    overlayBanner.value = '';
  } else {
    const parts = [];
    if (!status.overlay) parts.push('悬浮窗(设置 → 应用 → Khy-OS Companion → 显示在其他应用上层)');
    if (!status.notifications) parts.push('通知(Android 13+ 必需)');
    overlayBanner.value = `还未授权：${parts.join(' + ')}`;
  }
}

function useExample(text) {
  question.value = text;
}

const phaseIcon = (role) => {
  if (role === 'planner') return '◌';
  if (role === 'executor') return '⚡';
  if (role === 'reflector') return '◐';
  if (role === 'skill-match') return '✺';
  if (role === 'finish') return '✓';
  if (role === 'stop') return '⏹';
  return '·';
};
const phaseLabel = (role) => {
  if (role === 'planner') return '规划';
  if (role === 'executor') return '执行';
  if (role === 'reflector') return '反思';
  if (role === 'skill-match') return 'Skill 匹配';
  if (role === 'finish') return '完成';
  if (role === 'stop') return '终止';
  return role;
};

async function clearHistory() {
  if (!confirm('确认清空所有 Agent 执行历史？')) return;
  await clearRuns();
  await refreshRuns();
}
</script>

<template>
  <div class="agent-page stack">
    <div>
      <h1 class="page-title">AI 自动化</h1>
      <p class="page-subtitle">说一句话，让 AI 自己看屏 + 调工具 + 反思直到做完（受 Roubao / MobileAgent-v3 启发）</p>
    </div>

    <section class="panel stack">
      <div class="row header">
        <div>
          <strong>运行模式</strong>
          <p class="muted">Agent 循环走独立模式（直连 {{ models.selectedProvider || '未选' }}）</p>
        </div>
        <button v-if="mode !== 'standalone'" class="button small" @click="models.setMode('standalone')">切到独立</button>
        <span v-else class="mode-tag standalone">◉ 独立</span>
      </div>

      <div class="composer">
        <textarea
          v-model="question"
          :disabled="busy"
          rows="3"
          placeholder="如：帮我点份猪脚饭 / 帮我在高德搜国贸 / 帮我看北京现在天气"
          @keydown.ctrl.enter.prevent="send"
          @keydown.meta.enter.prevent="send"
        />
        <div class="row composer-actions">
          <span class="muted hint">Ctrl/⌘ + Enter 发送 · Enter 换行</span>
          <div class="row action-group">
            <button v-if="busy" class="button stop" @click="stop">停止</button>
            <button class="button send" :disabled="busy || !question.trim()" @click="send">{{ busy ? '运行中…' : '启动 Agent' }}</button>
          </div>
        </div>
      </div>

      <div class="examples">
        <span class="muted">快速试一下：</span>
        <button v-for="(ex, i) in QUICK_EXAMPLES" :key="i" class="chip" :disabled="busy" @click="useExample(ex.text)">{{ ex.label }}</button>
      </div>

      <p class="status-line" :class="status.tone">{{ statusText(status) }}</p>
      <div v-if="!overlayEnabled" class="overlay-banner">
        <span>📌 任务运行时可在屏幕贴边小卡片显示进度（可拖动 / 折叠 / 停止）。</span>
        <button class="button small" @click="enableOverlayNow">开启悬浮窗{{ !overlayNotifOk && overlayAndroid >= 33 ? ' + 通知' : '' }}</button>
      </div>
      <p v-if="overlayBanner" class="alert">{{ overlayBanner }}</p>
      <p v-if="error" class="alert">{{ error }}</p>
    </section>

    <!-- 最终结果 -->
    <section v-if="lastSummary" class="panel stack final">
      <h2>结果</h2>
      <div class="summary-text">{{ lastSummary }}</div>
      <div v-if="lastRunMeta" class="meta">
        <span v-if="lastRunMeta.skill">匹配 Skill：<code>{{ lastRunMeta.skill }}</code></span>
        <span>步数：{{ lastRunMeta.steps }}</span>
        <span>退出：{{ lastRunMeta.finishReason }}</span>
        <span>{{ lastRunMeta.startedAt?.slice(11, 19) }} → {{ lastRunMeta.finishedAt?.slice(11, 19) }}</span>
      </div>
    </section>

    <!-- 四 Agent 实时进度 -->
    <section v-if="phases.length" class="panel stack">
      <h2>执行进度（Manager → Executor → Reflector → Notetaker）</h2>
      <ol class="phase-list">
        <li v-for="(p, i) in phases" :key="i" :class="['phase', p.role]">
          <span class="phase-icon">{{ phaseIcon(p.role) }}</span>
          <span class="phase-role">{{ phaseLabel(p.role) }}</span>
          <span class="phase-text">{{ p.text }}</span>
        </li>
      </ol>
    </section>

    <!-- 工具调用日志 -->
    <section v-if="toolLog.length" class="panel stack">
      <h2>工具调用（{{ toolLog.length }}）</h2>
      <details v-for="(t, i) in toolLog" :key="i" class="tool-entry" :class="{ ok: t.ok, fail: !t.ok }">
        <summary>
          <span class="tool-dot"></span>
          <code class="tool-name">{{ t.name }}</code>
          <span class="tool-result-snippet">{{ String(t.result || '').slice(0, 80) }}{{ String(t.result || '').length > 80 ? '…' : '' }}</span>
        </summary>
        <pre class="tool-full">{{ JSON.stringify(t.args, null, 2) }}\n\n→ {{ String(t.result || '').slice(0, 1500) }}</pre>
      </details>
    </section>

    <!-- 笔记 -->
    <section v-if="notes.length" class="panel stack">
      <h2>Notetaker 笔记（{{ notes.length }}）</h2>
      <ul class="note-list">
        <li v-for="(n, i) in notes" :key="i"><span class="note-time">{{ n.at?.slice(11, 19) }}</span> {{ n.text }}</li>
      </ul>
    </section>

    <!-- 历史 -->
    <section class="panel stack">
      <div class="row header">
        <h2>最近执行</h2>
        <button v-if="recentRuns.length" class="button small ghost" @click="clearHistory">清空</button>
      </div>
      <p v-if="!recentRuns.length" class="empty muted">还没有执行记录。上面说一句话试试看。</p>
      <ol v-else class="run-list">
        <li v-for="r in recentRuns" :key="r.id" class="run-item" :class="r.finishReason">
          <div class="run-row">
            <code class="run-id">{{ r.id.slice(-6) }}</code>
            <span class="run-text">{{ r.userInput }}</span>
          </div>
          <div class="run-meta">
            <span v-if="r.skill">Skill: <code>{{ r.skill }}</code></span>
            <span>{{ r.steps }} 步</span>
            <span :class="['reason', r.finishReason]">{{ r.finishReason }}</span>
            <span class="muted">{{ r.startedAt?.slice(11, 19) }}</span>
          </div>
          <p v-if="r.finalSummary" class="run-summary">{{ r.finalSummary }}</p>
        </li>
      </ol>
    </section>
  </div>
</template>

<style scoped>
.agent-page { display: grid; gap: 14px; }
.panel { padding: 14px; border-radius: var(--m-radius-lg); }
.panel h2 { margin: 0 0 10px; font-size: 15px; }
.muted { color: var(--m-text-muted); font-size: 12px; }
.alert { margin: 6px 0 0; color: var(--m-danger-text); font-size: 13px; }
.row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.row.header { justify-content: space-between; }
.action-group { gap: 8px; }
.mode-tag { padding: 3px 10px; border-radius: 999px; font-size: 12px; background: var(--m-accent-soft); color: var(--m-accent); }

.composer textarea { width: 100%; min-height: 80px; padding: 10px; border-radius: 8px; border: 1px solid var(--m-border); background: var(--m-bg-deep); color: var(--m-text); font: inherit; resize: vertical; }
.composer-actions { justify-content: space-between; margin-top: 8px; }
.hint { font-size: 11px; }
.examples { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin-top: 8px; }
.chip { padding: 4px 10px; border-radius: 999px; border: 1px solid var(--m-border); background: var(--m-bg-deep); color: var(--m-text); font-size: 12px; cursor: pointer; }
.chip:disabled { opacity: 0.5; cursor: not-allowed; }

.final { border-left: 3px solid var(--m-success); }
.summary-text { padding: 8px 10px; background: var(--m-bg-deep); border-radius: 6px; line-height: 1.6; white-space: pre-wrap; }
.meta { display: flex; gap: 12px; flex-wrap: wrap; font-size: 12px; color: var(--m-text-muted); }
.meta code { background: var(--m-bg-deep); padding: 1px 5px; border-radius: 3px; }

.phase-list { list-style: none; padding: 0; margin: 0; display: grid; gap: 6px; max-height: 360px; overflow-y: auto; }
.phase { display: grid; grid-template-columns: 24px 60px 1fr; gap: 8px; align-items: start; padding: 6px 8px; border-radius: 6px; background: var(--m-bg-deep); font-size: 12px; }
.phase.planner { border-left: 2px solid var(--m-accent); }
.phase.executor { border-left: 2px solid var(--m-warn); }
.phase.reflector { border-left: 2px solid var(--m-success); }
.phase.skill-match { border-left: 2px solid #b48dff; }
.phase.finish { border-left: 2px solid var(--m-success); background: rgba(111, 217, 154, 0.08); }
.phase.stop { border-left: 2px solid var(--m-danger); background: rgba(239, 155, 117, 0.08); }
.phase-icon { text-align: center; opacity: 0.8; }
.phase-role { color: var(--m-text-muted); font-weight: 600; }
.phase-text { line-height: 1.5; overflow-wrap: anywhere; }

.tool-entry { border: 1px solid var(--m-border); border-radius: 6px; background: var(--m-bg-deep); padding: 4px 8px; font-size: 12px; }
.tool-entry.ok { border-left: 3px solid var(--m-success); }
.tool-entry.fail { border-left: 3px solid var(--m-danger); }
.tool-entry summary { cursor: pointer; display: flex; gap: 8px; align-items: center; }
.tool-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--m-text-muted); }
.tool-entry.ok .tool-dot { background: var(--m-success); }
.tool-entry.fail .tool-dot { background: var(--m-danger); }
.tool-name { background: var(--m-bg-code); padding: 1px 6px; border-radius: 3px; }
.tool-result-snippet { color: var(--m-text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 50vw; }
.tool-full { margin: 6px 0 0; padding: 8px; background: var(--m-bg-code); color: #b8c8d8; border-radius: 4px; font-size: 11px; overflow-x: auto; white-space: pre-wrap; }

.note-list { list-style: none; padding: 0; margin: 0; display: grid; gap: 4px; font-size: 12px; }
.note-list li { padding: 4px 8px; background: var(--m-bg-deep); border-radius: 4px; }
.note-time { color: var(--m-text-muted); font-family: monospace; margin-right: 6px; }

.run-list { list-style: none; padding: 0; margin: 0; display: grid; gap: 8px; }
.run-item { padding: 8px 10px; border: 1px solid var(--m-border); border-radius: 6px; background: var(--m-bg-deep); }
.run-item.finished { border-left: 3px solid var(--m-success); }
.run-item.stopped, .run-item.aborted { border-left: 3px solid var(--m-danger); }
.run-item.limit { border-left: 3px solid var(--m-warn); }
.run-row { display: flex; gap: 8px; align-items: baseline; }
.run-id { color: var(--m-text-muted); font-size: 11px; }
.run-text { font-size: 13px; }
.run-meta { display: flex; gap: 10px; flex-wrap: wrap; font-size: 11px; color: var(--m-text-muted); margin-top: 4px; }
.run-meta .reason { padding: 1px 6px; border-radius: 3px; background: var(--m-bg-code); }
.run-meta .reason.finished { color: var(--m-success); }
.run-meta .reason.stopped, .run-meta .reason.aborted { color: var(--m-danger); }
.run-meta .reason.limit { color: var(--m-warn); }
.run-summary { margin: 6px 0 0; font-size: 12px; color: var(--m-text-mid); line-height: 1.5; }
.empty { padding: 12px; border: 1px dashed var(--m-border); border-radius: 6px; text-align: center; }
.button.small { padding: 4px 10px; font-size: 12px; }
.button.send { padding: 8px 18px; font-weight: 700; }
.button.stop { padding: 8px 14px; }
.overlay-banner { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border: 1px dashed var(--m-border); border-radius: 6px; background: var(--m-bg-deep); font-size: 12px; color: var(--m-text-mid); }
.overlay-banner span { flex: 1; }
</style>
