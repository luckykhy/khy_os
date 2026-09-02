<script setup>
import { onMounted, ref } from 'vue';
import {
  listSkills,
  saveSkill,
  deleteSkill,
  SAMPLE_SKILLS,
} from '@/api/programRuntime';
import { operationStatus, statusText } from '@/api/status';

const skills = ref([]);
const expanded = ref(null);
const status = ref(operationStatus('读取', 'Skills', '等待开始'));
const lastResult = ref('');

async function refresh() {
  status.value = operationStatus('读取', 'Skills', '进行中');
  try {
    skills.value = await listSkills();
    status.value = operationStatus('读取', 'Skills', `已加载 ${skills.value.length} 个`, 'success');
  } catch (cause) {
    status.value = operationStatus('读取', 'Skills', '失败', 'error');
    lastResult.value = cause.message;
  }
}

onMounted(refresh);

async function installSamples() {
  for (const s of SAMPLE_SKILLS) await saveSkill(s);
  await refresh();
  lastResult.value = `已装入 ${SAMPLE_SKILLS.length} 个示例 Skill`;
}

async function installOne(s) {
  await saveSkill(s);
  await refresh();
  lastResult.value = `已装入：${s.label}`;
}

async function remove(name) {
  await deleteSkill(name);
  expanded.value = null;
  await refresh();
}
</script>

<template>
  <div class="stack">
    <div>
      <h1 class="page-title">Skills 库</h1>
      <p class="page-subtitle">手机里存的可复用 prompt 流程，AI 调名就能跳</p>
    </div>

    <section class="panel stack">
      <div class="row">
        <h2>已安装（{{ skills.length }}）</h2>
        <button class="button small" @click="installSamples">装入示例</button>
      </div>
      <p class="status-line" :class="status.tone">{{ statusText(status) }}</p>
      <p v-if="lastResult" class="hint">{{ lastResult }}</p>

      <div v-if="!skills.length" class="empty">
        <p>还没有 Skill。</p>
        <p class="muted">点「装入示例」可以拿到 2 个：<code>morning-briefing</code>（晨间简报）、<code>summarize-clipboard</code>（总结剪贴板）。</p>
        <p class="muted">然后在「AI 对话」里对它说话：「用 morning-briefing 给我一段简报，tone=punchy」。</p>
      </div>

      <details
        v-for="s in skills"
        :key="s.name"
        class="skill"
        :open="expanded === s.name"
        @toggle="expanded = $event.target.open ? s.name : null"
      >
        <summary>
          <span class="skill-name">{{ s.label || s.name }}</span>
          <code class="skill-id">{{ s.name }}</code>
        </summary>
        <p class="muted">{{ s.description || '（无说明）' }}</p>
        <div v-if="Object.keys(s.params || {}).length" class="params">
          <strong>参数：</strong>
          <span v-for="(desc, key) in s.params" :key="key" class="param">
            <code>{{ key }}</code>：{{ desc }}
          </span>
        </div>
        <details>
          <summary>查看 steps（{{ s.steps.length }}）</summary>
          <pre>{{ JSON.stringify(s.steps, null, 2) }}</pre>
        </details>
        <div class="row skill-actions">
          <button class="button small danger" @click="remove(s.name)">删除</button>
        </div>
      </details>
    </section>

    <section class="panel stack">
      <h2>Skill vs 小程序</h2>
      <p class="muted">两者用同套 step 解释器。区别是定位：</p>
      <ul>
        <li><strong>小程序（khy.program）</strong>：可独立运行的小工具，能完成单一具体任务（小费计算、打开搜索）</li>
        <li><strong>Skill（khy.skill）</strong>：可复用 prompt 流程，通常嵌在 AI 对话里被多次调用（晨间简报、总结剪贴板）</li>
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
.skill { border: 1px solid var(--m-border); border-radius: var(--m-radius-md); background: var(--m-bg-deep); padding: 8px 12px; }
.skill + .skill { margin-top: 8px; }
.skill summary { cursor: pointer; list-style: none; display: flex; align-items: center; gap: 8px; }
.skill summary::-webkit-details-marker { display: none; }
.skill-name { font-weight: 600; }
.skill-id { color: var(--m-text-muted); font-size: 11px; }
.params { margin: 8px 0; font-size: 12px; color: var(--m-text-muted); }
.param { display: inline-block; margin-right: 8px; }
.param code { background: var(--m-bg); padding: 1px 4px; border-radius: 3px; }
.skill pre { margin: 8px 0 0; padding: 8px; background: var(--m-bg-code); color: #b8c8d8; border-radius: 4px; font-size: 11px; overflow-x: auto; white-space: pre; }
.skill-actions { gap: 8px; margin-top: 8px; }
.button.danger { color: var(--m-danger-text); border-color: #9b5446; background: #3a2020; }
.button.small { padding: 6px 10px; font-size: 12px; }
ul { padding-left: 20px; color: var(--m-text-mid); line-height: 1.7; font-size: 13px; }
ul strong { color: var(--m-text); }
</style>
