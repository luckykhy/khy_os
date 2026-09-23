/**
 * 任务看板的**视图模型层**（零依赖纯函数，可被两个前端与 Node 测试共同消费）。
 *
 * 与后端 `services/backend/src/tasks/largeTaskBoard.js` 的分工：
 *   • 后端负责「真源 → 看板数据」的派生（11 态折叠、泳道归属、动作门控）。
 *   • 本层负责「看板数据 → 渲染所需形态」的纯计算，且**对残缺输入绝不抛**——
 *     后端版本升级、字段增删、请求被拦截返回半截数据时，UI 仍要能渲染出
 *     一个诚实的降级视图，而不是白屏。
 *
 * 三条硬约束：
 *   • 不复制后端真源（不重定义 11 态折叠表 / 动作门控表），只做**形态归一**。
 *   • 任何卡片都不许因为「它的泳道不在 swimlanes 里」而消失 —— 缺失则合成泳道。
 *   • 展示文案集中在此处，组件里不散落硬编码中文。
 */

/** 看板列顺序（仅用于后端未返回 `lanes` 时的降级骨架，不是折叠表真源）。 */
export const LANE_ORDER = Object.freeze(['backlog', 'active', 'paused', 'done', 'failed', 'closed']);

/** 列标题的降级文案（后端正常返回时以后端 `lanes[].title` 为准）。 */
export const LANE_TITLES = Object.freeze({
  backlog: '待办/排队',
  active: '执行中',
  paused: '已暂停',
  done: '已完成',
  failed: '失败/死信',
  closed: '已取消',
});

export const ACTION_LABELS = Object.freeze({
  pause: '暂停',
  resume: '恢复',
  cancel: '取消',
});

export const ACTION_ORDER = Object.freeze(['pause', 'resume', 'cancel']);

/** 三档断点（px）。`desktop` 走矩阵，`tablet`/`mobile` 一律不做横向滚动矩阵（方案 F6）。 */
export const BREAKPOINTS = Object.freeze({ tablet: 1024, mobile: 640 });

export const SWIMLANE_KIND_LABELS = Object.freeze({
  agent: '执行体',
  system: '系统',
  human: '人工',
});

/**
 * 状态 → 语义色调。**这是前端唯一的状态知识表**。
 *
 * ⚠ 这是**有界耦合**（有意接受，但必须知道边界）：后端新增第 12 个状态时，
 *   本表不会自动跟上 —— 表现为该状态的卡片拿到 `neutral` 色调、且不计入任何
 *   摘要桶。不会崩，但会**静默降级**。所以：
 *   • 本表由 `tests/board.test.js` 锁住（覆盖 11 态 + 未知回退）；
 *   • 后端 11 态由 `services/backend/tests/tasks/largeTaskBoard.test.js` 锁住；
 *   • 两侧状态总数若漂移，由 `_产物/board-lane-map.js` 的 `L2-drift` 暴露。
 *
 * 之所以必须存在：状态着色与摘要计数是**呈现层**决策，无法从后端派生 ——
 * 后端只给列级 `terminal: all|none|mixed`，不足以区分「排队」与「暂停」。
 */
export const STATUS_TONE = Object.freeze({
  queued: 'neutral',
  claimed: 'neutral',
  retry_wait: 'neutral',
  running: 'running',
  pausing: 'warn',
  paused: 'warn',
  cancelling: 'neutral',
  cancelled: 'neutral',
  succeeded: 'ok',
  failed: 'error',
  dead_letter: 'error',
});

/** 未知状态一律 `neutral`（fail-soft：宁可颜色普通，也不要白屏或抛错）。 */
export function statusTone(status) {
  return STATUS_TONE[_str(status)] || 'neutral';
}

// ── 归一化（全部 fail-soft） ────────────────────────────────────────────────

const _arr = (v) => (Array.isArray(v) ? v : []);
const _str = (v, d = '') => (typeof v === 'string' ? v : d);
const _num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const _bool = (v) => v === true;

function _clampPct(v) {
  const n = _num(v, 0);
  if (n < 0) return 0;
  if (n > 100) return 100;
  return Math.round(n);
}

/** 单张卡片归一化。`id` 缺失的卡片会被丢弃（无法定位，渲染出来也点不动）。 */
export function normalizeCard(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = _str(raw.id).trim();
  if (!id) return null;
  const actions = raw.actions && typeof raw.actions === 'object' ? raw.actions : {};
  return {
    id,
    status: _str(raw.status),
    lane: typeof raw.lane === 'string' && raw.lane ? raw.lane : null,
    swimlane: _str(raw.swimlane) || '__unassigned__',
    type: _str(raw.type, 'generic'),
    source: _str(raw.source),
    title: _str(raw.title) || id,
    progressPct: _clampPct(raw.progress_pct),
    attemptCount: _num(raw.attempt_count, 0),
    maxAttempts: Number.isFinite(Number(raw.max_attempts)) ? Number(raw.max_attempts) : null,
    updatedAt: _str(raw.updated_at) || null,
    createdAt: _str(raw.created_at) || null,
    worktree: _str(raw.worktree) || null,
    noWorktreeReason: _str(raw.no_worktree_reason) || null,
    actions: {
      pause: _bool(actions.pause),
      resume: _bool(actions.resume),
      cancel: _bool(actions.cancel),
    },
  };
}

export function normalizeSwimlane(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = _str(raw.id).trim();
  if (!id) return null;
  return {
    id,
    title: _str(raw.title) || id,
    kind: _str(raw.kind, 'agent'),
    source: _str(raw.source, id),
    count: _num(raw.count, 0),
  };
}

export function normalizeLane(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = _str(raw.id).trim();
  if (!id) return null;
  return {
    id,
    title: _str(raw.title) || LANE_TITLES[id] || id,
    terminal: _str(raw.terminal, 'none'),
    statuses: _arr(raw.statuses).map((s) => _str(s)).filter(Boolean),
    count: _num(raw.count, 0),
  };
}

/**
 * 归一化整个看板载荷。**绝不抛**；任何字段缺失都给出可渲染的降级形态。
 * 关键不变量：`cards` 里出现过的 `swimlane` 一定存在于返回的 `swimlanes` 中
 * （否则那张卡片会从界面上消失 —— 这是最不能接受的失真）。
 */
export function normalizeBoard(payload) {
  const src = payload && typeof payload === 'object' ? payload : {};

  let lanes = _arr(src.lanes).map(normalizeLane).filter(Boolean);
  if (lanes.length === 0) {
    lanes = LANE_ORDER.map((id) => ({ id, title: LANE_TITLES[id] || id, terminal: 'none', statuses: [], count: 0 }));
  }

  const cards = _arr(src.cards).map(normalizeCard).filter(Boolean);

  let swimlanes = _arr(src.swimlanes).map(normalizeSwimlane).filter(Boolean);
  const known = new Set(swimlanes.map((s) => s.id));
  const orphanIds = [];
  for (const card of cards) {
    if (!known.has(card.swimlane)) {
      known.add(card.swimlane);
      orphanIds.push(card.swimlane);
    }
  }
  for (const id of orphanIds) {
    swimlanes.push({ id, title: id, kind: 'agent', source: id, count: 0 });
  }

  // count 以实际卡片为准重算（后端 count 可能因 limit 截断而与可见卡片不一致）
  const byLane = {};
  const bySwimlane = {};
  for (const lane of lanes) byLane[lane.id] = 0;
  for (const lane of swimlanes) bySwimlane[lane.id] = 0;
  let unmapped = 0;
  for (const card of cards) {
    if (card.lane && Object.prototype.hasOwnProperty.call(byLane, card.lane)) byLane[card.lane] += 1;
    else unmapped += 1;
    if (Object.prototype.hasOwnProperty.call(bySwimlane, card.swimlane)) bySwimlane[card.swimlane] += 1;
  }
  lanes = lanes.map((lane) => ({ ...lane, count: byLane[lane.id] || 0 }));
  swimlanes = swimlanes.map((lane) => ({ ...lane, count: bySwimlane[lane.id] || 0 }));

  const rawCounts = src.counts && typeof src.counts === 'object' ? src.counts : {};
  const reportedUnmapped = _num(rawCounts.unmapped, 0);
  const reportedTotal = _num(src.total, cards.length);

  return {
    lanes,
    swimlanes,
    cards,
    total: Math.max(cards.length, reportedTotal),
    visibleTotal: cards.length,
    // unmapped 取「后端报告的」与「本地实际算出的」的较大值 —— 宁可多报也不许掩盖
    unmapped: Math.max(unmapped, reportedUnmapped),
    generatedAt: _str(src.generated_at) || null,
  };
}

// ── 派生视图 ────────────────────────────────────────────────────────────────

/** 三档断点判定。width 非数时按 desktop 处理（宁可给全功能视图）。 */
export function resolveBreakpoint(width) {
  const w = _num(width, Number.POSITIVE_INFINITY);
  if (w < BREAKPOINTS.mobile) return 'mobile';
  if (w < BREAKPOINTS.tablet) return 'tablet';
  return 'desktop';
}

/**
 * 概览计数：仅统计可见卡片（诚实反映「你现在看到的东西」）。
 * 四个语义桶全部由 `statusTone()` 派生 —— 不在本函数里再写一遍状态字面量，
 * 否则「前端唯一的状态知识表」就名存实亡。
 */
export function summarize(board) {
  const b = board || {};
  const cards = _arr(b.cards);
  const byTone = { neutral: 0, running: 0, warn: 0, ok: 0, error: 0 };
  let actionable = 0;
  for (const card of cards) {
    const tone = statusTone(card.status);
    byTone[tone] = (byTone[tone] || 0) + 1;
    if (card.actions.pause || card.actions.resume || card.actions.cancel) actionable += 1;
  }
  return {
    total: _num(b.total, cards.length),
    visible: cards.length,
    unmapped: _num(b.unmapped, 0),
    running: byTone.running,
    paused: byTone.warn,
    failed: byTone.error,
    done: byTone.ok,
    actionable,
  };
}

/**
 * 要显示的泳道。`hideEmpty`（默认 true）时过滤掉没有卡片的泳道 ——
 * 真源里有 9 个执行体 + 2 个系统 source + 1 个兜底，全展示会出现 11 行空白。
 * ⚠ 全空时**返回全部泳道**而非空数组，好让调用方给出「确实没有任务」的提示。
 */
export function visibleSwimlanes(board, options = {}) {
  const all = _arr((board || {}).swimlanes);
  const hideEmpty = options.hideEmpty !== false;
  if (!hideEmpty) return all.slice();
  const nonEmpty = all.filter((s) => _num(s.count, 0) > 0);
  return nonEmpty.length > 0 ? nonEmpty : all.slice();
}

/** 取某个 (泳道, 列) 单元格内的卡片。 */
export function cardsAt(board, swimlaneId, laneId) {
  return _arr((board || {}).cards).filter((c) => c.swimlane === swimlaneId && c.lane === laneId);
}

/** 某个泳道下所有卡片（按列顺序排列，便于单列流渲染）。 */
export function cardsOfSwimlane(board, swimlaneId) {
  const order = _arr((board || {}).lanes).map((l) => l.id);
  const cards = _arr((board || {}).cards).filter((c) => c.swimlane === swimlaneId);
  return cards.slice().sort((a, b) => {
    const ia = a.lane ? order.indexOf(a.lane) : order.length;
    const ib = b.lane ? order.indexOf(b.lane) : order.length;
    if (ia !== ib) return ia - ib;
    return String(a.id).localeCompare(String(b.id));
  });
}

/** 手机端的列切换器模型（含计数）。 */
export function laneTabs(board, activeLaneId) {
  const lanes = _arr((board || {}).lanes);
  const active = activeLaneId || (lanes[0] ? lanes[0].id : null);
  return {
    active,
    tabs: lanes.map((lane) => ({ ...lane, active: lane.id === active })),
  };
}

/** 卡片是否可执行某动作（组件与宿主都从这里取，避免两处各判一次）。 */
export function isActionable(card, action) {
  if (!card || !card.actions) return false;
  return card.actions[action] === true;
}

export function actionLabel(action) {
  return ACTION_LABELS[action] || String(action || '');
}

/** 相对时间文案（不引第三方库）。无法解析时返回空串，由组件决定不显示。 */
export function formatRelative(iso, now = Date.now()) {
  const text = _str(iso);
  if (!text) return '';
  const t = Date.parse(text);
  if (Number.isNaN(t)) return '';
  const diff = now - t;
  if (diff < 0) return '刚刚';
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return '刚刚';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  if (day < 30) return `${day} 天前`;
  const month = Math.floor(day / 30);
  if (month < 12) return `${month} 个月前`;
  return `${Math.floor(month / 12)} 年前`;
}

/** 空态文案：区分「真没有任务」与「有任务但都被过滤掉了」。 */
export function emptyMessage(board) {
  const b = board || {};
  if (_num(b.total, 0) > 0 && _arr(b.cards).length === 0) {
    return '任务总数不为 0，但本次返回的卡片为空 —— 可能是分页或过滤条件所致。';
  }
  return '当前没有大型任务。';
}
