<!--
  GlobalProgressBar.vue — a thin, fixed top-of-viewport progress bar that is
  visible whenever the app is loading (any in-flight HTTP request or an in-progress
  route navigation / lazy-chunk download). It gives constant feedback so the UI
  never looks frozen during slow backend calls or first-visit chunk fetches.

  Behavior: while loading it "trickles" toward 90% (it can never know the real
  percent of an arbitrary request, so it asymptotes); when loading ends it snaps
  to 100% and fades out. Mounted once at the app root (App.vue).
-->
<template>
  <div
    class="global-progress"
    :class="{ 'is-visible': visible }"
    role="progressbar"
    aria-label="加载进度"
    aria-hidden="true"
  >
    <div class="global-progress__bar" :style="{ width: `${width}%` }"></div>
  </div>
</template>

<script setup>
import { onBeforeUnmount, ref, watch } from 'vue'
import { useGlobalLoading } from '@/composables/useGlobalLoading'

const { isLoading } = useGlobalLoading()

const visible = ref(false)
const width = ref(0)
let trickleTimer = null
let doneTimer = null

function clearTimers() {
  if (trickleTimer) { clearInterval(trickleTimer); trickleTimer = null }
  if (doneTimer) { clearTimeout(doneTimer); doneTimer = null }
}

function startTrickle() {
  if (trickleTimer) return
  trickleTimer = setInterval(() => {
    // Asymptotic approach to 90% — slows down as it nears the cap so the bar
    // keeps moving (alive) without ever pretending to be done.
    const remaining = 90 - width.value
    if (remaining > 0.5) {
      width.value = Math.min(90, width.value + remaining * 0.12)
    }
  }, 280)
}

watch(isLoading, (loading) => {
  clearTimers()
  if (loading) {
    visible.value = true
    width.value = Math.max(width.value, 10)
    startTrickle()
  } else {
    // Snap to full, then fade out and reset.
    width.value = 100
    doneTimer = setTimeout(() => {
      visible.value = false
      width.value = 0
    }, 320)
  }
}, { immediate: true })

onBeforeUnmount(clearTimers)
</script>

<style scoped>
.global-progress {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  height: 3px;
  z-index: 3000;
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.32s ease;
}

.global-progress.is-visible {
  opacity: 1;
}

.global-progress__bar {
  height: 100%;
  width: 0;
  background: var(--el-color-primary, #409eff);
  box-shadow: 0 0 6px var(--el-color-primary-light-3, #79bbff);
  transition: width 0.28s ease;
}
</style>
