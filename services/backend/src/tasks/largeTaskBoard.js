'use strict';

/**
 * Large-task board aggregation — the read-only view model behind
 * `GET /large-tasks/board`.
 *
 * 纯叶子：零 require、零 IO、确定性、绝不抛（与 `agentLauncherRegistry` 同约定）。
 *
 * 本模块是两条设计决策的**唯一运行时真源**：
 *   1. 「11 态 → 6 列」的折叠表（`LANE_MAP`）
 *   2. 「泳道 = `payload_json.source` 的取值」及其三类归属（`kind`）
 * 守卫 `_产物/board-lane-map.js` 直接 require 本模块来校验，避免守卫与运行时
 * 各持一份表而静默漂移。
 *
 * 契约：`docs/03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-126] 跨端 AI 编程任务看板泳道编排方案.md`
 *   §3.2 折叠表 · §4.2 响应契约 · §4.4 泳道维度 · §4.5 F4 的 worktree 出处 · §六 防呆铁律
 *
 * 三条硬约束（改动前先读，破坏任一都会让看板说谎）：
 *   • `terminal` 是**列级**着色/计数用，**卡片能否流转一律由卡片自身 `status` 派生**（F5）。
 *   • `source` 为空或未登记的任务必须落「未归属」泳道，**绝不静默丢弃**（F8）。
 *   • 不新增真源字段：`lane` / `swimlane` / `title` / `actions` 全是派生量。
 */

// ── 列（lane）：11 态 → 6 列 ────────────────────────────────────────────────
// terminal: 'all'   本列全部状态都是终态
//           'none'  本列没有任何终态
//           'mixed' 本列同时含终态与非终态（必须显式声明，不允许含混）
// `closed` 就是 mixed 的实例：`cancelling`（取消中，仍可流转）与 `cancelled`（终态）同列。
const LANE_MAP = Object.freeze({
  backlog: { title: '待办/排队', statuses: Object.freeze(['queued', 'claimed', 'retry_wait']), terminal: 'none' },
  active: { title: '执行中', statuses: Object.freeze(['running']), terminal: 'none' },
  paused: { title: '已暂停', statuses: Object.freeze(['pausing', 'paused']), terminal: 'none' },
  done: { title: '已完成', statuses: Object.freeze(['succeeded']), terminal: 'all' },
  failed: { title: '失败/死信', statuses: Object.freeze(['failed', 'dead_letter']), terminal: 'all' },
  closed: { title: '已取消', statuses: Object.freeze(['cancelling', 'cancelled']), terminal: 'mixed' },
});

const LANE_ORDER = Object.freeze(Object.keys(LANE_MAP));

/** status → lane id。由 `LANE_MAP` 反推，不另立一张表。 */
const STATUS_TO_LANE = Object.freeze(
  LANE_ORDER.reduce((acc, lane) => {
    for (const status of LANE_MAP[lane].statuses) acc[status] = lane;
    return acc;
  }, {})
);

// ── 卡片动作门控（F5：由卡片自身 status 派生，不读列级 terminal）────────────
// 判据真源 = `services/taskControlService.js` 的三个动作准入分支，辅以
// `largeTaskRuntimeStore.STATUS_TRANSITIONS` 的可达性。逐条对齐：
//   pause  ⇔ status === 'running'
//             （_pauseTask: 终态→409 terminal_task；'paused'→no-op already_paused；
//              其余非 running→409 invalid_state。故只有 running 会真正进入暂停流程）
//   resume ⇔ status ∈ {'paused', 'pausing'}
//             （_resumeTask: 'running'→no-op already_running；'pausing'→先补完 pausing→paused
//              再 paused→running；其余→409 invalid_state。pausing 分支显式存在，说明该态可观察）
//   cancel ⇔ status 非终态 且 ≠ 'cancelling'
//             （_cancelTask: 终态→no-op already_terminal；非终态走 runtime.cancelTask，
//              任意非终态→cancelling→cancelled 均合法。唯一例外 'cancelling'：
//              取消已在流程中，按钮冗余 ⇒ 隐藏，这是**刻意的 UI 判断**而非后端限制）
// 终态四态（succeeded/failed/cancelled/dead_letter）三个动作全 false。
// 守卫 `_产物/board-gating-check.js` 会从 STATUS_TRANSITIONS + 终态集合反推并复核本表。
const CARD_ACTIONS = Object.freeze({
  queued: Object.freeze({ pause: false, resume: false, cancel: true }),
  claimed: Object.freeze({ pause: false, resume: false, cancel: true }),
  running: Object.freeze({ pause: true, resume: false, cancel: true }),
  retry_wait: Object.freeze({ pause: false, resume: false, cancel: true }),
  pausing: Object.freeze({ pause: false, resume: true, cancel: true }),
  paused: Object.freeze({ pause: false, resume: true, cancel: true }),
  cancelling: Object.freeze({ pause: false, resume: false, cancel: false }),
  succeeded: Object.freeze({ pause: false, resume: false, cancel: false }),
  failed: Object.freeze({ pause: false, resume: false, cancel: false }),
  cancelled: Object.freeze({ pause: false, resume: false, cancel: false }),
  dead_letter: Object.freeze({ pause: false, resume: false, cancel: false }),
});

const NO_ACTIONS = Object.freeze({ pause: false, resume: false, cancel: false });

// ── 泳道（swimlane）：执行体维度 ────────────────────────────────────────────
// 展示名仅用于列头；`id` 一律用 source 原值，不做转换（避免第二套命名）。
const AGENT_TITLES = Object.freeze({
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  warp: 'Warp',
  cursor: 'Cursor',
  kiro: 'Kiro',
  trae: 'Trae',
  vscode: 'VS Code',
  windsurf: 'Windsurf',
});

/** 平台自身派发的 source（非外部编码 agent）。 */
const SYSTEM_SOURCES = Object.freeze(['background_task_manager', 'cli-learning-curriculum']);

const SYSTEM_SWIMLANE_TITLES = Object.freeze({
  background_task_manager: '后台任务',
  'cli-learning-curriculum': '学习课程',
});

/** 兜底泳道：source 为空 / 未登记时卡片落这里，**绝不丢弃**（F8）。 */
const FALLBACK_SWIMLANE = Object.freeze({
  id: '_unassigned',
  title: '未归属',
  kind: 'system',
  source: '__unassigned__',
});

// ── 纯函数 ─────────────────────────────────────────────────────────────────

/** 状态 → 列 id；未知状态返回 null（调用方必须显式兜底，不得静默归到某列）。 */
function laneForStatus(status) {
  return STATUS_TO_LANE[status] || null;
}

/** 状态 → 可用的卡片动作；未知状态一律不可操作（fail-closed）。 */
function cardActions(status) {
  return CARD_ACTIONS[status] || NO_ACTIONS;
}

/** 由执行体注册表的 command 列表构造泳道表（不含兜底泳道）。 */
function buildSwimlanes(agentCommands) {
  const agents = Array.isArray(agentCommands) ? agentCommands.filter((c) => typeof c === 'string' && c) : [];
  const out = agents.map((command) => ({
    id: command,
    title: AGENT_TITLES[command] || command,
    kind: 'agent',
    source: command,
  }));
  for (const source of SYSTEM_SOURCES) {
    out.push({
      id: source,
      title: SYSTEM_SWIMLANE_TITLES[source] || source,
      kind: 'system',
      source,
    });
  }
  out.push({ ...FALLBACK_SWIMLANE });
  return out;
}

/**
 * source → 泳道 id。
 * 未登记 / 为空 / 非字符串一律落兜底泳道（F8），**不返回 null**。
 */
function swimlaneForSource(source, agentCommands) {
  const value = typeof source === 'string' ? source : '';
  if (!value) return FALLBACK_SWIMLANE.id;
  const agents = Array.isArray(agentCommands) ? agentCommands : [];
  if (agents.includes(value)) return value;
  if (SYSTEM_SOURCES.includes(value)) return value;
  return FALLBACK_SWIMLANE.id;
}

/** djb2 → 4 位十六进制。仅用于无标题时的稳定短标识（同 id 必得同值）。 */
function shortHash(text) {
  let hash = 5381;
  const input = String(text || '');
  for (let i = 0; i < input.length; i += 1) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) & 0xffffffff;
  }
  // ⚠ 必须取**低位**：djb2 的高位只随长度缓慢变化，取高位会让 `t1`/`t3`/`t4` 撞成同一个值。
  return (hash >>> 0).toString(16).padStart(8, '0').slice(-4);
}

/**
 * 卡片标题：`payload_json.title` 优先，缺失时回退 `<type> <短哈希>`。
 * 刻意**不**回退成 `id` 全串 —— 那会把一长串内部 id 顶到列头。
 */
function deriveTitle(task) {
  const payload = task && task.payload_json && typeof task.payload_json === 'object' ? task.payload_json : {};
  const explicit = typeof payload.title === 'string' ? payload.title.trim() : '';
  if (explicit) return explicit;
  const type = typeof task.type === 'string' && task.type ? task.type : 'task';
  return `${type} ${shortHash(task.id)}`;
}

/** 单张任务 → 卡片。派生量全部在此收口，路由层不再加工。 */
function toCard(task, agentCommands) {
  const payload = task && task.payload_json && typeof task.payload_json === 'object' ? task.payload_json : {};
  const source = typeof payload.source === 'string' ? payload.source : '';
  const status = typeof task.status === 'string' ? task.status : '';
  const lane = laneForStatus(status);
  return {
    id: task.id,
    status,
    // 未知状态落 `null` 而非猜一个列 —— 由 counts.unmapped 计数暴露，不静默丢单。
    lane,
    swimlane: swimlaneForSource(source, agentCommands),
    type: typeof task.type === 'string' ? task.type : 'generic',
    source,
    title: deriveTitle(task),
    progress_pct: Number.isFinite(Number(task.progress_pct)) ? Number(task.progress_pct) : 0,
    attempt_count: Number.isFinite(Number(task.attempt_count)) ? Number(task.attempt_count) : 0,
    max_attempts: Number.isFinite(Number(task.max_attempts)) ? Number(task.max_attempts) : null,
    updated_at: task.updated_at || null,
    created_at: task.created_at || null,
    // F4：worktree 出自 payload_json.worktree（由 tools/_taskStore.bindWorktree 写入）。
    // 该绑定路径当前在生产代码里零调用点，故实际恒为 null —— 见方案 §4.5。
    worktree: typeof payload.worktree === 'string' && payload.worktree ? payload.worktree : null,
    no_worktree_reason: typeof payload.no_worktree_reason === 'string' ? payload.no_worktree_reason : null,
    actions: cardActions(status),
  };
}

/**
 * 聚合整个看板。**绝不抛** —— 任何异常都退化为空结构，让前端渲染空看板而不是白屏。
 *
 * @param {Array<object>} tasks 运行时任务列表（`runtime.listTasks()` 的输出）
 * @param {{ agentCommands?: string[], limit?: number }} [options]
 * @returns {{ lanes: object[], swimlanes: object[], cards: object[], counts: object, total: number }}
 */
function buildBoard(tasks, options = {}) {
  const empty = { lanes: [], swimlanes: [], cards: [], counts: { byLane: {}, bySwimlane: {}, unmapped: 0 }, total: 0 };
  try {
    const list = Array.isArray(tasks) ? tasks.filter((t) => t && typeof t === 'object' && t.id) : [];
    const agentCommands = Array.isArray(options.agentCommands) ? options.agentCommands : [];
    const swimlanes = buildSwimlanes(agentCommands);
    const allCards = list.map((task) => toCard(task, agentCommands));

    const byLane = {};
    for (const lane of LANE_ORDER) byLane[lane] = 0;
    const bySwimlane = {};
    for (const lane of swimlanes) bySwimlane[lane.id] = 0;
    let unmapped = 0;

    for (const card of allCards) {
      if (card.lane && Object.prototype.hasOwnProperty.call(byLane, card.lane)) byLane[card.lane] += 1;
      else unmapped += 1;
      if (Object.prototype.hasOwnProperty.call(bySwimlane, card.swimlane)) bySwimlane[card.swimlane] += 1;
    }

    const limit = Number.isFinite(Number(options.limit)) && Number(options.limit) > 0
      ? Math.floor(Number(options.limit))
      : allCards.length;

    return {
      lanes: LANE_ORDER.map((id) => ({
        id,
        title: LANE_MAP[id].title,
        terminal: LANE_MAP[id].terminal,
        statuses: LANE_MAP[id].statuses.slice(),
        count: byLane[id],
      })),
      swimlanes: swimlanes.map((lane) => ({ ...lane, count: bySwimlane[lane.id] || 0 })),
      cards: allCards.slice(0, limit),
      counts: { byLane, bySwimlane, unmapped },
      total: allCards.length,
    };
  } catch {
    return empty;
  }
}

module.exports = {
  LANE_MAP,
  LANE_ORDER,
  STATUS_TO_LANE,
  CARD_ACTIONS,
  AGENT_TITLES,
  SYSTEM_SOURCES,
  FALLBACK_SWIMLANE,
  laneForStatus,
  cardActions,
  buildSwimlanes,
  swimlaneForSource,
  deriveTitle,
  toCard,
  buildBoard,
};
