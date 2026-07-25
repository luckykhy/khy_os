<template>
  <div class="khyos-view">
    <div class="khyos-toolbar">
      <div class="khyos-title">
        <el-icon><Cpu /></el-icon>
        <span>KHY OS 内核终端</span>
        <el-tag :type="statusTag.type" size="small" effect="dark">{{ statusTag.label }}</el-tag>
      </div>
      <div class="khyos-actions">
        <el-button size="small" type="primary" :icon="Monitor" @click="enterDesktop">进入桌面</el-button>
        <el-button size="small" :disabled="connecting" @click="reconnect">重新连接</el-button>
        <el-button size="small" type="danger" plain :disabled="status !== 'ready'" @click="stopKernel">停止内核</el-button>
      </div>
    </div>
    <div ref="termEl" class="khyos-term"></div>
    <div class="khyos-hint">
      裸机内核运行于 QEMU，串口桥接至浏览器。试试 <code>help</code> / <code>ps</code> / <code>ls /bin</code>。
      <code>/disk</code> 下文件持久化（KhyFS）。
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onBeforeUnmount, shallowRef } from 'vue'
import { useRouter } from 'vue-router'
import request from '@/api/request'
import { useUserStore } from '@/stores/user'
import { Cpu, Monitor } from '@element-plus/icons-vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

const userStore = useUserStore()
const router = useRouter()

const termEl = ref(null)
const status = ref('idle') // idle|booting|ready|error|exited|stopped
const connecting = ref(false)

let term = null
let fitAddon = null
let ws = null
let authed = false
let resizeObserver = null
let manualClose = false

const statusTag = computed(() => {
  switch (status.value) {
    case 'booting': return { type: 'warning', label: '启动中' }
    case 'ready': return { type: 'success', label: '已连接' }
    case 'error': return { type: 'danger', label: '错误' }
    case 'exited': return { type: 'info', label: '已退出' }
    case 'stopped': return { type: 'info', label: '已停止' }
    default: return { type: 'info', label: '未连接' }
  }
})

// Mirror AIChat.vue's resolveWsUrl so the terminal uses the same /ws endpoint.
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

function b64encode(str) {
  // str is a binary string of bytes; encode to base64.
  return btoa(str)
}

function b64decodeToUint8(b64) {
  const bin = atob(b64)
  const arr = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
  return arr
}

function closeSocket() {
  if (ws) {
    manualClose = true
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
      // Boot the kernel for this session.
      ws.send(JSON.stringify({ type: 'khyos_start' }))
      return
    }
    if (type === 'auth_error') {
      connecting.value = false
      status.value = 'error'
      writeLine(`\x1b[31m认证失败: ${msg.message || ''}\x1b[0m`)
      return
    }
    if (!authed) return

    if (type === 'khyos_data') {
      const bytes = b64decodeToUint8(msg.data || '')
      if (term) term.write(bytes)
      return
    }
    if (type === 'khyos_status') {
      status.value = msg.status || status.value
      if (msg.status === 'error') writeLine(`\x1b[31m[内核] ${msg.message || '启动失败'}\x1b[0m`)
      if (msg.status === 'exited') writeLine(`\x1b[90m[内核] QEMU 已退出\x1b[0m`)
      return
    }
    if (type === 'error') {
      writeLine(`\x1b[31m[服务] ${msg.message || ''}\x1b[0m`)
    }
  }

  ws.onerror = () => {
    connecting.value = false
    status.value = 'error'
    writeLine('\x1b[31mWebSocket 连接失败\x1b[0m')
  }

  ws.onclose = () => {
    connecting.value = false
    authed = false
    if (!manualClose && status.value === 'ready') {
      status.value = 'exited'
      writeLine('\x1b[90m连接已断开。点击「重新连接」继续。\x1b[0m')
    }
  }
}

function writeLine(s) {
  if (term) term.write(`\r\n${s}\r\n`)
}

function reconnect() {
  closeSocket()
  if (term) term.clear()
  connect()
}

function stopKernel() {
  if (ws && authed) ws.send(JSON.stringify({ type: 'khyos_stop' }))
}

// Navigate to the graphical desktop viewer. The kernel keeps running for this
// session (the desktop view reuses the same /ws session and re-sends khyos_start,
// which is idempotent server-side), so the framebuffer is available immediately.
function enterDesktop() {
  router.push('/khyos/desktop')
}

onMounted(() => {
  term = new Terminal({
    cursorBlink: true,
    fontFamily: 'Menlo, Consolas, "DejaVu Sans Mono", monospace',
    fontSize: 14,
    theme: { background: '#0b0e14', foreground: '#d7d7d7' },
    convertEol: false,
  })
  fitAddon = new FitAddon()
  term.loadAddon(fitAddon)
  term.open(termEl.value)
  try { fitAddon.fit() } catch { /* ignore */ }

  // Keystrokes → serial input bytes (base64 over /ws). xterm's onData yields a
  // string of bytes already encoded the way a terminal would send them (\r for
  // Enter, \x7f for backspace, \x1b[A for arrows) — exactly what the kernel
  // shell parses, so we forward verbatim.
  term.onData((data) => {
    if (ws && authed && status.value === 'ready') {
      ws.send(JSON.stringify({ type: 'khyos_input', data: b64encode(data) }))
    }
  })

  resizeObserver = new ResizeObserver(() => {
    try { fitAddon.fit() } catch { /* ignore */ }
  })
  resizeObserver.observe(termEl.value)

  connect()
})

onBeforeUnmount(() => {
  if (ws && authed) { try { ws.send(JSON.stringify({ type: 'khyos_stop' })) } catch { /* ignore */ } }
  closeSocket()
  if (resizeObserver) { try { resizeObserver.disconnect() } catch { /* ignore */ } resizeObserver = null }
  if (term) { try { term.dispose() } catch { /* ignore */ } term = null }
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
.khyos-term {
  flex: 1;
  min-height: 0;
  background: #0b0e14;
  border: 1px solid var(--el-border-color, #2a2f3a);
  border-radius: 8px;
  padding: 8px;
  overflow: hidden;
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
