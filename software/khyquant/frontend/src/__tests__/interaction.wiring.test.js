/**
 * Interaction wiring contract tests for the khyquant frontend.
 *
 * Source-level contract tests (views import Vue + `@/` aliases, so they cannot be
 * imported under plain vitest). Each test asserts one wiring chain between a
 * user-visible control (button / menu item / dialog action) and a real handler:
 * a control is "wired" only if the event it raises is declared, emitted by the
 * child that renders it, listened by the parent that mounts it, and the final
 * target (route / window event) actually exists.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { describe, test, expect } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const read = (rel) => readFileSync(resolve(here, rel), 'utf8')

// ---------------------------------------------------------------------------
// Bracket-aware slicing helpers (copied pattern from the ai-frontend contract
// tests: never regex across arbitrary nesting, track brackets instead).
// ---------------------------------------------------------------------------

function sliceBalanced(src, startIdx, openCh = '{', closeCh = '}') {
  const open = startIdx
  let depth = 0
  for (let i = open; i < src.length; i++) {
    const c = src[i]
    if (c === openCh) depth++
    else if (c === closeCh) {
      depth--
      if (depth === 0) return src.slice(open, i + 1)
    }
  }
  return src.slice(open)
}

function stripLineComments(src) {
  return src
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
}

function topLevelArray(src, name) {
  const marker = `const ${name} = [`
  const idx = src.indexOf(marker)
  if (idx === -1) return ''
  return sliceBalanced(src, idx + marker.length - 1, '[', ']')
}

// ---------------------------------------------------------------------------
// Router surface: registered paths resolved from router/index.js source.
// ---------------------------------------------------------------------------

const routerSrc = stripLineComments(read('../router/index.js'))

/** Extract `path: '...'` literals at any nesting depth of the route table. */
function resolveRoutes(src) {
  const paths = new Set()
  const re = /path\s*:\s*(['"`])([^'"`]+)\1/g
  let m
  while ((m = re.exec(src))) paths.add(m[2])
  // redirect entries use the same `path:` key in a shorthand entry
  // ({ path: 'ai', redirect: '/admin/ai-gateway' }) — the redirect target is
  // registered separately below via the redirect value set.
  return paths
}

function resolveRedirects(src) {
  const targets = new Set()
  const re = /redirect\s*:\s*(['"`])([^'"`]+)\1/g
  let m
  while ((m = re.exec(src))) targets.add(m[2])
  return targets
}

const registeredPaths = resolveRoutes(routerSrc)
const redirectTargets = resolveRedirects(routerSrc)

/** Does a pushed path (optionally with query `?...`) match a registered route? */
function routeMatches(pushed) {
  const bare = pushed.split('?')[0]
  if (registeredPaths.has(bare)) return true
  if (redirectTargets.has(bare)) return true
  // child routes are declared without the leading slash
  if (registeredPaths.has(bare.replace(/^\//, ''))) return true
  return false
}

// ---------------------------------------------------------------------------
// 1. Every router.push / el-menu-item target in routed, user-visible surfaces
//    must resolve to a registered route (or a declared route name).
// ---------------------------------------------------------------------------

describe('route targets in user-visible surfaces resolve to registered routes', () => {
  const declaredNames = new Set()
  {
    const re = /name\s*:\s*(['"`])([^'"`]+)\1/g
    let m
    while ((m = re.exec(routerSrc))) declaredNames.add(m[2])
  }

  /** Collect `router.push('...')` and template `router.push('...')` literals. */
  function pushLiterals(src) {
    const out = []
    const re = /router\.push\(\s*(['"`])([^'"`]+)\1/g
    let m
    while ((m = re.exec(src))) out.push(m[2])
    return out
  }

  /** Collect template literal pushes: router.push(`/foo${x}`) etc. */
  function pushTemplateLiterals(src) {
    const out = []
    const re = /router\.push\(\s*`([^`]*)`/g
    let m
    while ((m = re.exec(src))) out.push(m[1].replace(/\$\{[^}]*\}/g, ''))
    return out
  }

  /** Pushed route names: router.push({ name: 'X', ... }) must be declared. */
  function pushedNames(src) {
    const out = []
    const re = /router\.push\(\s*\{\s*name\s*:\s*(['"`])([^'"`]+)\1/g
    let m
    while ((m = re.exec(src))) out.push(m[2])
    return out
  }

  test.each([
    // routed views (every one of these is reachable from the nav menu)
    // NOTE: rel is resolved against `../` (the test lives in src/__tests__), so
    // these must NOT carry a `src/` prefix — see the sibling read('../views/...').
    ['views/Dashboard.vue'],
    ['views/Trading.vue'],
    ['views/Announcements.vue'],
    ['views/Feedback.vue'],
    ['views/Profile.vue'],
    ['views/ApiKeyManage.vue'],
    ['views/DependencyManagement.vue'],
    ['views/SystemManagement.vue'],
    ['views/admin/Dashboard.vue'],
    ['views/AdminLayout.vue'],
    ['views/Login.vue'],
    ['views/AdminLogin.vue'],
    ['views/Register.vue'],
    ['views/ForgotPassword.vue'],
    // components mounted by routed views (their dead links are user-visible)
    ['components/SimpleTradingInterface.js'],
    ['components/MobileLayout.vue'] // mounted in Layout.vue when isMobileDevice
  ])('%s: all router.push targets are registered routes', (rel) => {
    const src = stripLineComments(read('../' + rel))
    for (const target of pushLiterals(src)) {
      expect(
        routeMatches(target),
        `${rel} pushes unregistered route "${target}"`
      ).toBe(true)
    }
    for (const target of pushTemplateLiterals(src)) {
      expect(
        routeMatches(target),
        `${rel} pushes unregistered route template "${target}"`
      ).toBe(true)
    }
    for (const name of pushedNames(src)) {
      expect(
        declaredNames.has(name),
        `${rel} pushes undeclared route name "${name}"`
      ).toBe(true)
    }
  })

  test('MobileLayout menu items and bottom tabs all point to registered routes', () => {
    const src = stripLineComments(read('../components/MobileLayout.vue'))
    const menu = topLevelArray(src, 'menuItems')
    const tabs = topLevelArray(src, 'bottomTabs')
    expect(menu.length).toBeGreaterThan(0)
    expect(tabs.length).toBeGreaterThan(0)
    const bad = []
    const re = /path\s*:\s*(['"`])([^'"`]+)\1/g
    for (const block of [menu, tabs]) {
      let m
      while ((m = re.exec(block))) if (!routeMatches(m[2])) bad.push(m[2])
    }
    expect(bad, `MobileLayout dead menu links: ${bad.join(', ')}`).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 2. Trading.vue mobile FAB bot button must reach the AI assistant that
//    Layout.vue mounts (TradingAgentsBotSimple listens for the window event
//    'show-ai-assistant'). A bare `$emit('open-bot')` is a dead control:
//    Trading.vue declares no emits, so the click does nothing.
// ---------------------------------------------------------------------------

describe('Trading.vue mobile bot FAB is wired to the assistant', () => {
  const tradingSrc = stripLineComments(read('../views/Trading.vue'))

  test('bot FAB click dispatches show-ai-assistant instead of a bare $emit', () => {
    const fabIdx = tradingSrc.indexOf("class=\"mobile-fab-bot\"")
    expect(fabIdx).toBeGreaterThan(-1)
    const fabBlock = tradingSrc.slice(fabIdx, fabIdx + 400)
    expect(
      fabBlock,
      'mobile-fab-bot must not keep the dead bare $emit("open-bot") handler'
    ).not.toMatch(/\$emit\(\s*['"]open-bot['"]/)
    expect(
      fabBlock,
      'bot FAB must dispatch the window event TradingAgentsBotSimple listens for'
    ).toMatch(/dispatchEvent\(\s*new\s+(Custom)?Event\(\s*['"]show-ai-assistant['"]/)
  })

  test('Trading.vue does not declare an unused open-bot emit while unwired', () => {
    // Guard the fix direction: if open-bot is emitted, it must be declared
    // AND some ancestor must listen; simplest contract here is the window
    // event (Dashboard.vue uses the same pattern for its AI assistant button).
    if (/\$emit\(\s*['"]open-bot['"]/.test(tradingSrc)) {
      expect(tradingSrc).toMatch(/defineEmits|emits\s*:/)
    }
  })

  test('the assistant listener side exists: TradingAgentsBotSimple listens for show-ai-assistant', () => {
    const botSrc = stripLineComments(
      read('../components/TradingAgentsBotSimple.vue')
    )
    expect(botSrc).toMatch(/addEventListener\(\s*['"]show-ai-assistant['"]/)
    const layoutSrc = stripLineComments(read('../views/Layout.vue'))
    expect(layoutSrc).toMatch(/<TradingAgentsBot/)
  })
})

// ---------------------------------------------------------------------------
// 3. Order submission chain: ModernTradingPanel emits order-submitted after a
//    successful order, so its only mount site must listen and forward to the
//    handler Trading.vue already has (handleOrderPlaced refreshes account
//    info). Without this wiring the PC order flow silently does nothing
//    beyond the child's own toast.
// ---------------------------------------------------------------------------

describe('ModernTradingPanel order-submitted is heard and forwarded', () => {
  const panelSrc = stripLineComments(read('../components/ModernTradingPanel.vue'))
  const ifaceVue = stripLineComments(read('../components/SimpleTradingInterface.vue'))
  const ifaceJs = stripLineComments(read('../components/SimpleTradingInterface.js'))
  const tradingSrc = stripLineComments(read('../views/Trading.vue'))

  test('panel declares and emits order-submitted after API success', () => {
    expect(panelSrc).toMatch(/defineEmits\(\s*\[[^\]]*['"]order-submitted['"]/)
    expect(panelSrc).toMatch(/emit\(\s*['"]order-submitted['"]/)
  })

  test('SimpleTradingInterface mount listens for order-submitted', () => {
    const m = ifaceVue.match(/<ModernTradingPanel[\s\S]{0,400}?>/)
    expect(m, 'ModernTradingPanel must be mounted in the interface').not.toBeNull()
    expect(
      m[0],
      '<ModernTradingPanel> must bind @order-submitted so the parent can react'
    ).toMatch(/@order-submitted\s*=/)
  })

  test('SimpleTradingInterface re-emits order-placed for its own parent', () => {
    // Trading.vue listens @order-placed="handleOrderPlaced" on this component;
    // the interface must forward the panel event so the routed view refreshes.
    expect(ifaceJs).toMatch(/emit\(\s*['"]order-placed['"]/)
    expect(ifaceJs).toMatch(/emits\s*:[^\]]*['"]order-placed['"]/)
  })

  test('Trading.vue listens for order-placed with a real handler that refreshes account info', () => {
    expect(tradingSrc).toMatch(/@order-placed\s*=\s*['"]handleOrderPlaced['"]/)
    const fn = tradingSrc.match(/function handleOrderPlaced[\s\S]{0,600}/)
    expect(fn, 'handleOrderPlaced must exist').not.toBeNull()
    expect(fn[0]).toMatch(/fetchAccountInfo/)
  })
})

// ---------------------------------------------------------------------------
// 4. Emit contract hygiene: every event emitted by a child must be declared
//    (Vue warns and falls back to DOM attrs for undeclared emits), and every
//    event a parent listens for must actually be emitted by the child.
// ---------------------------------------------------------------------------

describe('emit contracts between Trading.vue and SimpleTradingInterface', () => {
  const tradingSrc = stripLineComments(read('../views/Trading.vue'))
  const ifaceJs = stripLineComments(read('../components/SimpleTradingInterface.js'))

  const declared = (() => {
    const m = ifaceJs.match(/emits\s*:\s*\[([^\]]*)\]/)
    return new Set(
      (m ? m[1] : '')
        .split(',')
        .map((s) => s.trim().replace(/['"]/g, ''))
        .filter(Boolean)
    )
  })()

  const actuallyEmitted = new Set()
  {
    const re = /(?<!\$)emit\(\s*(['"`])([^'"`]+)\1/g
    let m
    while ((m = re.exec(ifaceJs))) actuallyEmitted.add(m[2])
  }

  const listenedOnIface = new Set()
  {
    // @foo="bar" bindings on the <SimpleTradingInterface ...> mount in Trading.vue
    const mount = tradingSrc.match(/<SimpleTradingInterface[\s\S]{0,1200}?>/)
    const re = /@([a-z0-9-]+)\s*=/g
    let m
    if (mount) {
      while ((m = re.exec(mount[0]))) listenedOnIface.add(m[1])
    }
  }

  test('every event Trading.vue listens for on SimpleTradingInterface is emitted by it', () => {
    expect(listenedOnIface.size).toBeGreaterThan(0)
    const dead = [...listenedOnIface].filter((e) => !actuallyEmitted.has(e))
    expect(
      dead,
      'Trading.vue listens for events the child never emits (dead listeners): ' +
        dead.join(', ')
    ).toEqual([])
  })

  test('every emitted event of SimpleTradingInterface is declared in its emits option', () => {
    const undeclared = [...actuallyEmitted].filter((e) => !declared.has(e))
    expect(
      undeclared,
      'emitted but undeclared (Vue warning + DOM attr fallback): ' +
        undeclared.join(', ')
    ).toEqual([])
  })

  test('declared events are either emitted or pruned (no stale declarations)', () => {
    // signal-loaded / order-placed / navigate-to-backtest-analysis were
    // declared but never emitted; after the fix, order-placed is emitted, and
    // the stale ones must be gone from the declaration.
    const stale = [...declared].filter(
      (e) => !actuallyEmitted.has(e)
    )
    expect(
      stale,
      'declared-but-never-emitted events (stale contracts): ' + stale.join(', ')
    ).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 5. ModernTradingPanel strategy-monitoring events must be declared in
//    defineEmits (they are emitted after real API calls but undeclared).
// ---------------------------------------------------------------------------

describe('ModernTradingPanel emits are declared', () => {
  const panelSrc = stripLineComments(read('../components/ModernTradingPanel.vue'))

  test('all emitted event names appear in defineEmits', () => {
    const declaredMatch = panelSrc.match(/defineEmits\(\s*\[([^\]]*)\]/)
    expect(declaredMatch).not.toBeNull()
    const declared = new Set(
      declaredMatch[1]
        .split(',')
        .map((s) => s.trim().replace(/['"]/g, ''))
        .filter(Boolean)
    )
    const emitted = new Set()
    const re = /emit\(\s*(['"`])([^'"`]+)\1/g
    let m
    while ((m = re.exec(panelSrc))) emitted.add(m[2])
    const undeclared = [...emitted].filter((e) => !declared.has(e))
    expect(
      undeclared,
      'ModernTradingPanel emits undeclared events: ' + undeclared.join(', ')
    ).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 6. The AI assistant window event must have both sides: the dispatcher side
//    (routed views may open the bot) and the listener side. Regression
//    coverage for the pattern the FAB fix relies on.
// ---------------------------------------------------------------------------

describe('show-ai-assistant window event wiring', () => {
  test('Dashboard AI assistant button uses the same working pattern', () => {
    const dashSrc = stripLineComments(read('../views/Dashboard.vue'))
    expect(dashSrc).toMatch(/dispatchEvent\(\s*new\s+Event\(\s*['"]show-ai-assistant['"]\s*\)/)
  })

  test('TradingAgentsBotSimple handles the event by showing itself', () => {
    const botSrc = stripLineComments(
      read('../components/TradingAgentsBotSimple.vue')
    )
    const m = botSrc.match(/addEventListener\(\s*['"]show-ai-assistant['"][\s\S]{0,400}?handleShowAssistant/)
    expect(
      m,
      "the 'show-ai-assistant' listener must route into handleShowAssistant"
    ).not.toBeNull()
  })
})
