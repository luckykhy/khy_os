<template>
  <div class="md-board">
    <!-- ── 顶栏工具条 ─────────────────────────────────────────────────── -->
    <header class="md-toolbar">
      <span class="md-brand">Markdown<small> · 所见即所得工作台</small></span>

      <el-radio-group v-model="view" size="small" class="md-viewseg">
        <el-radio-button label="preview">预览</el-radio-button>
        <el-radio-button label="split">分屏</el-radio-button>
        <el-radio-button label="source">源码</el-radio-button>
      </el-radio-group>

      <el-button size="small" :icon="DocumentAdd" @click="newDoc">新建</el-button>
      <el-button size="small" :icon="FolderOpened" @click="pickFile">打开</el-button>
      <el-button size="small" :icon="Download" @click="downloadDoc">下载</el-button>

      <!-- 服务器文件：仅登录用户可见；匿名用户此按钮不渲染、永不触发任何 API。 -->
      <el-button
        v-if="isAuthenticated"
        size="small"
        :icon="Connection"
        :type="serverPanel ? 'primary' : 'default'"
        @click="toggleServerPanel"
      >服务器文件</el-button>

      <span class="md-spacer" />

      <span class="md-filename" :title="fileName || '未命名'">{{ fileName || '未命名.md' }}</span>
      <el-button size="small" text :icon="theme === 'dark' ? Sunny : Moon" @click="toggleTheme" title="切换明暗" />
    </header>

    <!-- ── 主体：源码 / 预览 / muya WYSIWYG ─────────────────────────────── -->
    <div class="md-main">
      <!-- 服务器文件面板：仅登录可见；列出受限根目录内的 Markdown，点选打开、可保存回去。 -->
      <aside v-if="isAuthenticated && serverPanel" class="md-files">
        <div class="md-files-head">
          <span class="md-files-title">{{ serverLabel || '服务器文件' }}</span>
          <el-button size="small" text :icon="Refresh" :loading="serverLoading" title="刷新" @click="loadServerList" />
        </div>
        <div v-if="serverError" class="md-files-err">{{ serverError }}</div>
        <el-scrollbar class="md-files-scroll">
          <ul class="md-files-list">
            <li
              v-for="f in serverFiles"
              :key="f.path"
              :class="['md-file-item', f.type === 'dir' ? 'is-dir' : '', { active: f.type !== 'dir' && f.path === serverPath }]"
              :style="{ paddingLeft: (10 + (f.depth || 0) * 14) + 'px' }"
              :title="f.path"
              @click="f.type === 'dir' ? null : openServerFile(f)"
            >{{ f.type === 'dir' ? '📁 ' : '' }}{{ f.name }}</li>
            <li v-if="!serverLoading && !serverFiles.length" class="md-files-empty">（无 Markdown 文件）</li>
          </ul>
        </el-scrollbar>
        <div class="md-files-foot">
          <el-button
            size="small"
            type="primary"
            :icon="UploadFilled"
            :disabled="!serverPath"
            :loading="serverSaving"
            @click="saveToServer"
          >保存到服务器</el-button>
        </div>
      </aside>

      <div v-show="showSource" class="md-pane md-pane-source">
        <textarea
          ref="srcRef"
          v-model="text"
          class="md-src"
          spellcheck="false"
          placeholder="在此输入或粘贴 Markdown…（草稿自动保存在本浏览器，无需登录）"
        />
      </div>

      <!-- 内联预览（muya 不可用时的零依赖回退渲染） -->
      <div v-show="showInlinePreview" class="md-pane md-pane-preview">
        <div class="md-preview" v-html="previewHtml" />
      </div>

      <!-- muya 宿主：仅在引擎加载成功后显示；muya 只操作内部子节点。 -->
      <div v-show="showMuya" ref="muyaHostRef" class="md-pane md-pane-muya" />
    </div>

    <!-- ── 状态条 ─────────────────────────────────────────────────────── -->
    <footer class="md-status">
      <span :class="['md-engine', muyaReady ? 'ok' : '']">
        {{ muyaReady ? '引擎：muya 所见即所得' : '引擎：内联渲染（离线）' }}
      </span>
      <span v-if="statusMsg" :class="['md-stat', statusKind]">{{ statusMsg }}</span>
      <span class="md-spacer" />
      <span class="md-count">{{ charCount }} 字符 · {{ wordCount }} 词</span>
    </footer>

    <input
      ref="fileInputRef"
      type="file"
      accept=".md,.markdown,.txt,text/markdown"
      style="display: none"
      @change="onFilePicked"
    />
  </div>
</template>

<script setup>
/**
 * Markdown.vue — AI 前端内嵌的 Markdown 工作台版块（无需登录）。
 *
 * 定位：把原先独立 bridge 服务 + 独立浏览器窗口的 `tools/khyos-markdown` 能力，
 * 融进本应用外壳的一个侧边栏版块，登录/未登录都能用，消除「分割」。
 *
 * 核心（本文件，Phase A）= 纯浏览器内编辑，零后端、零 401：
 *   - 打字 / 粘贴 / 打开本地 .md（文件选择器）/ 下载 .md（Blob）/ localStorage 自动存草稿。
 *   - muya 所见即所得引擎从同源免鉴权静态资产 `/vendor/khyos-muya.{js,css}` 懒加载；
 *     加载失败 → 逐字节回退到内联零依赖渲染器（mdToHtml，移植自 khyosMarkdown.html）。
 *   - 崩溃硬化：muya 只挂到宿主内部新建的子节点，任何 muya 运行期异常都回退内联预览，绝不白屏。
 *
 * 服务器文件目录（读写服务器主机文件、需登录）由 Phase B 追加，匿名用户永不触发任何 API。
 */
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import {
  DocumentAdd, FolderOpened, Download, Sunny, Moon,
  Connection, Refresh, UploadFilled,
} from '@element-plus/icons-vue'
import { useTheme } from '@/composables/useTheme'
import { useUserStore } from '@/stores/user'
import request from '@/api/request'

defineOptions({ name: 'MarkdownBoard' })

const DRAFT_KEY = 'khy_md_draft'
const VIEW_KEY = 'khy_md_view'

const { theme, toggleTheme } = useTheme()
const userStore = useUserStore()
// 登录态决定是否暴露「服务器文件」增强。匿名 → 整段 UI 不渲染、零后端调用。
const isAuthenticated = computed(() => userStore.isAuthenticated())

// ── 应用状态 ────────────────────────────────────────────────────────────
const text = ref('')
const fileName = ref('')
const view = ref('preview')
const dirty = ref(false)
const muyaReady = ref(false)
const statusMsg = ref('')
const statusKind = ref('')

const srcRef = ref(null)
const muyaHostRef = ref(null)
const fileInputRef = ref(null)

let muyaEditor = null

// ── 派生：哪块面板可见（声明式，取代 HTML 里的命令式 setView）────────────
const showSource = computed(() => view.value === 'source' || view.value === 'split')
const showInlinePreview = computed(
  () => !muyaReady.value && (view.value === 'preview' || view.value === 'split'),
)
const showMuya = computed(
  () => muyaReady.value && (view.value === 'preview' || view.value === 'split'),
)

const charCount = computed(() => text.value.length)
const wordCount = computed(() => (text.value.match(/\S+/g) || []).length)

/* =====================================================================
 * 1) 零依赖 Markdown 渲染器（移植自 khyosMarkdown.html，先转义后渲染杜绝注入）
 * ===================================================================== */
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
function renderInline(input) {
  const codes = []
  let s = input.replace(/`([^`]+)`/g, (_, c) => {
    codes.push('<code>' + escapeHtml(c) + '</code>')
    return ' ' + (codes.length - 1) + ' '
  })
  s = escapeHtml(s)
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/g,
    (_, alt, src, title) => `<img src="${src}" alt="${alt}"${title ? ` title="${title}"` : ''} />`)
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/g,
    (_, t, href, title) => `<a href="${href}"${title ? ` title="${title}"` : ''}>${t}</a>`)
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
    .replace(/(^|[^_])_([^_]+)_/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    .replace(/==([^=]+)==/g, '<mark>$1</mark>')
  s = s.replace(/(^|[\s(])((?:https?:\/\/)[^\s<)]+)/g, '$1<a href="$2">$2</a>')
  s = s.replace(/ (\d+) /g, (_, i) => codes[+i])
  return s
}
function mdToHtml(src) {
  const lines = String(src).replace(/\r\n?/g, '\n').split('\n')
  let html = ''
  let i = 0
  const listStack = []
  const closeList = (stack) => { while (stack.length) html += stack.pop().tag === 'ol' ? '</ol>' : '</ul>' }
  while (i < lines.length) {
    const line = lines[i]
    const fence = line.match(/^\s*```+\s*([\w+-]*)\s*$/)
    if (fence) {
      closeList(listStack)
      const lang = fence[1] || ''
      const buf = []; i++
      while (i < lines.length && !/^\s*```+\s*$/.test(lines[i])) { buf.push(lines[i]); i++ }
      i++
      html += `<pre><code${lang ? ` class="language-${lang}"` : ''}>` + escapeHtml(buf.join('\n')) + '</code></pre>'
      continue
    }
    if (/^\s*$/.test(line)) { closeList(listStack); i++; continue }
    const h = line.match(/^(#{1,6})\s+(.*)$/)
    if (h) {
      closeList(listStack)
      const lv = h[1].length
      const id = h[2].trim().toLowerCase().replace(/[^\w一-龥]+/g, '-').replace(/^-|-$/g, '')
      html += `<h${lv} id="${id}">${renderInline(h[2].trim())}</h${lv}>`; i++; continue
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { closeList(listStack); html += '<hr />'; i++; continue }
    if (/^\s*>\s?/.test(line)) {
      closeList(listStack)
      const buf = []
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++ }
      html += '<blockquote>' + mdToHtml(buf.join('\n')) + '</blockquote>'; continue
    }
    if (/\|/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(lines[i + 1])) {
      closeList(listStack)
      const splitRow = (r) => r.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim())
      const heads = splitRow(line)
      const aligns = splitRow(lines[i + 1]).map((c) => {
        const l = c.startsWith(':'); const r = c.endsWith(':'); return l && r ? 'center' : r ? 'right' : l ? 'left' : ''
      })
      i += 2
      let t = '<table><thead><tr>'
      heads.forEach((c, k) => { t += `<th${aligns[k] ? ` style="text-align:${aligns[k]}"` : ''}>${renderInline(c)}</th>` })
      t += '</tr></thead><tbody>'
      while (i < lines.length && /\|/.test(lines[i]) && !/^\s*$/.test(lines[i])) {
        const cells = splitRow(lines[i]); t += '<tr>'
        heads.forEach((_, k) => { t += `<td${aligns[k] ? ` style="text-align:${aligns[k]}"` : ''}>${renderInline(cells[k] || '')}</td>` })
        t += '</tr>'; i++
      }
      html += t + '</tbody></table>'; continue
    }
    const li = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/)
    if (li) {
      const indent = li[1].replace(/\t/g, '  ').length
      const ordered = /\d/.test(li[2])
      const depth = Math.floor(indent / 2)
      while (listStack.length > depth + 1) html += listStack.pop().tag === 'ol' ? '</ol>' : '</ul>'
      if (listStack.length === depth + 1 && listStack[depth] && listStack[depth].ordered !== ordered) {
        html += listStack.pop().tag === 'ol' ? '</ol>' : '</ul>'
      }
      while (listStack.length < depth + 1) {
        const tag = ordered ? 'ol' : 'ul'; html += '<' + tag + '>'; listStack.push({ tag, ordered })
      }
      const content = li[3]
      const task = content.match(/^\[([ xX])\]\s+(.*)$/)
      if (task) {
        const checked = task[1].toLowerCase() === 'x'
        html += `<li class="task"><input type="checkbox" disabled${checked ? ' checked' : ''} /> ${renderInline(task[2])}</li>`
      } else {
        html += '<li>' + renderInline(content) + '</li>'
      }
      i++; continue
    }
    closeList(listStack)
    const buf = [line]; i++
    while (i < lines.length && !/^\s*$/.test(lines[i])
      && !/^(\s*```|#{1,6}\s|\s*>\s?|\s*([-*+]|\d+[.)])\s)/.test(lines[i])
      && !/^\s*([-*_])(\s*\1){2,}\s*$/.test(lines[i])) { buf.push(lines[i]); i++ }
    html += '<p>' + renderInline(buf.join('\n')).replace(/\n/g, '<br />') + '</p>'
  }
  closeList(listStack)
  return html
}

const previewHtml = computed(() => (text.value.trim() ? mdToHtml(text.value) : '<div class="md-empty">空文档</div>'))

/* =====================================================================
 * 2) muya 引擎：同源免鉴权懒加载 + 挂载 + 崩溃硬化回退（移植 tryInitMuya/mountMuya）
 * ===================================================================== */
function loadAsset(tag, attrs) {
  return new Promise((resolve, reject) => {
    const key = attrs.src || attrs.href
    // 去重：同源资产可能已被前一次挂载注入；已存在则直接成功。
    const existing = Array.from(document.head.querySelectorAll(tag)).find(
      (n) => (n.src && n.src.includes(key)) || (n.href && n.href.includes(key)),
    )
    if (existing) { resolve(true); return }
    const el = document.createElement(tag)
    Object.assign(el, attrs)
    el.onload = () => resolve(true)
    el.onerror = () => reject(new Error('load failed: ' + key))
    document.head.appendChild(el)
  })
}

async function tryInitMuya() {
  if (window.KhyMuya && typeof window.KhyMuya.create === 'function') return true
  try {
    // CSS 缺失不致命（onerror 也不阻断）；JS 缺失才判失败。绝不触网，仅同源本地资产。
    await loadAsset('link', { rel: 'stylesheet', href: '/vendor/khyos-muya.css' }).catch(() => {})
    await loadAsset('script', { src: '/vendor/khyos-muya.js' })
    return !!(window.KhyMuya && typeof window.KhyMuya.create === 'function')
  } catch {
    return false
  }
}

function destroyMuya() {
  if (muyaEditor) { try { muyaEditor.destroy() } catch { /* ignore */ } muyaEditor = null }
  const host = muyaHostRef.value
  if (host) host.innerHTML = ''
}

// muya 运行期任何异常 → 永久降级内联渲染器（null-safe，绝不白屏）。
function fallbackToInline() {
  muyaReady.value = false
  muyaEditor = null
}

// 把 muya 挂到宿主内部新建子节点（muya 可能替换/摘除传入容器；用子节点隔离，失败也不二次抛）。
function mountMuya(markdown) {
  if (!muyaReady.value) return
  destroyMuya()
  const host = muyaHostRef.value
  if (!host) { fallbackToInline(); return }
  const mount = document.createElement('div')
  mount.className = 'mu-mount'
  host.appendChild(mount)
  try {
    muyaEditor = window.KhyMuya.create(mount, { markdown: String(markdown || ''), locale: 'zh' })
    muyaEditor.on('json-change', () => {
      try { text.value = muyaEditor.getMarkdown() } catch { /* ignore */ }
      dirty.value = true
    })
  } catch {
    fallbackToInline()
  }
}

function syncFromMuya() {
  if (muyaEditor) { try { text.value = muyaEditor.getMarkdown() } catch { /* ignore */ } }
}

/* =====================================================================
 * 3) 浏览器内文件动作（无需后端）
 * ===================================================================== */
function newDoc() {
  if (dirty.value && !window.confirm('当前文档未保存，新建将清空，继续？')) return
  text.value = ''
  fileName.value = ''
  dirty.value = false
  setStatus('已新建空文档', 'ok')
  if (showMuya.value) mountMuya('')
}

function pickFile() {
  if (fileInputRef.value) fileInputRef.value.click()
}

function onFilePicked(ev) {
  const f = ev.target.files && ev.target.files[0]
  if (!f) return
  const reader = new FileReader()
  reader.onload = () => {
    text.value = String(reader.result || '')
    fileName.value = f.name
    dirty.value = false
    setStatus('已打开本地文件：' + f.name, 'ok')
    if (showMuya.value) mountMuya(text.value)
  }
  reader.onerror = () => setStatus('读取本地文件失败', 'err')
  reader.readAsText(f, 'utf-8')
  // 允许再次选择同名文件。
  ev.target.value = ''
}

function downloadDoc() {
  syncFromMuya()
  try {
    const name = (fileName.value && fileName.value.trim()) || 'untitled.md'
    const safe = /\.(md|markdown|txt)$/i.test(name) ? name : name + '.md'
    const blob = new Blob([text.value], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = safe
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    dirty.value = false
    setStatus('已下载：' + safe, 'ok')
  } catch (e) {
    setStatus('下载失败：' + (e && e.message), 'err')
  }
}

function setStatus(msg, kind) {
  statusMsg.value = msg || ''
  statusKind.value = kind || ''
}

/* =====================================================================
 * 3b) 服务器文件目录（登录增强 · 读写服务器主机上受限根内的 Markdown）
 *     经 @/api/request（拦截器自动带 Bearer）；匿名态整段 UI 不渲染、绝不到达此处。
 *     后端 /api/md-workbench 已做鉴权 + 路径 confinement + 文本扩展名 allowlist + fail-soft。
 * ===================================================================== */
const serverPanel = ref(false)
const serverFiles = ref([])
const serverPath = ref('')       // 当前打开的服务器文件绝对路径（保存回去用）
const serverLabel = ref('')
const serverError = ref('')
const serverLoading = ref(false)
const serverSaving = ref(false)

function serverErr(e, fallback) {
  return (e && e.response && e.response.data && e.response.data.message)
    || (e && e.message) || fallback
}

async function loadServerList() {
  if (!isAuthenticated.value) return
  serverLoading.value = true
  serverError.value = ''
  try {
    const { data } = await request.get('/api/md-workbench/list')
    const payload = (data && data.data) || {}
    serverFiles.value = Array.isArray(payload.files) ? payload.files : []
    serverLabel.value = payload.label || '服务器文件'
  } catch (e) {
    serverFiles.value = []
    serverError.value = serverErr(e, '无法列出服务器文件')
  } finally {
    serverLoading.value = false
  }
}

function toggleServerPanel() {
  serverPanel.value = !serverPanel.value
  if (serverPanel.value && !serverFiles.value.length) loadServerList()
}

async function openServerFile(f) {
  if (!f || !f.path || f.type === 'dir') return
  if (dirty.value && !window.confirm('当前文档未保存，打开服务器文件将覆盖，继续？')) return
  try {
    const { data } = await request.get('/api/md-workbench/read', { params: { path: f.path } })
    const payload = (data && data.data) || {}
    text.value = String(payload.content || '')
    fileName.value = f.name
    serverPath.value = payload.path || f.path
    dirty.value = false
    setStatus('已打开服务器文件：' + f.name, 'ok')
    if (showMuya.value) mountMuya(text.value)
  } catch (e) {
    setStatus('打开失败：' + serverErr(e, '读取服务器文件失败'), 'err')
  }
}

async function saveToServer() {
  if (!serverPath.value) { setStatus('请先从列表打开一个服务器文件再保存', 'err'); return }
  syncFromMuya()
  serverSaving.value = true
  try {
    await request.post('/api/md-workbench/save', { content: text.value }, { params: { path: serverPath.value } })
    dirty.value = false
    setStatus('已保存到服务器：' + (fileName.value || serverPath.value), 'ok')
  } catch (e) {
    setStatus('保存失败：' + serverErr(e, '写入服务器文件失败'), 'err')
  } finally {
    serverSaving.value = false
  }
}

/* =====================================================================
 * 4) 草稿自动保存 + 视图切换联动 muya
 * ===================================================================== */
let draftTimer = null
watch(text, (val) => {
  dirty.value = true
  if (draftTimer) clearTimeout(draftTimer)
  draftTimer = setTimeout(() => {
    try { localStorage.setItem(DRAFT_KEY, val) } catch { /* ignore */ }
  }, 400)
})

watch(view, (now, prev) => {
  try { localStorage.setItem(VIEW_KEY, now) } catch { /* ignore */ }
  if (!muyaReady.value) return
  const nowMuya = now === 'preview' || now === 'split'
  const prevMuya = prev === 'preview' || prev === 'split'
  if (nowMuya && !prevMuya) {
    // 从源码切回 muya：用最新 textarea 内容重建 WYSIWYG。
    nextTick(() => mountMuya(text.value))
  } else if (!nowMuya && prevMuya) {
    // 切到源码：先把 muya 内容落回。
    syncFromMuya()
  }
})

onMounted(async () => {
  // bridge mode: auto-load file from URL params
  try {
    const params = new URLSearchParams(window.location.search)
    const urlPath = String(params.get("path") || "").trim()
    const token = String(params.get("token") || "").trim()
    if (urlPath) {
      const decoded = decodeURIComponent(urlPath)
      if (decoded) {
        const apiUrl = "/api/read?path=" + encodeURIComponent(decoded) + (token ? "&token=" + encodeURIComponent(token) : "")
        const resp = await fetch(apiUrl)
        if (resp.ok) {
          text.value = await resp.text()
          const idx2 = decoded.lastIndexOf("/")
          fileName.value = idx2 >= 0 ? decoded.slice(idx2 + 1) : decoded
          dirty.value = false
          setStatus("open: " + fileName.value, "ok")
        } else {
          setStatus("load failed: HTTP " + resp.status, "err")
        }
      }
    }
  } catch (_) { /* ignore */ }

  // restore draft and view preference (local only, no auth needed)
  try {
    const draft = localStorage.getItem(DRAFT_KEY)
    if (draft != null) { text.value = draft; dirty.value = false }
    const savedView = localStorage.getItem(VIEW_KEY)
    if (savedView === 'source' || savedView === 'split' || savedView === 'preview') view.value = savedView
  } catch (_) { /* ignore */ }

  // lazy-load muya WYSIWYG engine
  const ok = await tryInitMuya()
  muyaReady.value = ok
  if (ok) {
    await nextTick()
    if (showMuya.value) mountMuya(text.value)
  }
})

onBeforeUnmount(() => {
  if (draftTimer) clearTimeout(draftTimer)
  destroyMuya()
})
</script>

<style scoped>
.md-board {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--el-bg-color, #fff);
}

/* ── 顶栏 ── */
.md-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--el-border-color, #d1d9e0);
  flex: 0 0 auto;
  flex-wrap: wrap;
}
.md-brand { font-weight: 700; white-space: nowrap; }
.md-brand small { color: var(--el-text-color-secondary, #59636e); font-weight: 400; }
.md-viewseg { margin-right: 4px; }
.md-spacer { flex: 1 1 auto; }
.md-filename {
  color: var(--el-text-color-secondary, #59636e);
  font-size: 12px; max-width: 32vw; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap;
}

/* ── 主体 ── */
.md-main { flex: 1 1 auto; display: flex; min-height: 0; }
.md-pane { flex: 1 1 0; min-width: 0; overflow: auto; }

/* ── 服务器文件面板（登录增强）── */
.md-files {
  flex: 0 0 232px; display: flex; flex-direction: column; min-height: 0;
  border-right: 1px solid var(--el-border-color, #d1d9e0);
  background: var(--el-fill-color-light, #f6f8fa);
}
.md-files-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 6px 10px; border-bottom: 1px solid var(--el-border-color, #d1d9e0);
  font-size: 12px; font-weight: 600;
}
.md-files-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.md-files-err { padding: 6px 10px; font-size: 12px; color: var(--el-color-danger, #cf222e); }
.md-files-scroll { flex: 1 1 auto; min-height: 0; }
.md-files-list { list-style: none; margin: 0; padding: 4px 0; }
.md-file-item {
  padding: 5px 10px; font-size: 12.5px; cursor: pointer;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--el-text-color-primary, #1f2328);
}
.md-file-item:hover { background: var(--el-fill-color, #eef1f4); }
.md-file-item.active { background: var(--el-color-primary-light-9, #ecf5ff); color: var(--el-color-primary, #409eff); font-weight: 600; }
.md-file-item.is-dir {
  color: var(--el-text-color-secondary, #59636e); font-weight: 600; cursor: default; user-select: none;
}
.md-file-item.is-dir:hover { background: transparent; }
.md-files-empty { padding: 10px; font-size: 12px; color: var(--el-text-color-secondary, #59636e); }
.md-files-foot { padding: 8px 10px; border-top: 1px solid var(--el-border-color, #d1d9e0); }
.md-files-foot .el-button { width: 100%; }
.md-pane-source { display: flex; border-right: 1px solid var(--el-border-color, #d1d9e0); }
.md-pane-muya { border-right: 1px solid var(--el-border-color, #d1d9e0); }
.md-pane-muya :deep(.mu-mount) { min-height: 100%; }
.md-pane-muya :deep(.mu-container), .md-pane-muya :deep(.muya) { height: 100%; }

.md-src {
  flex: 1 1 auto; width: 100%; border: none; outline: none; resize: none; padding: 16px;
  font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace;
  font-size: 13.5px; line-height: 1.7; tab-size: 4;
  color: var(--el-text-color-primary, #1f2328); background: var(--el-bg-color, #fff);
}

/* ── 内联预览（回退渲染器）── */
.md-preview {
  --md-fg: #1f2328; --md-muted: #59636e; --md-border: #d1d9e0;
  --md-accent: #0969da; --md-code-bg: #f6f8fa; --md-quote: #d0d7de;
  --md-stripe: #f6f8fa; --md-mark: #fff8c5;
  padding: 24px 40px; max-width: 980px; margin: 0 auto;
  color: var(--md-fg); line-height: 1.6; font-size: 15px;
}
:global(html.dark) .md-preview {
  --md-fg: #e6edf3; --md-muted: #9198a1; --md-border: #30363d;
  --md-accent: #4493f8; --md-code-bg: #161b22; --md-quote: #30363d;
  --md-stripe: #161b22; --md-mark: #574c1c;
}
.md-preview :deep(h1), .md-preview :deep(h2) { border-bottom: 1px solid var(--md-border); padding-bottom: .3em; }
.md-preview :deep(h1) { font-size: 2em; margin: .67em 0 .6em; }
.md-preview :deep(h2) { font-size: 1.5em; margin: 1.2em 0 .5em; }
.md-preview :deep(h3) { font-size: 1.25em; margin: 1em 0 .4em; }
.md-preview :deep(h4) { font-size: 1em; margin: 1em 0 .4em; }
.md-preview :deep(h5) { font-size: .9em; }
.md-preview :deep(h6) { font-size: .85em; color: var(--md-muted); }
.md-preview :deep(p) { margin: .6em 0; }
.md-preview :deep(a) { color: var(--md-accent); text-decoration: none; }
.md-preview :deep(a:hover) { text-decoration: underline; }
.md-preview :deep(code) {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 85%;
  background: var(--md-code-bg); padding: .2em .4em; border-radius: 6px;
}
.md-preview :deep(pre) { background: var(--md-code-bg); padding: 14px 16px; border-radius: 8px; overflow: auto; line-height: 1.5; }
.md-preview :deep(pre code) { background: none; padding: 0; font-size: 90%; }
.md-preview :deep(blockquote) { margin: .6em 0; padding: 0 1em; color: var(--md-muted); border-left: .25em solid var(--md-quote); }
.md-preview :deep(ul), .md-preview :deep(ol) { padding-left: 2em; margin: .5em 0; }
.md-preview :deep(li) { margin: .2em 0; }
.md-preview :deep(li.task) { list-style: none; margin-left: -1.4em; }
.md-preview :deep(li.task input) { margin-right: .5em; }
.md-preview :deep(table) { border-collapse: collapse; margin: .8em 0; display: block; overflow: auto; }
.md-preview :deep(th), .md-preview :deep(td) { border: 1px solid var(--md-border); padding: 6px 13px; }
.md-preview :deep(tr:nth-child(2n)) { background: var(--md-stripe); }
.md-preview :deep(img) { max-width: 100%; }
.md-preview :deep(hr) { border: none; border-top: 1px solid var(--md-border); margin: 1.4em 0; }
.md-preview :deep(mark) { background: var(--md-mark); }
.md-preview :deep(del) { color: var(--md-muted); }
.md-preview :deep(.md-empty) { color: var(--md-muted); padding: 40px; text-align: center; }

/* ── 状态条 ── */
.md-status {
  flex: 0 0 auto; border-top: 1px solid var(--el-border-color, #d1d9e0);
  padding: 4px 14px; font-size: 12px; color: var(--el-text-color-secondary, #59636e);
  display: flex; gap: 16px; align-items: center;
}
.md-engine.ok { color: var(--el-color-success, #1a7f37); }
.md-stat.ok { color: var(--el-color-success, #1a7f37); }
.md-stat.err { color: var(--el-color-danger, #cf222e); }
</style>
