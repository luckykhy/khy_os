import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  BREAKPOINTS,
  LANE_ORDER,
  STATUS_TONE,
  actionLabel,
  cardsAt,
  cardsOfSwimlane,
  emptyMessage,
  formatRelative,
  isActionable,
  laneTabs,
  normalizeBoard,
  normalizeCard,
  resolveBreakpoint,
  statusTone,
  summarize,
  visibleSwimlanes,
} from '../src/board/index.js';

/** 造一个贴近后端真实返回的载荷。 */
function makePayload(overrides = {}) {
  return {
    total: 4,
    generated_at: '2026-09-20T14:00:00.000Z',
    lanes: [
      { id: 'backlog', title: '待办/排队', terminal: 'none', statuses: ['queued'], count: 1 },
      { id: 'active', title: '执行中', terminal: 'none', statuses: ['running'], count: 1 },
      { id: 'paused', title: '已暂停', terminal: 'none', statuses: ['paused'], count: 1 },
      { id: 'done', title: '已完成', terminal: 'all', statuses: ['succeeded'], count: 1 },
      { id: 'failed', title: '失败/死信', terminal: 'all', statuses: ['failed'], count: 0 },
      { id: 'closed', title: '已取消', terminal: 'mixed', statuses: ['cancelling', 'cancelled'], count: 0 },
    ],
    swimlanes: [
      { id: 'claude', title: 'Claude Code', kind: 'agent', source: 'claude', count: 2 },
      { id: 'codex', title: 'Codex', kind: 'agent', source: 'codex', count: 1 },
      { id: '_unassigned', title: '未归属', kind: 'system', source: '__unassigned__', count: 1 },
    ],
    cards: [
      { id: 'a1', status: 'running', lane: 'active', swimlane: 'claude', title: '跑起来', progress_pct: 42, attempt_count: 2, max_attempts: 3, actions: { pause: true, resume: false, cancel: true }, updated_at: '2026-09-20T13:59:00.000Z' },
      { id: 'a2', status: 'queued', lane: 'backlog', swimlane: 'claude', title: '排队中', progress_pct: 0, actions: { pause: false, resume: false, cancel: true } },
      { id: 'a3', status: 'succeeded', lane: 'done', swimlane: 'codex', title: '已完成', progress_pct: 100, actions: { pause: false, resume: false, cancel: false } },
      { id: 'a4', status: 'paused', lane: 'paused', swimlane: '_unassigned', title: '被暂停', progress_pct: 12, actions: { pause: false, resume: true, cancel: true } },
    ],
    counts: { byLane: {}, bySwimlane: {}, unmapped: 0 },
    ...overrides,
  };
}

test('normalizeBoard 在完整载荷上保持结构并重算计数', () => {
  const board = normalizeBoard(makePayload());
  assert.equal(board.lanes.length, 6);
  assert.deepEqual(board.lanes.map((l) => l.id), [...LANE_ORDER]);
  assert.equal(board.cards.length, 4);
  assert.equal(board.total, 4);
  assert.equal(board.unmapped, 0);
  // 计数以实际卡片为准
  assert.equal(board.lanes.find((l) => l.id === 'active').count, 1);
  assert.equal(board.swimlanes.find((s) => s.id === 'claude').count, 2);
  assert.equal(board.generatedAt, '2026-09-20T14:00:00.000Z');
});

test('normalizeBoard 对残缺/垃圾输入绝不抛，且给出可渲染骨架', () => {
  for (const bad of [undefined, null, 0, 'nope', [], { lanes: 'x', cards: 'y' }, { cards: [null, {}, { id: '' }] }]) {
    const board = normalizeBoard(bad);
    assert.ok(Array.isArray(board.lanes));
    assert.equal(board.lanes.length, LANE_ORDER.length, '缺 lanes 时用 6 列降级骨架');
    assert.ok(Array.isArray(board.swimlanes));
    assert.ok(Array.isArray(board.cards));
    assert.equal(typeof board.total, 'number');
    assert.equal(typeof board.unmapped, 'number');
  }
  // id 缺失的卡片被丢弃（点不动）
  assert.equal(normalizeBoard({ cards: [{ status: 'running' }, { id: 'ok' }] }).cards.length, 1);
});

test('normalizeBoard 的关键不变量：卡片的 swimlane 必定存在于 swimlanes 中（不丢卡）', () => {
  const board = normalizeBoard(
    makePayload({
      swimlanes: [{ id: 'claude', title: 'Claude Code', kind: 'agent', count: 1 }],
    })
  );
  const ids = new Set(board.swimlanes.map((s) => s.id));
  for (const card of board.cards) {
    assert.ok(ids.has(card.swimlane), `卡片 ${card.id} 的泳道 ${card.swimlane} 未出现在 swimlanes`);
  }
  // 合成的泳道被追加进来
  assert.ok(ids.has('codex'));
  assert.ok(ids.has('_unassigned'));
});

test('unmapped 取「本地实算」与「后端报告」的较大值（宁可多报不掩盖）', () => {
  const board = normalizeBoard(
    makePayload({
      cards: [{ id: 'x', status: 'bogus', lane: null, swimlane: 'claude' }],
      counts: { unmapped: 7 },
    })
  );
  assert.equal(board.unmapped, 7);
  const board2 = normalizeBoard(
    makePayload({ cards: [{ id: 'x', status: 'bogus', lane: null, swimlane: 'claude' }], counts: { unmapped: 0 } })
  );
  assert.equal(board2.unmapped, 1);
});

test('normalizeCard 做字段钳制与默认值', () => {
  const card = normalizeCard({ id: ' c1 ', status: 'running', progress_pct: 155, attempt_count: '3', actions: { pause: 'yes' } });
  assert.equal(card.id, 'c1');
  assert.equal(card.progressPct, 100, '超过 100 被钳制');
  assert.equal(card.attemptCount, 3);
  assert.equal(card.title, 'c1', '无标题时回退到 id');
  assert.equal(card.actions.pause, false, '非严格 true 一律视为 false（fail-closed）');
  assert.equal(card.swimlane, '__unassigned__', '缺泳道时落兜底常量');
  assert.equal(normalizeCard({ id: 'x', progress_pct: -5 }).progressPct, 0);
  assert.equal(normalizeCard(null), null);
});

test('resolveBreakpoint 三档边界', () => {
  assert.equal(resolveBreakpoint(0), 'mobile');
  assert.equal(resolveBreakpoint(BREAKPOINTS.mobile - 1), 'mobile');
  assert.equal(resolveBreakpoint(BREAKPOINTS.mobile), 'tablet');
  assert.equal(resolveBreakpoint(BREAKPOINTS.tablet - 1), 'tablet');
  assert.equal(resolveBreakpoint(BREAKPOINTS.tablet), 'desktop');
  assert.equal(resolveBreakpoint(4096), 'desktop');
  assert.equal(resolveBreakpoint(undefined), 'desktop', '宽度未知时给全功能视图');
  assert.equal(resolveBreakpoint('abc'), 'desktop');
});

test('summarize 只统计可见卡片，并给出可操作数', () => {
  const board = normalizeBoard(makePayload());
  const s = summarize(board);
  assert.equal(s.total, 4);
  assert.equal(s.visible, 4);
  assert.equal(s.running, 1);
  assert.equal(s.paused, 1);
  assert.equal(s.done, 1);
  assert.equal(s.failed, 0);
  assert.equal(s.actionable, 3, 'a1/a2/a4 至少有一个可用动作');
});

test('visibleSwimlanes 默认隐藏空泳道，全空时回退为全部（不返回空数组）', () => {
  const board = normalizeBoard(makePayload());
  const shown = visibleSwimlanes(board);
  assert.deepEqual(shown.map((s) => s.id), ['claude', 'codex', '_unassigned']);
  assert.equal(visibleSwimlanes(board, { hideEmpty: false }).length, 3);

  const empty = normalizeBoard(makePayload({ cards: [] }));
  const fallback = visibleSwimlanes(empty);
  assert.ok(fallback.length > 0, '全空时仍返回泳道，好让调用方给出「确实没有任务」的提示');
});

test('cardsAt / cardsOfSwimlane 定位准确，且后者按列顺序排序', () => {
  const board = normalizeBoard(makePayload());
  assert.deepEqual(cardsAt(board, 'claude', 'active').map((c) => c.id), ['a1']);
  assert.deepEqual(cardsAt(board, 'claude', 'done'), []);
  assert.deepEqual(cardsOfSwimlane(board, 'claude').map((c) => c.id), ['a2', 'a1'], 'backlog 先于 active');
});

test('laneTabs 给出切换器模型与默认选中列', () => {
  const board = normalizeBoard(makePayload());
  const t = laneTabs(board, 'active');
  assert.equal(t.active, 'active');
  assert.equal(t.tabs.length, 6);
  assert.equal(t.tabs.find((x) => x.id === 'active').active, true);
  // 未指定时默认首列
  assert.equal(laneTabs(board, null).active, LANE_ORDER[0]);
});

test('isActionable 与 actionLabel 是唯一门控/文案入口', () => {
  const card = normalizeCard({ id: 'x', status: 'running', actions: { pause: true, cancel: true } });
  assert.equal(isActionable(card, 'pause'), true);
  assert.equal(isActionable(card, 'resume'), false);
  assert.equal(isActionable(null, 'pause'), false);
  assert.equal(isActionable({}, 'pause'), false);
  assert.equal(actionLabel('pause'), '暂停');
  assert.equal(actionLabel('resume'), '恢复');
  assert.equal(actionLabel('cancel'), '取消');
  assert.equal(actionLabel('unknown'), 'unknown');
});

test('formatRelative 覆盖各时间尺度，非法输入返回空串', () => {
  const now = Date.parse('2026-09-20T14:00:00.000Z');
  assert.equal(formatRelative('2026-09-20T13:59:30.000Z', now), '刚刚');
  assert.equal(formatRelative('2026-09-20T13:30:00.000Z', now), '30 分钟前');
  assert.equal(formatRelative('2026-09-20T11:00:00.000Z', now), '3 小时前');
  assert.equal(formatRelative('2026-09-18T14:00:00.000Z', now), '2 天前');
  assert.equal(formatRelative('2026-08-01T14:00:00.000Z', now), '1 个月前');
  assert.equal(formatRelative('2024-01-01T00:00:00.000Z', now), '2 年前');
  assert.equal(formatRelative(''), '');
  assert.equal(formatRelative(null), '');
  assert.equal(formatRelative('not-a-date'), '');
  assert.equal(formatRelative('2026-09-20T15:00:00.000Z', now), '刚刚', '未来时间不显示负数');
});

test('emptyMessage 区分「没有任务」与「有总数但卡片为空」', () => {
  assert.equal(emptyMessage({ total: 0, cards: [] }), '当前没有大型任务。');
  assert.match(emptyMessage({ total: 9, cards: [] }), /分页或过滤条件/);
});

// ── 状态知识单表化（STATUS_TONE）────────────────────────────────────────────
// 前端**只允许**在 STATUS_TONE 里认识状态。本组测试锁住这张表，
// 并阻止状态知识再次散落到 summarize() 或 CSS 选择器里。

test('STATUS_TONE 恰好覆盖后端 11 态，且色调取值封闭', () => {
  const expected = {
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
  };
  assert.deepEqual({ ...STATUS_TONE }, expected);
  const allowed = new Set(['neutral', 'running', 'warn', 'ok', 'error']);
  for (const [status, tone] of Object.entries(STATUS_TONE)) {
    assert.ok(allowed.has(tone), `${status} 的色调 ${tone} 不在封闭集合内`);
  }
});

test('statusTone 对未知/非法输入 fail-soft 回退 neutral', () => {
  assert.equal(statusTone('running'), 'running');
  assert.equal(statusTone('dead_letter'), 'error');
  assert.equal(statusTone('no_such_status'), 'neutral');
  assert.equal(statusTone(''), 'neutral');
  assert.equal(statusTone(null), 'neutral');
  assert.equal(statusTone(undefined), 'neutral');
  assert.equal(statusTone(42), 'neutral');
});

test('summarize 的四个语义桶全部由 statusTone 派生（不在别处再写状态字面量）', () => {
  const board = normalizeBoard({
    cards: [
      { id: 'a', status: 'running', lane: 'active', swimlane: 'claude' },
      { id: 'b', status: 'pausing', lane: 'paused', swimlane: 'claude' },
      { id: 'c', status: 'paused', lane: 'paused', swimlane: 'claude' },
      { id: 'd', status: 'dead_letter', lane: 'failed', swimlane: 'claude' },
      { id: 'e', status: 'failed', lane: 'failed', swimlane: 'claude' },
      { id: 'f', status: 'succeeded', lane: 'done', swimlane: 'claude' },
      { id: 'g', status: 'cancelled', lane: 'closed', swimlane: 'claude' },
    ],
  });
  const s = summarize(board);
  assert.equal(s.running, 1, 'running 桶 = tone running');
  assert.equal(s.paused, 2, 'pausing 与 paused 同属 warn 桶');
  assert.equal(s.failed, 2, 'failed 与 dead_letter 同属 error 桶');
  assert.equal(s.done, 1);
  // cancelled 落 neutral ⇒ 不计入任何语义桶，但仍计入 visible
  assert.equal(s.visible, 7);
});

test('组件与样式表不得重新散落状态知识（只认 data-tone，不认 data-status）', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const cardSrc = readFileSync(join(here, '..', 'src', 'board', 'TaskCard.vue'), 'utf8');
  assert.match(cardSrc, /:data-tone="tone"/, 'TaskCard 必须按色调着色');
  assert.doesNotMatch(cardSrc, /:data-status=/, '不得回退到按原始状态着色（那是第二份状态表）');
  assert.doesNotMatch(
    cardSrc,
    /\[data-(?:tone|status)='(?:queued|claimed|retry_wait|pausing|paused|cancelling|succeeded|failed|dead_letter)'\]/,
    'CSS 不得按具体状态名选择器着色'
  );

  const modelSrc = readFileSync(join(here, '..', 'src', 'board', 'model.js'), 'utf8');
  // 先剔除 STATUS_TONE 本体（它就是允许出现状态名的地方）
  const toneStart = modelSrc.indexOf('export const STATUS_TONE');
  const toneEnd = modelSrc.indexOf('export function statusTone');
  let outside = modelSrc.slice(0, toneStart) + modelSrc.slice(toneEnd);
  // 再剔除列 id 声明 —— ⚠ 列 id 与状态名**同形**（LANE_ORDER 里有 'paused'/'failed'），
  //   它们是列名不是状态名，不剔掉就会误报。
  outside = outside
    .replace(/export const LANE_ORDER = Object\.freeze\(\[[^\]]*\]\);/, '')
    .replace(/export const LANE_TITLES = Object\.freeze\(\{[\s\S]*?\}\);/, '');
  const literals = [...outside.matchAll(/'((?:queued|claimed|retry_wait|running|pausing|paused|cancelling|cancelled|succeeded|failed|dead_letter))'/g)]
    .map((m) => m[1]);
  assert.deepEqual(literals, [], `状态字面量散落在 STATUS_TONE 之外：${literals.join(', ')}`);
});
