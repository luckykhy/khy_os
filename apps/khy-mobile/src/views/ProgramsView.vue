<script setup>
import { onMounted, ref } from 'vue';
import {
  listPrograms,
  saveProgram,
  deleteProgram,
  runProgram,
  SAMPLE_PROGRAMS,
} from '@/api/programRuntime';
import { operationStatus, statusText } from '@/api/status';

const programs = ref([]);
const expanded = ref(null);
const status = ref(operationStatus('读取', '小程序', '等待开始'));
const lastResult = ref('');

async function refresh() {
  status.value = operationStatus('读取', '小程序', '进行中');
  try {
    programs.value = await listPrograms();
    status.value = operationStatus('读取', '小程序', `已加载 ${programs.value.length} 个`, 'success');
  } catch (cause) {
    status.value = operationStatus('读取', '小程序', '失败', 'error');
    lastResult.value = cause.message;
  }
}

onMounted(refresh);

async function installSamples() {
  for (const p of SAMPLE_PROGRAMS) {
    await saveProgram(p);
  }
  await refresh();
  lastResult.value = `已装入 ${SAMPLE_PROGRAMS.length} 个示例小程序`;
}

async function installOne(p) {
  await saveProgram(p);
  await refresh();
  lastResult.value = `已装入：${p.label}`;
}

async function remove(name) {
  await deleteProgram(name);
  expanded.value = null;
  await refresh();
}

async function testRun(p) {
  // 用 params 的默认值做最小测试（仅对纯计算小程序有效）
  const testArgs = {};
  for (const k of Object.keys(p.params || {})) testArgs[k] = '1';
  try {
    const r = await runProgram(p, testArgs);
    lastResult.value = `测试「${p.label}」：${r}`;
  } catch (cause) {
    lastResult.value = `测试失败：${cause.message}`;
  }
}
</script>

<template>
  <div class="stack">
    <div>
      <h1 class="page-title">本地小程序</h1>
      <p class="page-subtitle">手机里跑的小工具，AI 可以跳起来调用</p>
    </div>

    <section class="panel stack">
      <div class="row">
        <h2>已安装（{{ programs.length }}）</h2>
        <button class="button small" @click="installSamples">装入示例</button>
      </div>
      <p class="status-line" :class="status.tone">{{ statusText(status) }}</p>
      <p v-if="lastResult" class="hint">{{ lastResult }}</p>

      <div v-if="!programs.length" class="empty">
        <p>还没装任何小程序。</p>
        <p class="muted">点「装入示例」可以拿到 3 个：<code>tip-calc</code>（小费计算）、<code>unit-convert</code>（温标换算）、<code>open-search</code>（知乎搜索）。</p>
        <p class="muted">然后在「AI 对话」里对它说话：「用 tip-calc 算一下，amount=200 rate=15」。</p>
      </div>

      <details
        v-for="p in programs"
        :key="p.name"
        class="program"
        :open="expanded === p.name"
        @toggle="expanded = $event.target.open ? p.name : null"
      >
        <summary>
          <span class="program-name">{{ p.label || p.name }}</span>
          <code class="program-id">{{ p.name }}</code>
        </summary>
        <p class="muted">{{ p.description || '（无说明）' }}</p>
        <div v-if="Object.keys(p.params || {}).length" class="params">
          <strong>参数：</strong>
          <span v-for="(desc, key) in p.params" :key="key" class="param">
            <code>{{ key }}</code>：{{ desc }}
          </span>
        </div>
        <details>
          <summary>查看 steps（{{ p.steps.length }}）</summary>
          <pre>{{ JSON.stringify(p.steps, null, 2) }}</pre>
        </details>
        <div class="row program-actions">
          <button class="button small" @click="testRun(p)">试运行</button>
          <button class="button small danger" @click="remove(p.name)">删除</button>
        </div>
      </details>
    </section>

    <section class="panel stack">
      <h2>可用 steps</h2>
      <p class="muted">编写 JSON manifest 时可以用的 step 类型：</p>
      <ul class="step-list">
        <li><code>compute</code>：算术表达式，存到 <code>_result</code></li>
        <li><code>set</code>：把模板字符串存到任意变量</li>
        <li><code>urlEncode</code>：把指定变量 URL-encode 后存到另一变量</li>
        <li><code>openUrl</code>：在浏览器打开 http(s) URL</li>
        <li><code>clipboardWrite</code>：把字符串写入剪贴板</li>
        <li><code>return</code>：返回文本，结束运行</li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.panel { padding: 16px; border-radius: var(--m-radius-lg); }
.panel h2 { margin: 0 0 10px; font-size: 15px; }
.hint { margin: 6px 0 0; font-size: 12px; color: var(--m-text-mid); }
.empty { padding: 18px 12px; text-align: center; color: var(--m-text-muted); border: 1px dashed var(--m-border); border-radius: var(--m-radius-md); }
.empty p { margin: 4px 0; }
.empty code { background: var(--m-bg-deep); padding: 1px 5px; border-radius: 3px; font-size: 12px; }
.program { border: 1px solid var(--m-border); border-radius: var(--m-radius-md); background: var(--m-bg-deep); padding: 8px 12px; }
.program + .program { margin-top: 8px; }
.program summary { cursor: pointer; list-style: none; display: flex; align-items: center; gap: 8px; }
.program summary::-webkit-details-marker { display: none; }
.program-name { font-weight: 600; }
.program-id { color: var(--m-text-muted); font-size: 11px; }
.params { margin: 8px 0; font-size: 12px; color: var(--m-text-muted); }
.param { display: inline-block; margin-right: 8px; }
.param code { background: var(--m-bg); padding: 1px 4px; border-radius: 3px; }
.program pre { margin: 8px 0 0; padding: 8px; background: var(--m-bg-code); color: #b8c8d8; border-radius: 4px; font-size: 11px; overflow-x: auto; white-space: pre; }
.program-actions { gap: 8px; margin-top: 8px; }
.button.danger { color: var(--m-danger-text); border-color: #9b5446; background: #3a2020; }
.step-list { padding-left: 20px; color: var(--m-text-mid); line-height: 1.8; font-size: 13px; }
.step-list code { background: var(--m-bg-deep); padding: 1px 5px; border-radius: 3px; font-size: 12px; }
</style>
