<template>
  <div class="first-launch-loader" v-if="visible">
    <div class="loader-card">
      <div class="brand">KHY-Quant</div>
      <h2>首次安装资源初始化</h2>
      <p class="status-text">{{ statusText }}</p>

      <div class="progress-track" role="progressbar" :aria-valuenow="safeProgress" aria-valuemin="0" aria-valuemax="100">
        <div class="progress-fill" :style="{ width: `${safeProgress}%` }" />
      </div>

      <div class="progress-meta">
        <span>{{ safeProgress }}%</span>
        <span>{{ stepText }}</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  visible: { type: Boolean, default: false },
  progress: { type: Number, default: 0 },
  statusText: { type: String, default: '正在准备应用资源...' },
  stepText: { type: String, default: '初始化中' }
})

const safeProgress = computed(() => {
  if (Number.isNaN(Number(props.progress))) return 0
  return Math.max(0, Math.min(100, Math.round(props.progress)))
})
</script>

<style scoped>
.first-launch-loader {
  position: fixed;
  inset: 0;
  z-index: 12000;
  background: radial-gradient(circle at 20% 20%, #1f2937, #0f172a 58%, #020617);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}

.loader-card {
  width: min(560px, 100%);
  border-radius: 18px;
  padding: 28px 24px;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.16);
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.35);
}

.brand {
  font-size: 13px;
  letter-spacing: 1.8px;
  color: #93c5fd;
  margin-bottom: 8px;
  font-weight: 700;
}

h2 {
  color: #f8fafc;
  font-size: 22px;
  margin: 0;
}

.status-text {
  color: #cbd5e1;
  font-size: 14px;
  margin: 12px 0 16px;
  line-height: 1.5;
}

.progress-track {
  width: 100%;
  height: 10px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.12);
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, #38bdf8, #3b82f6 55%, #6366f1);
  transition: width 280ms ease;
}

.progress-meta {
  display: flex;
  justify-content: space-between;
  color: #dbeafe;
  font-size: 12px;
  margin-top: 10px;
}
</style>
