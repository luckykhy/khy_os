'use strict';

/**
 * `largeTaskBoard` 纯叶子模块的契约测试。
 *
 * 本文件的核心价值不是「跑通」，而是把三张表**钉在真源上**：
 *   1. 「11 态 → 6 列」折叠表 ↔ `largeTaskRuntimeStore.TASK_STATUSES` / `TERMINAL_STATUSES`
 *   2. 卡片动作门控表 ↔ `STATUS_TRANSITIONS` 可达性 + `taskControlService` 的准入分支
 *   3. 泳道表 ↔ `agentLauncherRegistry.AGENT_LAUNCHERS` 的 command 集合
 *
 * 任何一张表与真源漂移，这里必须红。这是方案 [DESIGN-ARCH-126] §六 F1/F2/F3/F5/F8 的自动化判据。
 */

const board = require('../../src/tasks/largeTaskBoard');
const runtime = require('../../src/tasks/largeTaskRuntimeStore');
const launchers = require('../../src/services/agentLauncherRegistry');

const { LANE_MAP, LANE_ORDER, STATUS_TO_LANE, CARD_ACTIONS } = board;
const STATUSES = runtime.TASK_STATUSES;
const TERMINAL = runtime.TERMINAL_STATUSES;
const TRANSITIONS = runtime.STATUS_TRANSITIONS;
const canTransition = runtime.canTransition;

const AGENT_COMMANDS = launchers.getLauncherCommands();

describe('largeTaskBoard / 列（lane）折叠表', () => {
  it('11 个状态被 6 列恰好划分一次（完备且不重叠）', () => {
    const seen = [];
    for (const lane of LANE_ORDER) {
      for (const status of LANE_MAP[lane].statuses) seen.push(status);
    }
    // 每个状态恰好出现一次
    expect(seen.slice().sort()).toEqual(STATUSES.slice().sort());
    expect(new Set(seen).size).toBe(seen.length);
    // STATUS_TO_LANE 与 LANE_MAP 双向一致
    for (const lane of LANE_ORDER) {
      for (const status of LANE_MAP[lane].statuses) {
        expect(STATUS_TO_LANE[status]).toBe(lane);
      }
    }
    expect(Object.keys(STATUS_TO_LANE).length).toBe(STATUSES.length);
  });

  it('每列的 terminal 声明与 TERMINAL_STATUSES 真源一致（all/none/mixed 三态无含糊）', () => {
    for (const lane of LANE_ORDER) {
      const spec = LANE_MAP[lane];
      const terminalCount = spec.statuses.filter((s) => TERMINAL.has(s)).length;
      let expected;
      if (terminalCount === 0) expected = 'none';
      else if (terminalCount === spec.statuses.length) expected = 'all';
      else expected = 'mixed';
      expect(`${lane}:${spec.terminal}`).toBe(`${lane}:${expected}`);
    }
  });

  it('未知状态不落任何列（laneForStatus 返回 null，由 counts.unmapped 暴露而非静默归列）', () => {
    expect(board.laneForStatus('no_such_status')).toBeNull();
    expect(board.laneForStatus('')).toBeNull();
    expect(board.laneForStatus(undefined)).toBeNull();
    expect(board.laneForStatus(null)).toBeNull();
  });
});

describe('largeTaskBoard / 卡片动作门控（F5）', () => {
  it('门控表覆盖全部状态且无多余键', () => {
    expect(Object.keys(CARD_ACTIONS).slice().sort()).toEqual(STATUSES.slice().sort());
  });

  it('终态四态三个动作全 false', () => {
    for (const status of STATUSES) {
      if (!TERMINAL.has(status)) continue;
      expect({ status, ...board.cardActions(status) }).toEqual({
        status,
        pause: false,
        resume: false,
        cancel: false,
      });
    }
  });

  it('pause=true 当且仅当后端会真正进入暂停流程（可迁入 pausing，且当前不在 pausing）', () => {
    for (const status of STATUSES) {
      const allowed = board.cardActions(status).pause;
      // ⚠ canTransition 对自迁移（from === to）返回 true ⇒ 必须显式排除「已在 pausing」这一退化情形，
      //   否则会误判为「可暂停」。真源 _pauseTask 要求 status === 'running' 才真正执行。
      const reachable = status !== 'pausing' && canTransition(status, 'pausing');
      expect(`pause ${status}=${allowed}`).toBe(`pause ${status}=${reachable}`);
    }
  });

  it('cancel=true 当且仅当非终态且非 cancelling（cancelling 为刻意的 UI 隐藏）', () => {
    for (const status of STATUSES) {
      const allowed = board.cardActions(status).cancel;
      const expected = !TERMINAL.has(status) && status !== 'cancelling';
      expect(`cancel ${status}=${allowed}`).toBe(`cancel ${status}=${expected}`);
      // 且凡允许取消的状态，其取消路径必须真的合法
      if (allowed) {
        expect(canTransition(status, 'cancelling') || canTransition(status, 'cancelled')).toBe(true);
      }
    }
  });

  it('resume=true 当且仅当 paused / pausing，且该路径在状态机里真的走得通', () => {
    const RESUMABLE = ['paused', 'pausing'];
    for (const status of STATUSES) {
      const allowed = board.cardActions(status).resume;
      expect(`resume ${status}=${allowed}`).toBe(`resume ${status}=${RESUMABLE.includes(status)}`);
    }
    // 路径可达性：paused → running；pausing → paused → running
    expect(canTransition('paused', 'running')).toBe(true);
    expect(canTransition('pausing', 'paused')).toBe(true);
    expect(canTransition('paused', 'running')).toBe(true);
  });

  it('未登记状态 fail-closed（一律不可操作）', () => {
    expect(board.cardActions('no_such_status')).toEqual({ pause: false, resume: false, cancel: false });
    expect(board.cardActions(undefined)).toEqual({ pause: false, resume: false, cancel: false });
  });

  it('终态在状态机里确实无出边（门控全 false 的真源依据）', () => {
    for (const status of STATUSES) {
      if (!TERMINAL.has(status)) continue;
      expect([...(TRANSITIONS[status] || [])]).toEqual([]);
    }
  });
});

describe('largeTaskBoard / 泳道（swimlane）', () => {
  it('泳道表 = 执行体注册表 ∪ 平台 source ∪ 兜底，且 id 唯一', () => {
    const lanes = board.buildSwimlanes(AGENT_COMMANDS);
    const ids = lanes.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
    // 兜底泳道恰好一个，且在最后
    const fallbacks = lanes.filter((l) => l.id === board.FALLBACK_SWIMLANE.id);
    expect(fallbacks).toHaveLength(1);
    expect(ids[ids.length - 1]).toBe(board.FALLBACK_SWIMLANE.id);
  });

  it('kind=agent 的泳道与执行体注册表双向一致（无幽灵、无遗漏）', () => {
    const lanes = board.buildSwimlanes(AGENT_COMMANDS);
    const agentLanes = lanes.filter((l) => l.kind === 'agent').map((l) => l.id);
    expect(agentLanes.slice().sort()).toEqual(AGENT_COMMANDS.slice().sort());
    // 反向：注册表里每个 command 都必须有泳道
    for (const command of AGENT_COMMANDS) {
      expect(agentLanes).toContain(command);
    }
  });

  it('kind=system 的泳道要么是已登记平台 source，要么是兜底', () => {
    const lanes = board.buildSwimlanes(AGENT_COMMANDS);
    for (const lane of lanes.filter((l) => l.kind === 'system')) {
      const known = board.SYSTEM_SOURCES.includes(lane.id) || lane.id === board.FALLBACK_SWIMLANE.id;
      expect(`${lane.id}:${known}`).toBe(`${lane.id}:true`);
    }
  });

  it('未登记 / 空 / 非字符串 source 一律落兜底泳道，绝不返回 null（F8）', () => {
    expect(board.swimlaneForSource('ghost_agent', AGENT_COMMANDS)).toBe(board.FALLBACK_SWIMLANE.id);
    expect(board.swimlaneForSource('', AGENT_COMMANDS)).toBe(board.FALLBACK_SWIMLANE.id);
    expect(board.swimlaneForSource(null, AGENT_COMMANDS)).toBe(board.FALLBACK_SWIMLANE.id);
    expect(board.swimlaneForSource(42, AGENT_COMMANDS)).toBe(board.FALLBACK_SWIMLANE.id);
    expect(board.swimlaneForSource(undefined, AGENT_COMMANDS)).toBe(board.FALLBACK_SWIMLANE.id);
    // 已登记的则原样返回
    expect(board.swimlaneForSource('claude', AGENT_COMMANDS)).toBe('claude');
    expect(board.swimlaneForSource('background_task_manager', AGENT_COMMANDS)).toBe(
      'background_task_manager'
    );
  });

  it('空注册表时兜底泳道依然存在（不因注册表为空而丢单）', () => {
    const lanes = board.buildSwimlanes([]);
    expect(lanes.map((l) => l.id)).toContain(board.FALLBACK_SWIMLANE.id);
    expect(board.swimlaneForSource('claude', [])).toBe(board.FALLBACK_SWIMLANE.id);
  });
});

describe('largeTaskBoard / 卡片标题派生', () => {
  it('payload_json.title 优先，且做 trim', () => {
    expect(board.deriveTitle({ id: 'x', type: 'generic', payload_json: { title: '  真标题  ' } })).toBe('真标题');
  });

  it('无标题时回退 `<type> <短哈希>`，且同 id 必得同值（确定性）', () => {
    const a = board.deriveTitle({ id: 'stable-id', type: 'generic', payload_json: {} });
    const b = board.deriveTitle({ id: 'stable-id', type: 'generic', payload_json: {} });
    expect(a).toBe(b);
    expect(a).toMatch(/^generic [0-9a-f]{4}$/);
  });

  it('短哈希在常见 id 形态上不碰撞（取低位而非高位）', () => {
    const ids = [
      't1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9', 't10',
      'bg_1', 'bg_2', 'bg_3', 'bg_4', 'bg_5',
      'large-task-abc-1', 'large-task-abc-2', 'large-task-abc-3',
    ];
    const titles = ids.map((id) => board.deriveTitle({ id, type: 'generic', payload_json: {} }));
    expect(new Set(titles).size).toBe(ids.length);
  });

  it('不回退成 id 全串（避免长内部 id 顶到列头）', () => {
    const id = 'a-very-long-internal-task-identifier-0123456789abcdef';
    const title = board.deriveTitle({ id, type: 'generic', payload_json: {} });
    expect(title).not.toBe(id);
    expect(title.includes(id)).toBe(false);
  });
});

describe('largeTaskBoard / buildBoard 聚合', () => {
  const tasks = [
    { id: 't1', type: 'generic', status: 'running', payload_json: { source: 'claude' }, progress_pct: 40, attempt_count: 2, max_attempts: 3, updated_at: 'u1', created_at: 'c1' },
    { id: 't2', type: 'generic', status: 'succeeded', payload_json: { source: 'claude', title: '修看板' }, progress_pct: 100, attempt_count: 1 },
    { id: 't3', type: 'generic', status: 'dead_letter', payload_json: { source: 'ghost_agent' } },
    { id: 't4', type: 'generic', status: 'paused', payload_json: {} },
    { id: 't5', type: 'generic', status: 'bogus_state', payload_json: { source: 'codex' } },
    { id: 't6', type: 'generic', status: 'cancelling', payload_json: { source: 'background_task_manager' } },
  ];

  it('计数自洽：byLane 之和 + unmapped === total', () => {
    const r = board.buildBoard(tasks, { agentCommands: AGENT_COMMANDS });
    const laneSum = Object.values(r.counts.byLane).reduce((a, b) => a + b, 0);
    expect(laneSum + r.counts.unmapped).toBe(r.total);
    expect(r.total).toBe(tasks.length);
  });

  it('未知状态落 lane=null 并计入 unmapped（不静默归列）', () => {
    const r = board.buildBoard(tasks, { agentCommands: AGENT_COMMANDS });
    const card = r.cards.find((c) => c.id === 't5');
    expect(card.lane).toBeNull();
    expect(r.counts.unmapped).toBe(1);
  });

  it('未登记 source 落兜底泳道并计入 bySwimlane', () => {
    const r = board.buildBoard(tasks, { agentCommands: AGENT_COMMANDS });
    expect(r.cards.find((c) => c.id === 't3').swimlane).toBe(board.FALLBACK_SWIMLANE.id);
    expect(r.cards.find((c) => c.id === 't4').swimlane).toBe(board.FALLBACK_SWIMLANE.id);
    const swimSum = Object.values(r.counts.bySwimlane).reduce((a, b) => a + b, 0);
    expect(swimSum).toBe(tasks.length);
  });

  it('cards 字段齐备且类型稳定（前端不再做兜底）', () => {
    const r = board.buildBoard(tasks, { agentCommands: AGENT_COMMANDS });
    for (const card of r.cards) {
      for (const key of ['id', 'status', 'lane', 'swimlane', 'type', 'source', 'title', 'progress_pct', 'attempt_count', 'max_attempts', 'updated_at', 'created_at', 'worktree', 'no_worktree_reason', 'actions']) {
        expect(Object.prototype.hasOwnProperty.call(card, key)).toBe(true);
      }
      expect(typeof card.id).toBe('string');
      expect(typeof card.progress_pct).toBe('number');
      expect(typeof card.attempt_count).toBe('number');
      expect(typeof card.actions).toBe('object');
    }
  });

  it('limit 只截断 cards，counts 仍覆盖全量', () => {
    const r = board.buildBoard(tasks, { agentCommands: AGENT_COMMANDS, limit: 2 });
    expect(r.cards).toHaveLength(2);
    expect(r.total).toBe(tasks.length);
    const laneSum = Object.values(r.counts.byLane).reduce((a, b) => a + b, 0);
    expect(laneSum + r.counts.unmapped).toBe(tasks.length);
  });

  it('lanes 段与 LANE_ORDER 同序，swimlanes 段含 count', () => {
    const r = board.buildBoard(tasks, { agentCommands: AGENT_COMMANDS });
    expect(r.lanes.map((l) => l.id)).toEqual([...LANE_ORDER]);
    for (const lane of r.swimlanes) expect(typeof lane.count).toBe('number');
  });

  it('worktree 恒为 null（F4 的真实出处：payload_json.worktree，当前零写入方）', () => {
    const r = board.buildBoard(tasks, { agentCommands: AGENT_COMMANDS });
    for (const card of r.cards) {
      expect(card.worktree).toBeNull();
      expect(card.no_worktree_reason).toBeNull();
    }
    // 若未来有人真的写了 payload_json.worktree，本断言会红 —— 那时应改 F4 的判据
    const withWorktree = board.buildBoard(
      [{ id: 'w1', type: 'generic', status: 'running', payload_json: { source: 'claude', worktree: 'wt-1' } }],
      { agentCommands: AGENT_COMMANDS }
    );
    expect(withWorktree.cards[0].worktree).toBe('wt-1');
  });

  it('空 / null / 垃圾输入不抛，且返回结构完整', () => {
    for (const input of [null, undefined, [], 'nope', 42, {}, [null], [{}, { id: '' }], [{ id: 'ok', status: 'running' }]]) {
      const r = board.buildBoard(input, { agentCommands: AGENT_COMMANDS });
      expect(Array.isArray(r.lanes)).toBe(true);
      expect(r.lanes).toHaveLength(LANE_ORDER.length);
      expect(Array.isArray(r.swimlanes)).toBe(true);
      expect(Array.isArray(r.cards)).toBe(true);
      expect(typeof r.total).toBe('number');
      expect(r.counts).toBeTruthy();
    }
  });

  it('无 options 时（agentCommands 缺失）执行体 source 落兜底，平台 source 仍被识别', () => {
    const r = board.buildBoard(tasks);
    expect(r.swimlanes.map((l) => l.id)).toContain(board.FALLBACK_SWIMLANE.id);
    // 执行体来源（claude）在注册表缺失时无法解析 ⇒ 落兜底，不丢单
    expect(r.cards.find((c) => c.id === 't1').swimlane).toBe(board.FALLBACK_SWIMLANE.id);
    expect(r.cards.find((c) => c.id === 't2').swimlane).toBe(board.FALLBACK_SWIMLANE.id);
    // 平台 source 不依赖注册表，仍应被正确归类
    expect(r.cards.find((c) => c.id === 't6').swimlane).toBe('background_task_manager');
  });
});
