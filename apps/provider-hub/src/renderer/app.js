// Provider Card Hub — renderer logic（DESIGN-ARCH-094 §5 M2）。
// 数据全部经 window.khyHub（preload 白名单）；渲染层无 Node 权限。

const $ = (sel) => document.querySelector(sel)
const hub = () => window.khyHub

// ── 状态 ────────────────────────────────────────────────────────────────────
const state = {
  cards: [],
  active: {},
  tools: ['claude-code', 'opencode', 'zcode', 'codex', 'command-code', 'ycode'],
  tool: 'claude-code',
  drawerCard: null
}

function setStatus(msg) {
  $('#statusMsg').textContent = msg
}

async function refresh() {
  const r = await hub().cards.list()
  if (!r.ok) { setStatus(`卡片读取失败：${r.error}`); return }
  state.cards = r.data.cards
  state.active = r.data.active
  renderCards()
}

// ── 卡片列表渲染 ─────────────────────────────────────────────────────────────
function renderCards() {
  const list = $('#cardList')
  const tpl = document.getElementById('cardTpl')
  list.innerHTML = ''
  for (const card of state.cards) {
    const node = tpl.content.firstElementChild.cloneNode(true)
    node.querySelector('.name').textContent = card.name
    node.querySelector('.endpoint').textContent = card.baseUrl
    node.querySelector('.keymask').textContent = card.keyId ? `池 #${card.keyId.slice(0, 6)}` : '未绑定密钥'
    node.querySelector('.models-n').textContent = `${card.models.length} 模型`
    node.dataset.cardId = card.id
    node.draggable = true
    node.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/plain', card.id))

    const isActive = state.active[state.tool] === card.id
    if (isActive) node.classList.add('active')

    const actions = node.querySelector('.actions')
    const bind = (act, fn) => {
      const btn = actions.querySelector(`[data-act="${act}"]`)
      if (btn) btn.addEventListener('click', (e) => { e.stopPropagation(); fn(card) })
    }
    bind('active', async () => {
      const r = await hub().cards.setActive(state.tool, card.id)
      setStatus(r.ok ? `已启用 ${card.name} → ${state.tool}` : `启用失败：${r.error}`)
      refresh()
    })
    bind('probe', async () => {
      setStatus(`测速 ${card.name}（单次 GET /v1/models，空闲 5s 超时）…`)
      const r = await hub().health.probe(card.id)
      setStatus(r.ok && r.data.reachable ? `测速完成 ${card.name}：可达 ${r.data.status}（${r.data.latencyMs}ms）` : `测速 ${card.name}：不可达（${r.data.error || r.error}）`)
    })
    bind('duplicate', async () => {
      const r = await hub().cards.duplicate(card.id)
      setStatus(r.ok ? `已复制 ${card.name}` : `复制失败：${r.error}`)
      refresh()
    })
    bind('remove', async () => {
      const r = await hub().cards.remove(card.id)
      if (!r.ok) { setStatus(`删除受阻：${r.error}`); if (r.activeApps) setStatus(`删除受阻：${card.name} 正被 ${r.activeApps.join(' / ')} 激活，先切换再删`); return }
      setStatus(`已删除 ${card.name}`)
      refresh()
    })
    node.addEventListener('click', () => openDrawer(card))
    list.appendChild(node)
  }
  // 拖拽排序
  list.addEventListener('dragover', (e) => e.preventDefault())
  list.addEventListener('drop', async (e) => {
    e.preventDefault()
    const from = e.dataTransfer.getData('text/plain')
    if (!from) return
    const idx = [...list.children].findIndex((el) => el.dataset.cardId === from)
    await hub().cards.reorder(from, idx)
    refresh()
  })
}

// ── 详情抽屉：模型管理 + 工具矩阵 + 密钥池 ─────────────────────────────────
async function openDrawer(card) {
  state.drawerCard = card
  $('#drawer').hidden = false
  $('#drawerTitle').textContent = `${card.name}（${card.protocol}）`
  $('#fetchStatus').textContent = '未拉取'
  await renderModels(card)
  await renderToolMatrix(card)
  await renderFailover(card)
  await renderPool(card)
  await renderUsage()
}

async function renderModels(card) {
  const table = $('#modelTable')
  table.innerHTML = ''
  const rows = card.models.map((m) => {
    const tr = document.createElement('tr')
    const isDefault = m === card.defaultModel
    tr.innerHTML = `<td><label><input type="radio" name="defModel" value="${m}" ${isDefault ? 'checked' : ''} /> ${m}</label></td><td>${isDefault ? '默认 ✓' : ''}</td>`
    return tr
  })
  table.append(...rows)
  table.addEventListener('change', async () => {
    const sel = table.querySelector('input[name="defModel"]:checked')
    if (sel) {
      await hub().models.apply(card.id, card.models, sel.value)
      card.defaultModel = sel.value
      refresh()
    }
  }, { once: false })
}

async function renderToolMatrix(card) {
  const box = $('#toolMatrix')
  box.innerHTML = ''
  for (const app of state.tools) {
    const row = document.createElement('div')
    row.className = 'tool-row'
    const applied = state.active[app] === card.id
    row.innerHTML = `<span>${app}</span><span class="hint">${applied ? '已应用' : '—'}</span>`
    const btn = document.createElement('button')
    btn.className = 'ghost sm'
    btn.textContent = applied ? '撤销' : '应用'
    btn.addEventListener('click', async () => {
      const r = applied ? await hub().cards.clearActive(app) : await hub().tools.apply(app, card.id)
      setStatus(r.ok ? `${applied ? '已撤销' : '已应用'} ${card.name} → ${app}` : `操作失败：${r.error}`)
      refresh()
      openDrawer(card)
    })
    row.appendChild(btn)
    box.appendChild(row)
  }
}

async function renderFailover(card) {
  const box = $('#failoverView')
  box.innerHTML = ''
  const app = state.tool
  const r = await hub().cards.list()
  if (!r.ok) { box.textContent = '卡片读取失败'; return }
  const queue = (r.data.failover && r.data.failover[app]) || []
  const names = queue.map((id) => (card && id === card.id ? card.name : (r.data.cards.find((c) => c.id === id) || {}).name || id))
  if (queue.length === 0) {
    box.innerHTML = `<div>无备卡队列：将其它卡片加入 failover 后，健康探测失败可一键轮换</div>`
  } else {
    box.innerHTML = `<div>P1=${(r.data.cards.find((c) => c.id === state.active[app]) || {}).name || state.active[app] || '(未激活)'} → ${names.join(' → ')}</div>`
  }
  const rotate = document.createElement('button')
  rotate.className = 'ghost sm'
  rotate.textContent = `轮换到下一备卡（${app}）`
  rotate.disabled = queue.length === 0
  rotate.addEventListener('click', async () => {
    const rr = await hub().cards.rotateFailover(app)
    setStatus(rr.ok ? `已轮换 ${app}：激活 ${rr.data.promoted}（原 ${rr.data.retired || '(无)'} 降级队尾）` : `轮换失败：${rr.error}`)
    refresh()
    openDrawer(state.drawerCard)
  })
  box.appendChild(rotate)
  // 将当前卡加入备卡队列（若未在其中）
  const addBtn = document.createElement('button')
  addBtn.className = 'ghost sm'
  addBtn.textContent = `把 ${card.name} 加入 ${app} 备卡队列`
  addBtn.style.marginLeft = '8px'
  addBtn.addEventListener('click', async () => {
    const ids = [...queue, card.id]
    const rr = await hub().cards.setFailover(app, ids)
    setStatus(rr.ok ? `failover 队列已更新：${app} → ${ids.length} 张备卡` : `设置失败：${rr.error}`)
    refresh()
    openDrawer(state.drawerCard)
  })
  box.appendChild(addBtn)
}

async function renderUsage() {
  const box = $('#usageChart')
  const note = $('#usageNote')
  box.innerHTML = ''
  const r = await hub().usage.summary(7)
  if (!r.ok || !r.data.available) {
    note.textContent = r.data?.error || r.error
    return
  }
  const days = r.data.days
  const max = Math.max(1, ...days.map((d) => d.totalTokens))
  for (const d of days) {
    const bar = document.createElement('div')
    bar.className = 'usage-bar'
    bar.title = `${d.date}：${d.totalTokens} tokens / ${d.requests} 次 / $${d.costUSD}`
    const fill = document.createElement('div')
    fill.className = 'usage-bar-fill'
    fill.style.height = `${Math.round((d.totalTokens / max) * 100)}%`
    bar.appendChild(fill)
    box.appendChild(bar)
  }
  const total = days.reduce((s, d) => s + d.totalTokens, 0)
  note.textContent = total > 0 ? `近 7 天共 ${total} tokens（数据源: ${r.data.source || 'khy 账本'}）` : '近 7 天无用量记录'
}

async function renderPool(card) {
  const box = $('#poolView')
  box.innerHTML = ''
  const r = await hub().keys.list()
  if (!r.ok) { box.textContent = '密钥池不可读'; return }
  const shown = (r.data.providers || []).map((p) => p.keys).flat()
  const hit = shown.find((k) => k.keyId === card.keyId)
  if (hit) {
    box.innerHTML = `<div>当前绑定：<code>${hit.keyId}</code>（${hit.mask}，来源池 ${hit.fingerprint ? hit.endpoint || '未设端点' : ''}）</div>`
  } else {
    box.innerHTML = '<div>未绑定密钥：添加池条目后在卡片编辑里填入 keyId</div>'
  }
}

// ── 顶栏：代理 / 工具切换 / 一键导入 / 添加 ─────────────────────────────────
async function initTopbar() {
  const toolSel = $('#toolSwitcher')
  for (const t of state.tools) {
    const o = document.createElement('option')
    o.value = t
    o.textContent = t
    toolSel.appendChild(o)
  }
  toolSel.value = state.tool
  toolSel.addEventListener('change', () => { state.tool = toolSel.value; refresh() })

  const proxy = await hub().proxy.status()
  const p = proxy.data || {}
  $('#proxyToggle').textContent = p.running ? `代理: 运行中 ${p.endpoint || ''}` : '代理: 未运行'
  $('#proxyToggle').addEventListener('click', async () => {
    const r = await hub().proxy.start()
    setStatus(r.ok ? `网关已运行（${r.data.detail}）` : r.error)
    const q = await hub().proxy.status()
    const qd = q.data || {}
    $('#proxyToggle').textContent = qd.running ? `代理: 运行中 ${qd.endpoint || ''}` : '代理: 未运行'
  })

  $('#importBtn').addEventListener('click', async () => {
    setStatus('探测本机工具配置（6 工具 live config）…')
    const r = await hub().tools.detect()
    if (!r.ok) { setStatus(`导入失败：${r.error}`); return }
    let n = 0
    for (const row of r.data.results) {
      for (const p of row.providers || []) {
        const ir = await hub().tools.importCard(row.app, p)
        if (ir.ok) n += 1
      }
    }
    setStatus(`一键导入完成：新增 ${n} 张卡片（同名同端点自动去重）`)
    refresh()
  })

  $('#addCardBtn').addEventListener('click', async () => {
    const name = prompt('卡片名称：')
    if (!name) return
    const baseUrl = prompt('端点 Base URL：')
    if (!baseUrl) return
    const protocol = prompt('协议（openai / anthropic / openai_responses）：', 'openai') || 'openai'
    const keyId = prompt('密钥池 keyId（可留空，稍后绑定）：') || ''
    const r = await hub().cards.add({ name, baseUrl, protocol, keyId })
    setStatus(r.ok ? `已添加卡片 ${name}` : `添加失败：${r.error}`)
    refresh()
  })

  $('#drawerClose').addEventListener('click', () => { $('#drawer').hidden = true; state.drawerCard = null })
  $('#fetchModelsBtn').addEventListener('click', async () => {
    const card = state.drawerCard
    if (!card) return
    $('#fetchStatus').textContent = `拉取模型目录 ${card.name}（空闲 15s 超时）…`
    const r = await hub().models.fetch(card.id)
    const d = r.data || {}
    if (r.ok && d.verified) {
      const ar = await hub().models.apply(card.id, d.models, card.defaultModel)
      card.models = ar.data.models
      card.defaultModel = ar.data.defaultModel
      $('#fetchStatus').textContent = `已拉取 ${d.models.length} 个模型并合并（已有条目不覆盖）`
      renderModels(card)
      refresh()
    } else {
      $('#fetchStatus').textContent = `拉取 ${card.name}：${d.error || r.error || '失败'}`
    }
  })
}

refresh()
initTopbar()
