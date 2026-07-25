<template>
  <div class="channel-health-indicator" @click="expanded = !expanded">
    <span
      class="health-dot"
      :class="dotClass"
      :title="dotTitle"
    />
    <span v-if="showLabel" class="health-label">{{ healthLabel }}</span>

    <!-- Expanded popover -->
    <transition name="fade">
      <div v-if="expanded" class="health-popover" @click.stop>
        <div class="popover-header">
          <span>AI Channel Status</span>
          <span class="close-btn" @click="expanded = false">&times;</span>
        </div>
        <div v-if="channels.length === 0" class="popover-empty">
          No channels detected
        </div>
        <div v-else class="popover-list">
          <div
            v-for="ch in channels"
            :key="ch.key"
            class="channel-row"
          >
            <span class="ch-dot" :class="statusClass(ch.status)" />
            <span class="ch-name">{{ ch.key }}</span>
            <span class="ch-state">{{ ch.circuitState }}</span>
            <span v-if="ch.cooldownRemainingMs > 0" class="ch-cooldown">
              {{ Math.ceil(ch.cooldownRemainingMs / 1000) }}s
            </span>
          </div>
        </div>
        <div v-if="activeAdapter" class="popover-active">
          Active: <strong>{{ activeAdapter }}</strong>
        </div>
      </div>
    </transition>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { useChannelHealth } from '@/composables/useChannelHealth'

const props = defineProps({
  wsService: { type: Object, default: null },
  showLabel: { type: Boolean, default: false },
})

const { channels, activeAdapter, overallHealth, healthyCount, totalCount } = useChannelHealth(props.wsService)
const expanded = ref(false)

const dotClass = computed(() => ({
  healthy: overallHealth.value === 'healthy',
  degraded: overallHealth.value === 'degraded',
  critical: overallHealth.value === 'critical',
  unknown: overallHealth.value === 'unknown',
}))

const dotTitle = computed(() => {
  if (overallHealth.value === 'unknown') return 'Channel status unknown'
  return `${healthyCount.value}/${totalCount.value} channels healthy`
})

const healthLabel = computed(() => {
  if (overallHealth.value === 'unknown') return ''
  return `${healthyCount.value}/${totalCount.value}`
})

function statusClass(status) {
  return {
    healthy: status === 'healthy',
    degraded: status === 'degraded',
    critical: status === 'cooldown',
  }
}
</script>

<style scoped>
.channel-health-indicator {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
  user-select: none;
}

.health-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
  transition: background-color 0.3s;
}
.health-dot.healthy { background-color: #52c41a; }
.health-dot.degraded { background-color: #faad14; }
.health-dot.critical { background-color: #ff4d4f; }
.health-dot.unknown { background-color: #999; }

.health-label {
  font-size: 11px;
  color: #999;
}

.health-popover {
  position: absolute;
  top: 100%;
  right: 0;
  z-index: 1000;
  min-width: 240px;
  background: var(--el-bg-color, #1a1a1a);
  border: 1px solid var(--el-border-color, #333);
  border-radius: 8px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
  padding: 8px;
  margin-top: 4px;
}

.popover-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 12px;
  font-weight: 600;
  color: var(--el-text-color-primary, #fff);
  padding-bottom: 6px;
  border-bottom: 1px solid var(--el-border-color, #333);
  margin-bottom: 6px;
}

.close-btn {
  cursor: pointer;
  font-size: 16px;
  color: #999;
}

.popover-empty {
  font-size: 12px;
  color: #666;
  padding: 8px 0;
  text-align: center;
}

.popover-list {
  max-height: 200px;
  overflow-y: auto;
}

.channel-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 0;
  font-size: 12px;
}

.ch-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}
.ch-dot.healthy { background-color: #52c41a; }
.ch-dot.degraded { background-color: #faad14; }
.ch-dot.critical { background-color: #ff4d4f; }

.ch-name {
  flex: 1;
  color: var(--el-text-color-regular, #ccc);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ch-state {
  color: #888;
  font-size: 11px;
}

.ch-cooldown {
  color: #ff4d4f;
  font-size: 11px;
  font-weight: 500;
}

.popover-active {
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px solid var(--el-border-color, #333);
  font-size: 11px;
  color: #999;
}

.fade-enter-active, .fade-leave-active {
  transition: opacity 0.2s;
}
.fade-enter-from, .fade-leave-to {
  opacity: 0;
}
</style>
