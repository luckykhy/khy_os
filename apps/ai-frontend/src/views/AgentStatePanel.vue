<!--
  AgentStatePanel.vue (C2) — lightweight 2D digital-human status panel.

  A pure-CSS four-state status orb (idle / listening / thinking / speaking)
  plus four Element Plus info cards: Persona, Memory, Tools, Activity. No 3D,
  no WebGL, no three.js — only Vue 3 + Element Plus + CSS theme tokens.

  All data is fed in via props from AIChat.vue's existing stream/ws dispatch;
  this component holds no transport logic of its own. The Persona card is
  populated from the read-only GET /api/ai/persona endpoint.
-->
<template>
  <div class="agent-state-panel">
    <!-- Status orb -->
    <div class="orb-wrap">
      <div :class="['orb', `orb--${orbState}`]">
        <span class="orb-core"></span>
      </div>
      <div class="orb-label">{{ orbLabel }}</div>
    </div>

    <!-- Persona card -->
    <el-card class="state-card" shadow="never">
      <template #header>
        <span class="card-title">Persona</span>
      </template>
      <div v-if="persona && persona.present">
        <div v-for="sec in persona.sections" :key="sec.title" class="persona-sec">
          <div class="persona-sec-title">{{ sec.title }}</div>
          <div v-for="(line, i) in sec.lines" :key="i" class="persona-sec-line">{{ line }}</div>
        </div>
      </div>
      <div v-else class="card-empty">未设置 AI 人格档案（可选）—— 配置后可定制小K的语气与回答风格</div>
    </el-card>

    <!-- Memory card -->
    <el-card class="state-card" shadow="never">
      <template #header>
        <span class="card-title">Memory</span>
        <span class="card-count">{{ memoryItems.length }}</span>
      </template>
      <div v-if="memoryItems.length">
        <div v-for="(m, i) in memoryItems.slice(-4)" :key="i" class="card-line">{{ m }}</div>
      </div>
      <div v-else class="card-empty">暂无记忆条目</div>
    </el-card>

    <!-- Tools card -->
    <el-card class="state-card" shadow="never">
      <template #header>
        <span class="card-title">Tools</span>
        <span class="card-count">{{ toolCalls.length }}</span>
      </template>
      <div v-if="toolCalls.length">
        <div v-for="(t, i) in toolCalls.slice(-5)" :key="i" class="card-line">
          <span class="tool-dot"></span>{{ t }}
        </div>
      </div>
      <div v-else class="card-empty">暂无工具调用</div>
    </el-card>

    <!-- Activity card -->
    <el-card class="state-card" shadow="never">
      <template #header>
        <span class="card-title">Activity</span>
      </template>
      <div v-if="activity.length">
        <div v-for="(a, i) in activity.slice(-5)" :key="i" class="card-line">{{ a }}</div>
      </div>
      <div v-else class="card-empty">暂无活动</div>
    </el-card>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  orbState: { type: String, default: 'idle' },
  persona: { type: Object, default: () => ({ present: false, sections: [] }) },
  memoryItems: { type: Array, default: () => [] },
  toolCalls: { type: Array, default: () => [] },
  activity: { type: Array, default: () => [] },
})

const ORB_LABELS = {
  idle: '待命',
  listening: '聆听中',
  thinking: '思考中',
  speaking: '回应中',
}

const orbLabel = computed(() => ORB_LABELS[props.orbState] || ORB_LABELS.idle)
</script>

<style scoped>
.agent-state-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.orb-wrap {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 12px 0;
}

.orb {
  width: 72px;
  height: 72px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  transition: background 0.4s ease, box-shadow 0.4s ease, width 0.3s ease, height 0.3s ease;
}

.orb-core {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: var(--khy-bg, #fff);
  opacity: 0.85;
  transition: width 0.3s ease, height 0.3s ease;
}

/* idle — calm grey, no animation, shrunk to a quiet dot so it does not dominate
   the panel as an empty placeholder; it grows back when a conversation starts. */
.orb--idle {
  width: 40px;
  height: 40px;
  background: radial-gradient(circle, #9aa4b2 0%, #6b7280 100%);
  box-shadow: 0 0 0 3px rgba(107, 114, 128, 0.12);
}

.orb--idle .orb-core {
  width: 16px;
  height: 16px;
}

/* listening — steady blue pulse */
.orb--listening {
  background: radial-gradient(circle, #5b9dff 0%, #2563eb 100%);
  box-shadow: 0 0 0 4px rgba(37, 99, 235, 0.2);
  animation: orb-pulse 1.8s ease-in-out infinite;
}

/* thinking — amber, faster pulse */
.orb--thinking {
  background: radial-gradient(circle, #fbbf6b 0%, #d97706 100%);
  box-shadow: 0 0 0 4px rgba(217, 119, 6, 0.2);
  animation: orb-pulse 0.9s ease-in-out infinite;
}

/* speaking — green, lively pulse */
.orb--speaking {
  background: radial-gradient(circle, #5fd68a 0%, #16a34a 100%);
  box-shadow: 0 0 0 4px rgba(22, 163, 74, 0.22);
  animation: orb-pulse 0.6s ease-in-out infinite;
}

@keyframes orb-pulse {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.08); }
}

.orb-label {
  font-size: 13px;
  color: var(--khy-text-secondary, #6b7280);
}

.state-card {
  border: 1px solid var(--khy-border, #ebeef5);
}

.card-title {
  font-weight: 600;
  font-size: 13px;
}

.card-count {
  float: right;
  font-size: 12px;
  color: var(--khy-text-secondary, #909399);
}

.card-line {
  font-size: 12px;
  color: var(--khy-text, #303133);
  padding: 2px 0;
  word-break: break-all;
}

.card-empty {
  font-size: 12px;
  color: var(--khy-text-secondary, #c0c4cc);
}

.persona-sec {
  margin-bottom: 6px;
}

.persona-sec-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--khy-primary, #409eff);
}

.persona-sec-line {
  font-size: 12px;
  color: var(--khy-text-secondary, #606266);
  padding-left: 6px;
}

.tool-dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--khy-primary, #409eff);
  margin-right: 6px;
}
</style>
