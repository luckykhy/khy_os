<template>
  <div class="khyos-view">
    <div class="khyos-toolbar">
      <div class="khyos-title">
        <el-icon><Monitor /></el-icon>
        <span>KHY OS 桌面</span>
        <el-tag :type="statusTag.type" size="small" effect="dark">{{ statusTag.label }}</el-tag>
      </div>
      <div class="khyos-actions">
        <el-button size="small" @click="goTerminal">返回终端</el-button>
        <el-button size="small" :disabled="connecting" @click="reconnect">重新连接</el-button>
      </div>
    </div>
    <div ref="stageEl" class="khyos-stage">
      <canvas
        ref="canvasEl"
        class="khyos-canvas"
        :class="{ 'khyos-canvas--focused': inputFocused }"
        tabindex="0"
        @keydown="onCanvasKeydown"
        @mousemove="onCanvasMouseMove"
        @mousedown="onCanvasMouseButton"
        @mouseup="onCanvasMouseButton"
        @contextmenu.prevent
        @focus="inputFocused = true"
        @blur="inputFocused = false"
      ></canvas>
      <div v-if="status !== 'streaming' || !firstFrame" class="khyos-overlay">
        <el-icon class="is-loading" v-if="connecting || status === 'booting' || status === 'capturing'"><Loading /></el-icon>
        <div class="khyos-overlay-text">{{ overlayText }}</div>
      </div>
    </div>
    <div class="khyos-hint">
      桌面画面由内核 VGA 帧缓冲经 QEMU <code>screendump</code> 截取，实时推送至浏览器。
      <strong>点击画面后</strong>可用<strong>键盘 / 鼠标</strong>交互（实验特性，经 QEMU 注入内核）。
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import request from '@/api/request'
import { useUserStore } from '@/stores/user'
import { Monitor, Loading } from '@element-plus/icons-vue'

const router = useRouter()
const userStore = useUserStore()

const stageEl = ref(null)
const canvasEl = ref(null)
const status = ref('idle') // idle|booting|streaming|capturing|error|stopped
const connecting = ref(false)
const firstFrame = ref(false)
const errorText = ref('')
const inputFocused = ref(false)

let ws = null
let authed = false
let manualClose = false
let ctx = null

const statusTag = computed(() => {
  switch (status.value) {
    case 'booting': return { type: 'warning', label: '启动中' }
    case 'streaming': return { type: 'success', label: '实时' }
    case 'capturing': return { type: 'warning', label: '采集中' }
    case 'error': return { type: 'danger', label: '错误' }
    case 'stopped': return { type: 'info', label: '已停止' }
    default: return { type: 'info', label: '未连接' }
  }
})

const overlayText = computed(() => {
  if (errorText.value) return errorText.value
  if (status.value === 'capturing') return '正在采集桌面画面…'
  if (status.value === 'booting' || connecting.value) return '正在连接内核桌面…'
  if (status.value === 'stopped') return '桌面已停止'
  return '等待画面…'
})

// Mirror KhyOsTerminal.vue's resolveWsUrl so both views share the /ws endpoint.
function resolveWsUrl(path) {
  const normalizedPath = `/${String(path || '/ws').replace(/^\/+/, '')}`
  if (typeof window === 'undefined') return normalizedPath
  const origin = String(window.location.origin || '').trim()
  const base = String(request.defaults.baseURL || '').trim()
  const url = base ? new URL(base, origin) : new URL(origin)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = normalizedPath
  url.search = ''
  url.hash = ''
  return url.toString()
}

function drawFrame(b64, width, height) {
  const canvas = canvasEl.value
  if (!canvas) return
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width
    canvas.height = height
  }
  if (!ctx) ctx = canvas.getContext('2d')
  const img = new Image()
  img.onload = () => {
    try { ctx.drawImage(img, 0, 0, width, height) } catch { /* ignore */ }
    firstFrame.value = true
  }
  img.src = `data:image/png;base64,${b64}`
}

// ── Desktop input (browser → /ws → QEMU HMP → kernel) ──────────────────────
// The stream is read-only until the canvas is focused; then keyboard and mouse
// events are forwarded as 'khyos_desktop_input' frames. Mouse motion is sent as
// RELATIVE deltas (MouseEvent.movementX/Y) because the guest uses a PS/2 mouse
// and accumulates the cursor position itself. Buttons use the browser's
// MouseEvent.buttons bitmask (bit0=left, bit1=right, bit2=middle), which matches
// QEMU's mouse_button state order directly. All sends are best-effort and no-op
// unless authed — a dropped input must never break the view.
function sendInput(payload) {
  if (!ws || !authed) return
  try {
    ws.send(JSON.stringify({ type: 'khyos_desktop_input', ...payload }))
  } catch { /* best-effort — dropped input is non-fatal */ }
}

function onCanvasKeydown(ev) {
  if (!inputFocused.value) return
  // Keep the guest from losing keys to browser defaults (Backspace navigation,
  // Tab focus change, arrow scrolling) while the canvas is focused.
  ev.preventDefault()
  sendInput({ kind: 'key', key: ev.key, ctrlKey: ev.ctrlKey, altKey: ev.altKey })
}

function onCanvasMouseMove(ev) {
  if (!inputFocused.value) return
  // Relative deltas straight from the browser; the guest kernel clamps and draws
  // its own cursor. Skip zero-motion frames to avoid flooding the HMP channel.
  const dx = ev.movementX | 0
  const dy = ev.movementY | 0
  if (dx === 0 && dy === 0) return
  sendInput({ kind: 'mouse', dx, dy })
}

function onCanvasMouseButton(ev) {
  // mousedown implicitly focuses the canvas (tabindex); forward the button state.
  const buttons = ev.buttons | 0
  sendInput({ kind: 'mouse', buttons })
}

function closeSocket() {
  if (ws) {
    manualClose = true
    try {
      if (authed) ws.send(JSON.stringify({ type: 'khyos_desktop_stop' }))
    } catch { /* ignore */ }
    try { ws.close() } catch { /* ignore */ }
    ws = null
  }
  authed = false
}

function connect() {
  if (connecting.value) return
  connecting.value = true
  manualClose = false
  authed = false
  errorText.value = ''
  status.value = 'booting'

  ws = new WebSocket(resolveWsUrl('/ws'))

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'auth', token: userStore.token || '' }))
  }

  ws.onmessage = (event) => {
    let msg = null
    try { msg = JSON.parse(String(event.data || '{}')) } catch { return }
    const type = String(msg?.type || '')

    if (type === 'auth_ok') {
      authed = true
      connecting.value = false
      // Boot the kernel (idempotent if a terminal session already started it),
      // then begin the desktop frame stream.
      ws.send(JSON.stringify({ type: 'khyos_start' }))
      ws.send(JSON.stringify({ type: 'khyos_desktop_start' }))
      return
    }
    if (type === 'auth_error') {
      connecting.value = false
      status.value = 'error'
      errorText.value = `认证失败: ${msg.message || ''}`
      return
    }
    if (!authed) return

    if (type === 'khyos_frame') {
      status.value = 'streaming'
      drawFrame(msg.data || '', msg.width || 1024, msg.height || 768)
      return
    }
    if (type === 'khyos_desktop_status') {
      if (msg.status === 'error' || msg.status === 'unavailable') {
        status.value = 'error'
        errorText.value = msg.message || '桌面查看不可用'
      } else if (msg.status === 'capturing') {
        // Transient — keep whatever frames we have; show a soft state pre-first-frame.
        if (!firstFrame.value) status.value = 'capturing'
      } else if (msg.status === 'streaming') {
        if (!firstFrame.value) status.value = 'booting'
      } else if (msg.status === 'stopped') {
        status.value = 'stopped'
      }
      return
    }
    if (type === 'khyos_status') {
      if (msg.status === 'error') { status.value = 'error'; errorText.value = msg.message || '内核启动失败' }
      if (msg.status === 'exited') { status.value = 'stopped'; errorText.value = 'QEMU 已退出' }
      return
    }
    if (type === 'error') {
      errorText.value = msg.message || ''
    }
  }

  ws.onerror = () => {
    connecting.value = false
    status.value = 'error'
    errorText.value = 'WebSocket 连接失败'
  }

  ws.onclose = () => {
    connecting.value = false
    authed = false
    if (!manualClose && status.value === 'streaming') {
      status.value = 'stopped'
      errorText.value = '连接已断开。点击「重新连接」继续。'
    }
  }
}

function reconnect() {
  closeSocket()
  firstFrame.value = false
  connect()
}

function goTerminal() {
  router.push('/khyos')
}

onMounted(() => {
  connect()
})

onBeforeUnmount(() => {
  closeSocket()
})
</script>

<style scoped>
.khyos-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  padding: 12px;
  box-sizing: border-box;
}
.khyos-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}
.khyos-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
}
.khyos-stage {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #0b0e14;
  border: 1px solid var(--el-border-color, #2a2f3a);
  border-radius: 8px;
  overflow: hidden;
}
.khyos-canvas {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  image-rendering: pixelated;
  outline: none;
}
.khyos-canvas--focused {
  box-shadow: 0 0 0 2px var(--el-color-primary, #409eff);
  cursor: none;
}
.khyos-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: var(--el-text-color-secondary, #909399);
  background: rgba(11, 14, 20, 0.85);
}
.khyos-overlay .el-icon {
  font-size: 28px;
}
.khyos-overlay-text {
  font-size: 13px;
}
.khyos-hint {
  margin-top: 8px;
  font-size: 12px;
  color: var(--el-text-color-secondary, #909399);
}
.khyos-hint code {
  background: var(--el-fill-color-light, #1f2430);
  padding: 1px 5px;
  border-radius: 4px;
}
</style>
