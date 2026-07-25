<template>
  <!--
    KhyFloatBall — 全局「Khy 悬浮球」。仅登录后(有 token)且非登录页显示。
    左键点击展开动作菜单;右键(contextmenu)直达「打开 khy.md」(用户明确诉求)。
    三动作:
      · 启动 Khy(内核终端)→ 前端路由跳 /khyos(该页自举内核)。
      · 启动系统托盘        → 经 /ws 发 khyos_tray_start(后端 `khy tray --detach` 同 SSOT)。
      · 打开 khy.md         → 经 /ws 发 khyos_md_open,拿回同源 URL 后新标签页打开。
    悬浮球可拖拽,松手吸附最近横向边缘并记忆位置(localStorage);动作进行中转圈禁点。
    所有本机动作经既有 /ws 鉴权总线,失败 fail-soft 弹提示,绝不打断页面。
  -->
  <div
    v-if="visible"
    ref="rootEl"
    class="khy-fb"
    :class="{ 'is-dragging': dragging, 'is-open': menuOpen || tasksOpen, 'is-busy': busy }"
    :style="ballStyle"
  >
    <transition name="khy-fb-menu">
      <div
        v-if="menuOpen"
        class="khy-fb__menu"
        :class="{ 'khy-fb__menu--flip': menuOnLeft }"
        @click.stop
        @pointerdown.stop
      >
        <div class="khy-fb__menu-head">
          <span class="khy-fb__menu-dot" />
          Khy 快捷操作
        </div>
        <button class="khy-fb__item" :disabled="busy" @click="launchKhy">
          <span class="khy-fb__item-ico" v-html="ICONS.kernel" />
          <span class="khy-fb__item-body">
            <span class="khy-fb__item-title">启动 Khy</span>
            <span class="khy-fb__item-sub">进入内核终端</span>
          </span>
        </button>
        <button class="khy-fb__item" :disabled="busy" @click="startTray">
          <span class="khy-fb__item-ico" v-html="ICONS.tray" />
          <span class="khy-fb__item-body">
            <span class="khy-fb__item-title">启动系统托盘</span>
            <span class="khy-fb__item-sub">后台常驻 · khy tray</span>
          </span>
        </button>
        <button class="khy-fb__item" :disabled="busy" @click="openKhyMd">
          <span class="khy-fb__item-ico" v-html="ICONS.doc" />
          <span class="khy-fb__item-body">
            <span class="khy-fb__item-title">打开 khy.md</span>
            <span class="khy-fb__item-sub">右键悬浮球可直达</span>
          </span>
        </button>
        <button class="khy-fb__item" @click="openTasks">
          <span class="khy-fb__item-ico" v-html="ICONS.tasks" />
          <span class="khy-fb__item-body">
            <span class="khy-fb__item-title">任务记录</span>
            <span class="khy-fb__item-sub">与 TUI 实时同步</span>
          </span>
        </button>
      </div>
    </transition>

    <transition name="khy-fb-menu">
      <div
        v-if="tasksOpen"
        class="khy-fb__tasks"
        :class="{ 'khy-fb__tasks--flip': menuOnLeft }"
        @click.stop
        @pointerdown.stop
      >
        <div class="khy-fb__tasks-head">
          <span class="khy-fb__tasks-title">
            <span class="khy-fb__live-dot" :class="`is-${tasksStatus}`" />
            TUI 任务记录
          </span>
          <span class="khy-fb__tasks-count" v-if="tasksStatus === 'ok'">{{ tasks.length }}</span>
          <button class="khy-fb__tasks-close" type="button" aria-label="关闭" @click="closeTasks">×</button>
        </div>

        <div v-if="tasksStatus === 'connecting'" class="khy-fb__tasks-hint">正在连接…</div>
        <div v-else-if="tasksStatus === 'disabled'" class="khy-fb__tasks-hint">本机动作已关闭(KHY_WEB_LOCAL_ACTIONS)</div>
        <div v-else-if="tasksStatus === 'error'" class="khy-fb__tasks-hint is-error" @click="startTaskSync">
          同步失败,点此重试
        </div>
        <div v-else-if="!tasks.length" class="khy-fb__tasks-hint">暂无任务记录</div>

        <ul v-else class="khy-fb__tasks-list">
          <li
            v-for="t in tasks"
            :key="t.id"
            class="khy-fb__task"
            :class="`is-${t.status}`"
          >
            <span class="khy-fb__task-ico" aria-hidden="true">{{ statusIcon(t.status) }}</span>
            <span class="khy-fb__task-body">
              <span class="khy-fb__task-title">{{ taskLabel(t) }}</span>
              <span v-if="t.owner || t.blockedBy.length" class="khy-fb__task-meta">
                <span v-if="t.owner" class="khy-fb__task-tag">@{{ t.owner }}</span>
                <span v-if="t.blockedBy.length" class="khy-fb__task-tag">阻塞×{{ t.blockedBy.length }}</span>
              </span>
            </span>
          </li>
        </ul>
      </div>
    </transition>

    <div class="khy-fb__magnet" :style="magnetStyle">
      <button
        class="khy-fb__ball"
        type="button"
        aria-label="Khy 悬浮球 — 左键菜单 / 右键打开 khy.md"
        :title="busy ? '处理中…' : 'Khy — 左键菜单 / 右键打开 khy.md'"
        @pointerdown="onPointerDown"
        @pointerenter="onBallEnter"
        @pointermove="onBallHoverMove"
        @pointerleave="onBallLeave"
        @click="onBallClick"
        @contextmenu.prevent="openKhyMd"
      >
        <span v-if="pressPulse" class="khy-fb__ripple" :key="pressPulse" aria-hidden="true" />
        <span class="khy-fb__ring" aria-hidden="true" />
        <span v-if="busy" class="khy-fb__spinner" aria-hidden="true" />
        <span v-else class="khy-fb__glyph" aria-hidden="true">K</span>
      </button>
    </div>
  </div>
</template>

<script setup>
import { computed, ref, onMounted, onBeforeUnmount } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import request from '@/api/request'
import { useUserStore } from '@/stores/user'

const route = useRoute()
const router = useRouter()
const userStore = useUserStore()

// 仅在已登录且非登录页展示;悬浮球不应出现在鉴权前的页面。
const visible = computed(() => Boolean(userStore.token) && route.path !== '/login')

const rootEl = ref(null)
const menuOpen = ref(false)
const busy = ref(false)

// 内联 SVG 图标(比 emoji 跨系统渲染一致、随主题变色)。currentColor 继承文字色。
const ICONS = {
  kernel: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="14" rx="2"/><path d="M7 9l3 2-3 2M13 13h4"/></svg>',
  tray: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="4" width="19" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>',
  doc: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M8.5 13l2 2 3-3.5"/></svg>',
  tasks: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6h11M9 12h11M9 18h11"/><path d="M4 6l1 1 1.5-1.5M4 12l1 1 1.5-1.5M4 18l1 1 1.5-1.5"/></svg>',
}

// ── 拖拽定位(默认右下角;松手吸附最近横向边缘并持久化本次浏览器位置)──────────
// 流畅度关键:位置一律经 transform: translate3d 施加(GPU 合成层,不触发 layout/reflow),
// 而非 right/bottom(布局属性,每帧回流会卡顿)。指针移动经 requestAnimationFrame 合并,
// 每帧至多写一次响应式状态;拖拽期视口尺寸在 pointerdown 快照,热路径内不再读 DOM。
const BALL = 56 // 悬浮球直径(含外发光留白),用于边缘吸附计算。
const MARGIN = 8 // 与视口边缘的安全间距。
const POS_KEY = 'khy_float_ball_pos'
const viewport = ref({ w: winW(), h: winH() })
const pos = ref(loadPos()) // { x, y } —— 悬浮球左上角在视口内的像素坐标(transform 施加)。
const dragging = ref(false)
let dragState = null
let rafId = null
let pendingEvent = null

function winW() { return (typeof window !== 'undefined' && window.innerWidth) || 1280 }
function winH() { return (typeof window !== 'undefined' && window.innerHeight) || 800 }
function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)) }

// 兼容旧版 {right,bottom} 存储:换算为 {x,y};新版直接读 {x,y}。均按当前视口夹紧。
function loadPos() {
  const maxX = Math.max(MARGIN, winW() - BALL - MARGIN)
  const maxY = Math.max(MARGIN, winH() - BALL - MARGIN)
  try {
    const raw = JSON.parse(localStorage.getItem(POS_KEY) || 'null')
    if (raw && Number.isFinite(raw.x) && Number.isFinite(raw.y)) {
      return { x: clamp(raw.x, MARGIN, maxX), y: clamp(raw.y, MARGIN, maxY) }
    }
    if (raw && Number.isFinite(raw.right) && Number.isFinite(raw.bottom)) {
      return {
        x: clamp(winW() - BALL - raw.right, MARGIN, maxX),
        y: clamp(winH() - BALL - raw.bottom, MARGIN, maxY),
      }
    }
  } catch { /* 无效存储 → 默认位 */ }
  return { x: maxX - 18, y: maxY - 48 } // 默认右下角(略微内收)。
}

function savePos() {
  try { localStorage.setItem(POS_KEY, JSON.stringify(pos.value)) } catch { /* 存储不可用忽略 */ }
}

// 位置只经合成层 transform 施加 —— 拖拽/吸附全程零回流。
const ballStyle = computed(() => ({
  transform: `translate3d(${pos.value.x}px, ${pos.value.y}px, 0)`,
}))

// 球心落在视口左半 → 菜单朝右展开(避免贴左边缘时溢出屏外)。
const menuOnLeft = computed(() => (pos.value.x + BALL / 2) < viewport.value.w / 2)

// ── 互动感:磁吸悬停(球随指针轻微偏移,活物手感)+ 按压涟漪 ──────────────────
// tilt 纯由「响应式 pos + 事件坐标」算出,热路径零 DOM 读;经内层 magnet 层独立施加
// (不与 .khy-fb 定位 transform / .khy-fb__ball 缩放 transform 冲突)。松开指针弹回。
const TILT_MAX = 5 // 磁吸最大偏移像素,克制不夸张。
const tilt = ref({ x: 0, y: 0 })
const pressPulse = ref(0) // 每次按压 +1 → 重挂涟漪 span 重播动画。
let magnetRaf = null
let magnetEvt = null

const magnetStyle = computed(() => ({
  transform: `translate3d(${tilt.value.x}px, ${tilt.value.y}px, 0)`,
}))

function onBallEnter(e) { onBallHoverMove(e) }

function onBallHoverMove(e) {
  if (dragState) return // 拖拽中不做磁吸,避免与拖拽位移打架。
  magnetEvt = e
  if (magnetRaf == null) magnetRaf = requestAnimationFrame(flushMagnet)
}

function flushMagnet() {
  magnetRaf = null
  const e = magnetEvt
  magnetEvt = null
  if (!e || dragState) return
  const cx = pos.value.x + BALL / 2 // 球心视口坐标(纯算,不读 DOM)。
  const cy = pos.value.y + BALL / 2
  tilt.value = {
    x: clamp((e.clientX - cx) * 0.28, -TILT_MAX, TILT_MAX),
    y: clamp((e.clientY - cy) * 0.28, -TILT_MAX, TILT_MAX),
  }
}

function onBallLeave() {
  if (magnetRaf != null) { cancelAnimationFrame(magnetRaf); magnetRaf = null }
  magnetEvt = null
  tilt.value = { x: 0, y: 0 } // 归零 → 经 CSS 过渡弹回。
}


function onPointerDown(e) {
  pressPulse.value += 1 // 触发按压涟漪。
  tilt.value = { x: 0, y: 0 } // 进入拖拽/按压 → 收起磁吸偏移。
  dragState = {
    startX: e.clientX,
    startY: e.clientY,
    x0: pos.value.x,
    y0: pos.value.y,
    vw: winW(), // 快照视口:拖拽热路径内不再读 DOM,避免强制同步布局。
    vh: winH(),
    moved: false,
  }
  window.addEventListener('pointermove', onPointerMove)
  window.addEventListener('pointerup', onPointerUp)
}

// 指针移动只暂存事件并请求一帧;真正的坐标计算在 flushDrag 内每帧至多一次。
function onPointerMove(e) {
  if (!dragState) return
  pendingEvent = e
  if (rafId == null) rafId = requestAnimationFrame(flushDrag)
}

function flushDrag() {
  rafId = null
  const e = pendingEvent
  pendingEvent = null
  if (!e || !dragState) return
  const dx = e.clientX - dragState.startX
  const dy = e.clientY - dragState.startY
  if (!dragState.moved && Math.hypot(dx, dy) < 4) return // 阈值内不算拖拽,留给 click。
  dragState.moved = true
  dragging.value = true
  const maxX = Math.max(MARGIN, dragState.vw - BALL - MARGIN)
  const maxY = Math.max(MARGIN, dragState.vh - BALL - MARGIN)
  pos.value = {
    x: clamp(dragState.x0 + dx, MARGIN, maxX),
    y: clamp(dragState.y0 + dy, MARGIN, maxY),
  }
}

function onPointerUp() {
  window.removeEventListener('pointermove', onPointerMove)
  window.removeEventListener('pointerup', onPointerUp)
  if (rafId != null) { cancelAnimationFrame(rafId); rafId = null }
  pendingEvent = null
  if (dragState && dragState.moved) {
    snapToEdge()
    savePos()
    setTimeout(() => { dragging.value = false }, 0) // 吞掉拖拽结束的 click。
  }
  dragState = null
}

// 吸附最近横向边缘(iOS AssistiveTouch 手感);非拖拽态改 x → 走 transform 过渡平滑归位。
function snapToEdge() {
  const vw = winW()
  if (!vw) return
  const maxX = Math.max(MARGIN, vw - BALL - MARGIN)
  const centerX = pos.value.x + BALL / 2
  pos.value = { ...pos.value, x: centerX < vw / 2 ? MARGIN : maxX }
}

// 窗口尺寸变化 → 重新夹紧,避免悬浮球移出可视区域。
function onResize() {
  viewport.value = { w: winW(), h: winH() }
  const maxX = Math.max(MARGIN, winW() - BALL - MARGIN)
  const maxY = Math.max(MARGIN, winH() - BALL - MARGIN)
  pos.value = {
    x: clamp(pos.value.x, MARGIN, maxX),
    y: clamp(pos.value.y, MARGIN, maxY),
  }
}

function onBallClick() {
  if (dragging.value) return // 刚结束拖拽,吞掉这次 click。
  menuOpen.value = !menuOpen.value
}

// 点击悬浮球以外 / 按 Esc → 关菜单 / 任务面板(交互闭合完善)。
function onDocPointerDown(e) {
  if (!menuOpen.value && !tasksOpen.value) return
  if (rootEl.value && !rootEl.value.contains(e.target)) {
    menuOpen.value = false
    if (tasksOpen.value) closeTasks()
  }
}
function onKeydown(e) {
  if (e.key !== 'Escape') return
  menuOpen.value = false
  if (tasksOpen.value) closeTasks()
}

// ── 动作 1:启动 Khy(前端路由,页面自举内核)──────────────────────────────
function launchKhy() {
  menuOpen.value = false
  router.push('/khyos').catch(() => { /* 已在该页或导航被取消,忽略 */ })
}

// ── /ws 一次性本机动作:连接→鉴权→发一条动作→等状态回执→关闭 ────────────
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

/**
 * 打开一条 /ws 会话,鉴权后发送单个本机动作,等待其状态回执。
 * @param {string} actionType  WS 动作类型(khyos_tray_start / khyos_md_open)。
 * @param {string} statusType  期望的回执类型(khyos_tray_status / khyos_md_status)。
 * @param {object} extra       附加字段(如 md 的 path)。
 * @returns {Promise<object>}  回执帧;超时或连接失败 reject。
 */
function runLocalAction(actionType, statusType, extra = {}) {
  return new Promise((resolve, reject) => {
    let ws
    let settled = false
    const done = (fn, arg) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { ws && ws.close() } catch { /* ignore */ }
      fn(arg)
    }
    const timer = setTimeout(() => done(reject, new Error('操作超时')), 12000)
    try {
      ws = new WebSocket(resolveWsUrl('/ws'))
    } catch (err) {
      return done(reject, err)
    }
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'auth', token: userStore.token || '' }))
    }
    ws.onmessage = (event) => {
      let msg = null
      try { msg = JSON.parse(String(event.data || '{}')) } catch { return }
      const type = String(msg?.type || '')
      if (type === 'auth_ok') {
        ws.send(JSON.stringify({ type: actionType, ...extra }))
        return
      }
      if (type === 'auth_error') {
        return done(reject, new Error(msg.message || '认证失败'))
      }
      if (type === statusType) {
        return done(resolve, msg)
      }
      // 后端对未启用动作会回 {type, status:'disabled'};非目标 error 帧也据此收口。
      if (type === 'error') {
        return done(reject, new Error(msg.message || '服务错误'))
      }
    }
    ws.onerror = () => done(reject, new Error('WebSocket 连接失败'))
    ws.onclose = () => done(reject, new Error('连接已关闭'))
  })
}

// ── 动作 2:启动系统托盘 ─────────────────────────────────────────────────
async function startTray() {
  if (busy.value) return
  menuOpen.value = false
  busy.value = true
  try {
    const res = await runLocalAction('khyos_tray_start', 'khyos_tray_status')
    if (res.status === 'starting') ElMessage.success('系统托盘启动中…')
    else if (res.status === 'disabled') ElMessage.warning(res.message || '本机动作已关闭')
    else ElMessage.warning(res.message || '托盘启动未成功')
  } catch (err) {
    ElMessage.error(`托盘启动失败:${(err && err.message) || err}`)
  } finally {
    busy.value = false
  }
}

// ── 动作 3:打开 khy.md(右键直达 / 菜单项)───────────────────────────────
async function openKhyMd() {
  if (busy.value) return
  menuOpen.value = false
  busy.value = true
  try {
    const res = await runLocalAction('khyos_md_open', 'khyos_md_status')
    if (res.status === 'ready' && res.url) {
      window.open(res.url, '_blank', 'noopener')
      ElMessage.success('khy.md 工作台已就绪')
    } else if (res.status === 'disabled') {
      ElMessage.warning(res.message || '本机动作已关闭')
    } else {
      ElMessage.warning(res.message || '打开 khy.md 未成功')
    }
  } catch (err) {
    ElMessage.error(`打开 khy.md 失败:${(err && err.message) || err}`)
  } finally {
    busy.value = false
  }
}

// ── TUI 任务记录 → 网页实时同步(持久鉴权 /ws + 定时拉取)──────────────────
// 后端 khyos_tasks_get 直读同进程 _taskStore(与 TUI 同源磁盘持久任务),回 khyos_tasks 帧。
// 面板开启时持一条已鉴权 ws,每 ~2.2s 拉一次 → 近实时反映 TUI 任务增删与状态流转;
// 面板关闭 / 组件卸载即关连接与定时器,零泄漏。
const tasksOpen = ref(false)
const tasks = ref([])
const tasksStatus = ref('idle') // idle | connecting | ok | disabled | error
const TASK_POLL_MS = 2200
let taskWs = null
let taskTimer = null
let taskAuthed = false

const _STATUS_ICON = { completed: '✓', in_progress: '→', error: '✗', pending: '○' }
function statusIcon(status) { return _STATUS_ICON[status] || '○' }
function taskLabel(t) {
  if (t.status === 'in_progress' && t.activeForm) return t.activeForm
  return t.subject || '(未命名任务)'
}

function requestTasks() {
  if (taskWs && taskWs.readyState === 1 && taskAuthed) {
    try { taskWs.send(JSON.stringify({ type: 'khyos_tasks_get' })) } catch { /* ignore */ }
  }
}

function startTaskSync() {
  stopTaskSync() // 先清旧连接,避免重连叠加。
  tasksStatus.value = 'connecting'
  taskAuthed = false
  let ws
  try { ws = new WebSocket(resolveWsUrl('/ws')) } catch { tasksStatus.value = 'error'; return }
  taskWs = ws
  ws.onopen = () => {
    try { ws.send(JSON.stringify({ type: 'auth', token: userStore.token || '' })) } catch { /* ignore */ }
  }
  ws.onmessage = (event) => {
    let msg = null
    try { msg = JSON.parse(String(event.data || '{}')) } catch { return }
    const type = String(msg?.type || '')
    if (type === 'auth_ok') {
      taskAuthed = true
      requestTasks()
      if (taskTimer == null) taskTimer = setInterval(requestTasks, TASK_POLL_MS)
      return
    }
    if (type === 'auth_error') { tasksStatus.value = 'error'; stopTaskSync(); return }
    if (type === 'khyos_tasks') {
      tasksStatus.value = msg.status === 'ok' ? 'ok' : (String(msg.status || 'error'))
      tasks.value = Array.isArray(msg.tasks) ? msg.tasks : []
    }
  }
  ws.onerror = () => { if (tasksStatus.value !== 'ok') tasksStatus.value = 'error' }
  ws.onclose = () => {
    if (taskTimer) { clearInterval(taskTimer); taskTimer = null }
    taskAuthed = false
    if (tasksOpen.value && tasksStatus.value === 'connecting') tasksStatus.value = 'error'
  }
}

function stopTaskSync() {
  if (taskTimer) { clearInterval(taskTimer); taskTimer = null }
  if (taskWs) { try { taskWs.close() } catch { /* ignore */ } taskWs = null }
  taskAuthed = false
}

function openTasks() {
  menuOpen.value = false
  tasksOpen.value = true
  startTaskSync()
}
function closeTasks() {
  tasksOpen.value = false
  stopTaskSync()
}

onMounted(() => {
  window.addEventListener('pointerdown', onDocPointerDown)
  window.addEventListener('keydown', onKeydown)
  window.addEventListener('resize', onResize, { passive: true })
})

onBeforeUnmount(() => {
  window.removeEventListener('pointermove', onPointerMove)
  window.removeEventListener('pointerup', onPointerUp)
  window.removeEventListener('pointerdown', onDocPointerDown)
  window.removeEventListener('keydown', onKeydown)
  window.removeEventListener('resize', onResize)
  if (rafId != null) { cancelAnimationFrame(rafId); rafId = null }
  if (magnetRaf != null) { cancelAnimationFrame(magnetRaf); magnetRaf = null }
  stopTaskSync()
})
</script>

<style scoped>
.khy-fb {
  position: fixed;
  top: 0;
  left: 0;
  z-index: 3000;
  /* 位置经 transform 施加;吸附归位用微回弹 spring(overshoot)增加松手手感,合成层不触发 layout。 */
  transition: transform 0.34s cubic-bezier(0.34, 1.56, 0.64, 1);
  will-change: transform; /* 常驻小部件,固定提升为合成层,拖拽/吸附全程免中途晋升的抖动。 */
}
.khy-fb.is-dragging { transition: none; }

/* 磁吸层:承载「球随指针轻偏」的 tilt transform,独立于定位/缩放 transform,松手弹回。 */
.khy-fb__magnet {
  display: flex;
  transition: transform 0.18s cubic-bezier(0.22, 1, 0.36, 1);
  will-change: transform;
}

/* ── 悬浮球本体 ─────────────────────────────────────────────────────── */
.khy-fb__ball {
  position: relative;
  width: 52px;
  height: 52px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: linear-gradient(135deg, #6d5efc 0%, #8b5cf6 55%, #d946ef 100%);
  box-shadow: 0 6px 18px rgba(109, 94, 252, 0.42), inset 0 1px 1px rgba(255, 255, 255, 0.35);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: grab;
  user-select: none;
  touch-action: none;
  outline: none;
  transition: transform 0.14s ease, box-shadow 0.2s ease;
}
.khy-fb__ball:hover {
  transform: scale(1.07);
  box-shadow: 0 10px 26px rgba(139, 92, 246, 0.6), inset 0 1px 1px rgba(255, 255, 255, 0.45);
}
.khy-fb__ball:active { cursor: grabbing; transform: scale(0.97); }
.khy-fb.is-dragging .khy-fb__ball { cursor: grabbing; transform: scale(1.05); }
.khy-fb.is-open .khy-fb__ball { transform: scale(1.05); }

.khy-fb__glyph {
  font-size: 23px;
  font-weight: 800;
  letter-spacing: 0.5px;
  font-family: "Segoe UI", system-ui, sans-serif;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.18);
  pointer-events: none;
  transition: transform 0.32s cubic-bezier(0.34, 1.56, 0.64, 1);
}
/* 展开菜单时字形俏皮转一下,呼应「打开」这个动作。 */
.khy-fb.is-open .khy-fb__glyph { transform: rotate(-14deg) scale(1.06); }

/* 按压涟漪:居中的一圈,按下即由内向外扩散淡出(合成 transform/opacity)。 */
.khy-fb__ripple {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 52px;
  height: 52px;
  margin: -26px 0 0 -26px;
  border-radius: 50%;
  background: radial-gradient(circle, rgba(255, 255, 255, 0.55), rgba(255, 255, 255, 0) 70%);
  pointer-events: none;
  transform: scale(0.2);
  opacity: 0;
  animation: khy-fb-ripple 0.5s ease-out;
}
@keyframes khy-fb-ripple {
  0% { transform: scale(0.2); opacity: 0.7; }
  100% { transform: scale(1.7); opacity: 0; }
}

/* 呼吸光环:平时缓慢脉动吸引注意,不喧宾夺主。 */
.khy-fb__ring {
  position: absolute;
  inset: -4px;
  border-radius: 50%;
  border: 2px solid rgba(139, 92, 246, 0.45);
  animation: khy-fb-breathe 2.8s ease-in-out infinite;
  pointer-events: none;
}
.khy-fb.is-dragging .khy-fb__ring,
.khy-fb.is-open .khy-fb__ring { animation: none; opacity: 0; }

@keyframes khy-fb-breathe {
  0%, 100% { transform: scale(1); opacity: 0.55; }
  50% { transform: scale(1.18); opacity: 0; }
}

/* 忙碌转圈(替换字形)。 */
.khy-fb__spinner {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: 2.5px solid rgba(255, 255, 255, 0.35);
  border-top-color: #fff;
  animation: khy-fb-spin 0.8s linear infinite;
  pointer-events: none;
}
@keyframes khy-fb-spin { to { transform: rotate(360deg); } }

@media (prefers-reduced-motion: reduce) {
  .khy-fb__ring { animation: none; }
  .khy-fb, .khy-fb__ball, .khy-fb__magnet, .khy-fb__glyph, .khy-fb__item-ico { transition: none; }
  .khy-fb__item { animation: none; }
  .khy-fb__ripple { display: none; }
}

/* ── 动作菜单(玻璃拟态)───────────────────────────────────────────────── */
.khy-fb__menu {
  position: absolute;
  right: 0;
  bottom: 64px;
  min-width: 232px;
  padding: 8px;
  border-radius: 16px;
  background: var(--el-bg-color, #1c2130); /* 不支持 color-mix 的引擎回退到实心面板 */
  background: color-mix(in srgb, var(--el-bg-color, #1c2130) 88%, transparent);
  backdrop-filter: blur(14px) saturate(1.2);
  -webkit-backdrop-filter: blur(14px) saturate(1.2);
  border: 1px solid var(--el-border-color, rgba(255, 255, 255, 0.12));
  box-shadow: 0 14px 40px rgba(0, 0, 0, 0.4);
  display: flex;
  flex-direction: column;
  gap: 3px;
}
/* 悬浮球在左半屏时,菜单改朝右展开,避免溢出屏外。 */
.khy-fb__menu--flip { right: auto; left: 0; }
.khy-fb__menu-head {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 4px 10px 8px;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.3px;
  color: var(--el-text-color-secondary, #9aa2b1);
}
.khy-fb__menu-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: linear-gradient(135deg, #6d5efc, #d946ef);
  box-shadow: 0 0 8px rgba(139, 92, 246, 0.8);
}
.khy-fb__item {
  display: flex;
  align-items: center;
  gap: 11px;
  width: 100%;
  padding: 9px 11px;
  border: none;
  border-radius: 11px;
  background: transparent;
  color: var(--el-text-color-primary, #e7e9ee);
  text-align: left;
  cursor: pointer;
  transition: background 0.14s ease;
  /* 展开时逐项级联入场,给菜单「一条条弹出来」的互动感。 */
  animation: khy-fb-item-in 0.34s cubic-bezier(0.22, 1, 0.36, 1) both;
}
.khy-fb__item:nth-of-type(1) { animation-delay: 0.04s; }
.khy-fb__item:nth-of-type(2) { animation-delay: 0.09s; }
.khy-fb__item:nth-of-type(3) { animation-delay: 0.14s; }
.khy-fb__item:nth-of-type(4) { animation-delay: 0.19s; }
@keyframes khy-fb-item-in {
  from { opacity: 0; transform: translateX(10px); }
  to { opacity: 1; transform: translateX(0); }
}
/* 左半屏菜单朝右开时,入场方向对称翻转。 */
.khy-fb__menu--flip .khy-fb__item { animation-name: khy-fb-item-in-flip; }
@keyframes khy-fb-item-in-flip {
  from { opacity: 0; transform: translateX(-10px); }
  to { opacity: 1; transform: translateX(0); }
}
.khy-fb__item:hover:not(:disabled) { background: var(--el-fill-color, rgba(255, 255, 255, 0.08)); }
.khy-fb__item:active:not(:disabled) { background: var(--el-fill-color-dark, rgba(255, 255, 255, 0.13)); }
.khy-fb__item:disabled { opacity: 0.5; cursor: default; }
/* 悬停时图标胶囊轻微前移,不与逐项入场动画的 transform 冲突。 */
.khy-fb__item:hover:not(:disabled) .khy-fb__item-ico { transform: translateX(2px) scale(1.05); }
.khy-fb__item-ico {
  flex: none;
  width: 34px;
  height: 34px;
  border-radius: 9px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #c4b5fd;
  background: linear-gradient(135deg, rgba(109, 94, 252, 0.18), rgba(217, 70, 239, 0.16));
  transition: transform 0.16s cubic-bezier(0.34, 1.56, 0.64, 1);
}
.khy-fb__item-body { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.khy-fb__item-title { font-size: 13.5px; font-weight: 600; line-height: 1.25; }
.khy-fb__item-sub {
  font-size: 11px;
  line-height: 1.2;
  color: var(--el-text-color-secondary, #8b93a3);
}

.khy-fb-menu-enter-active,
.khy-fb-menu-leave-active {
  transition: opacity 0.16s ease, transform 0.16s cubic-bezier(0.22, 1, 0.36, 1);
  transform-origin: bottom right;
}
.khy-fb-menu-enter-from,
.khy-fb-menu-leave-to { opacity: 0; transform: translateY(8px) scale(0.94); }
/* 朝右展开时,缩放锚点随之翻到左下角。 */
.khy-fb__menu--flip.khy-fb-menu-enter-active,
.khy-fb__menu--flip.khy-fb-menu-leave-active { transform-origin: bottom left; }

/* ── TUI 任务记录面板(玻璃拟态,与菜单同视觉语言)──────────────────────────── */
.khy-fb__tasks {
  position: absolute;
  right: 0;
  bottom: 64px;
  width: 288px;
  max-height: 60vh;
  padding: 10px;
  border-radius: 16px;
  background: var(--el-bg-color, #1c2130);
  background: color-mix(in srgb, var(--el-bg-color, #1c2130) 90%, transparent);
  backdrop-filter: blur(14px) saturate(1.2);
  -webkit-backdrop-filter: blur(14px) saturate(1.2);
  border: 1px solid var(--el-border-color, rgba(255, 255, 255, 0.12));
  box-shadow: 0 14px 40px rgba(0, 0, 0, 0.42);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.khy-fb__tasks--flip { right: auto; left: 0; }
.khy-fb__tasks-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 2px 4px 9px;
  border-bottom: 1px solid var(--el-border-color-lighter, rgba(255, 255, 255, 0.08));
  margin-bottom: 6px;
}
.khy-fb__tasks-title {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--el-text-color-primary, #e7e9ee);
}
/* 实时状态灯:同步中呼吸绿,连接中脉冲黄,失败红,关闭灰。 */
.khy-fb__live-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #8b93a3;
  flex: none;
}
.khy-fb__live-dot.is-ok { background: #22c55e; box-shadow: 0 0 8px rgba(34, 197, 94, 0.8); animation: khy-fb-pulse 2s ease-in-out infinite; }
.khy-fb__live-dot.is-connecting { background: #eab308; animation: khy-fb-pulse 1s ease-in-out infinite; }
.khy-fb__live-dot.is-error { background: #ef4444; }
.khy-fb__live-dot.is-disabled { background: #8b93a3; }
@keyframes khy-fb-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
.khy-fb__tasks-count {
  margin-left: auto;
  min-width: 20px;
  padding: 1px 7px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  text-align: center;
  color: #c4b5fd;
  background: rgba(139, 92, 246, 0.18);
}
.khy-fb__tasks-close {
  margin-left: 6px;
  width: 22px;
  height: 22px;
  line-height: 1;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--el-text-color-secondary, #9aa2b1);
  font-size: 17px;
  cursor: pointer;
  transition: background 0.14s ease, color 0.14s ease;
}
.khy-fb__tasks-close:hover { background: var(--el-fill-color, rgba(255, 255, 255, 0.08)); color: var(--el-text-color-primary, #e7e9ee); }
.khy-fb__tasks-hint {
  padding: 16px 8px;
  text-align: center;
  font-size: 12.5px;
  color: var(--el-text-color-secondary, #8b93a3);
}
.khy-fb__tasks-hint.is-error { color: #f87171; cursor: pointer; }
.khy-fb__tasks-hint.is-error:hover { text-decoration: underline; }
.khy-fb__tasks-list {
  list-style: none;
  margin: 0;
  padding: 0 2px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.khy-fb__task {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  padding: 7px 8px;
  border-radius: 9px;
  transition: background 0.14s ease;
}
.khy-fb__task:hover { background: var(--el-fill-color, rgba(255, 255, 255, 0.06)); }
.khy-fb__task-ico {
  flex: none;
  width: 18px;
  text-align: center;
  font-size: 13px;
  line-height: 1.5;
  color: #8b93a3;
}
.khy-fb__task.is-completed .khy-fb__task-ico { color: #22c55e; }
.khy-fb__task.is-in_progress .khy-fb__task-ico { color: #a78bfa; }
.khy-fb__task.is-error .khy-fb__task-ico { color: #ef4444; }
.khy-fb__task-body { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.khy-fb__task-title {
  font-size: 12.5px;
  line-height: 1.35;
  color: var(--el-text-color-primary, #e7e9ee);
  word-break: break-word;
}
.khy-fb__task.is-completed .khy-fb__task-title { color: var(--el-text-color-secondary, #9aa2b1); text-decoration: line-through; text-decoration-color: rgba(154, 162, 177, 0.5); }
.khy-fb__task-meta { display: flex; flex-wrap: wrap; gap: 5px; }
.khy-fb__task-tag {
  font-size: 10.5px;
  line-height: 1.3;
  padding: 0 6px;
  border-radius: 6px;
  color: var(--el-text-color-secondary, #8b93a3);
  background: var(--el-fill-color-light, rgba(255, 255, 255, 0.06));
}

@media (prefers-reduced-motion: reduce) {
  .khy-fb__live-dot { animation: none; }
}
</style>
