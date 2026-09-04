'use strict';

/**
 * turnPhaseTracker.js — 一次 AI 回合的阶段划分单一真源（纯叶子，零依赖）。
 *
 * 用户可读的阶段序列（与 AGENTS.md 规则 2「动作 + 目标 + 进度」对齐）：
 *
 *   等待输入 → 已接收输入 → 推理中 → 判断是否完成
 *        ├─ 有工具 → 执行工具 → 处理工具结果 ─┐
 *        │                                    └─ 未完成 → 回到推理（循环回边）
 *        └─ 无工具 → 校验 → 生成最终回复 → 已完成
 *
 * 数据来源（不发明新状态机，消费既有的影子 FSM + shell 状态）：
 *   - toolLoopPhases FSM 的每次转移（toolUseLoopCore 已逐事件 fire）经
 *     `onLoopEvent({from,to,event,iteration})` 喂进来；
 *   - shell 侧（REPL replPhases / TUI status）经 `noteShellPhase()` 喂进来，
 *     覆盖「等待输入 / 已接收输入」这两个循环体看不到的阶段。
 *
 * snapshot() 是 pure & total：无变化时返回同一个对象引用，React/Ink 消费方
 * 可以直接 setState 而不触发多余重渲染（与 TUI 渲染栅栏约定一致）。
 *
 * @module services/stateMachine/turnPhaseTracker
 */

/** 用户可读阶段枚举：code → 中文标签（面向用户，绝不给用户看 snake_case）。 */
const TURN_PHASES = Object.freeze({
  WAITING_INPUT:    { code: 'waiting_input',    label: '等待输入' },
  INPUT_RECEIVED:   { code: 'input_received',   label: '已接收输入' },
  REASONING:        { code: 'reasoning',        label: '推理中' },
  RESPONDING:       { code: 'responding',       label: '生成回复' },
  TOOL_EXECUTING:   { code: 'tool_executing',   label: '执行工具' },
  TOOL_RESULT:      { code: 'tool_result',      label: '处理工具结果' },
  COMPLETION_CHECK: { code: 'completion_check', label: '判断是否完成' },
  AWAITING_CHOICE:  { code: 'awaiting_choice',  label: '等待选择' },
  VISION_DELEGATING:{ code: 'vision_delegating', label: '视觉模型识图中' },
  RECOVERING:       { code: 'recovering',       label: '异常恢复' },
  HANDLING_ERROR:   { code: 'handling_error',   label: '处理错误' },
  VERIFYING:        { code: 'verifying',        label: '校验中' },
  FINALIZING:       { code: 'finalizing',       label: '生成最终回复' },
  DONE:             { code: 'done',             label: '已完成' },
  INTERRUPTED:      { code: 'interrupted',      label: '已中断' },
  UNKNOWN:          { code: 'unknown',          label: '运行中' },
});

// toolLoopPhases 状态 → 用户阶段（MIRRORS services/stateMachine/toolLoopPhases.js:TOOL_LOOP_PHASES）
const _LOOP_STATE_MAP = Object.freeze({
  init:              'waiting_input',    // 循环尚未起跑
  send_to_ai:        'reasoning',
  parse_ai_output:   'completion_check',
  execute_tools:     'tool_executing',
  process_results:   'tool_result',
  transient_recovery:'recovering',
  error_handling:    'handling_error',
  verify_gate:       'verifying',
  final_response:    'done',             // FINISH 的终态 = 已完成
  interrupted:       'interrupted',
});

// replPhases 状态 → 用户阶段（MIRRORS services/stateMachine/replPhases.js 状态表）
const _SHELL_STATE_MAP = Object.freeze({
  startup:        'waiting_input',
  ready:          'waiting_input',
  input_active:   'input_received',
  ai_responding:  'reasoning',
  streaming:      'responding',
  tool_execution: 'tool_executing',
  interrupted:    'interrupted',
});

// TUI 粗粒度 status → 用户阶段（MIRRORS cli/tui/hooks/useQueryBridge.js status 取值域）
const _TUI_STATUS_MAP = Object.freeze({
  idle:        'waiting_input',
  thinking:    'reasoning',
  streaming:   'responding',
  tool:        'tool_executing',
  compacting:  'verifying',
  local:       'reasoning',
  done:        'done',
  // 网关视觉代理（describe-and-return）经 status chunk.phase 注入：
  vision:      'vision_delegating',     // 识图模型接管图片 → 结果将回注当前模型
  'vision-done': 'reasoning',           // 识图完成，结果回注 → 当前模型继续推理
});

function _phaseOf(code) {
  return TURN_PHASES[String(code || '').toUpperCase()] || TURN_PHASES.UNKNOWN;
}

const TRAIL_CAP = 14;

/**
 * 创建一个回合阶段追踪器。
 * @param {object} [opts]
 * @param {number} [opts.maxIterations] - 上限轮次（显示「第 N/M 轮」用；可后置 setMaxIterations）
 * @returns {TurnPhaseTracker}
 */
function createTurnPhaseTracker(opts = {}) {
  let _maxIterations = Number(opts.maxIterations) > 0 ? Number(opts.maxIterations) : 0;
  let _phase = TURN_PHASES.WAITING_INPUT;
  let _iteration = 0;
  let _toolCalls = 0;
  let _toolResults = 0;
  let _loopBacks = 0;          // 「未完成 → 回到推理」次数
  let _retries = 0;            // 「异常恢复 → 重试」次数（event=retry）
  let _phaseBeforeFork = null; // 分叉前阶段（fork_clear 时恢复）
  let _startedAt = 0;
  let _updatedAt = 0;
  let _trail = [];             // [{ code, label, at, via? }]，封顶 TRAIL_CAP
  let _snap = null;            // 缓存的快照（pure & total）
  let _dirty = true;

  function _markDirty() {
    _dirty = true;
  }

  function _pushTrail(phase, at, via) {
    const entry = Object.freeze(
      via ? { code: phase.code, label: phase.label, at, via } : { code: phase.code, label: phase.label, at }
    );
    _trail = _trail.length >= TRAIL_CAP
      ? [..._trail.slice(_trail.length - TRAIL_CAP + 1), entry]
      : [..._trail, entry];
  }

  function _setPhase(phase, at, via) {
    if (phase === _phase) return;
    _phase = phase;
    _updatedAt = at;
    _pushTrail(phase, at, via);
    _markDirty();
  }

  const tracker = {
    /**
     * 消费 toolLoopPhases 的一次 FSM 转移，或一个分叉事件。
     *
     * FSM 转移：{ from, to, event, iteration, at }
     * 分叉事件：{ kind:'fork', fork:'ask_user'|'permission'|'plan_review', at }
     *           { kind:'fork_clear', at }
     *
     * 错误回跳语义（用户问的「遇到错误进入哪个步骤」）：
     *   - event='error'  → 处理错误（error_handling）
     *   - event='retry'  → 异常恢复（transient_recovery），计一次重试，
     *                      恢复后回 send_to_ai =「回到推理」（trail 里可见
     *                      执行工具 --error/retry--> 处理错误/异常恢复 --> 推理中 的完整链）
     *   - event='finish' → 已完成（含计划审批收口 planExit）
     *
     * @param {{ from?: string, to?: string, event?: string, iteration?: number,
     *           kind?: string, fork?: string, at?: number }} e
     */
    onLoopEvent(e) {
      if (!e || typeof e !== 'object') return;
      const at = Number(e.at) > 0 ? Number(e.at) : Date.now();
      if (_startedAt === 0) _startedAt = at;

      // 分叉：进入「等待选择」，记住分叉前阶段；清除时恢复。
      if (e.kind === 'fork') {
        if (_phase !== TURN_PHASES.AWAITING_CHOICE) {
          _phaseBeforeFork = _phase;
        }
        _setPhase(TURN_PHASES.AWAITING_CHOICE, at, `fork:${e.fork || 'unknown'}`);
        _markDirty();
        return;
      }
      if (e.kind === 'fork_clear') {
        const resume = _phaseBeforeFork || TURN_PHASES.TOOL_EXECUTING;
        _phaseBeforeFork = null;
        _setPhase(resume, at, 'fork_clear');
        _markDirty();
        return;
      }

      if (Number(e.iteration) > 0) _iteration = Number(e.iteration);
      // 主回边：process_results --send--> send_to_ai =「未完成，回到推理」
      if (e.event === 'send' && e.from === 'process_results') {
        _loopBacks += 1;
      }
      // 错误回跳计数：进入恢复流程 = 将带着同一输入回到推理。
      if (e.event === 'retry') {
        _retries += 1;
      }
      const next = _LOOP_STATE_MAP[e.to] || null;
      if (next) _setPhase(_phaseOf(next), at, e.event || undefined);
      _markDirty();
    },

    /**
     * 消费 shell 侧阶段（REPL replPhases 状态名 或 TUI status 粗粒度值）。
     * 两个来源的取值域不同，按已知表各试一次，都不认识就忽略。
     * @param {string} state
     */
    noteShellPhase(state) {
      const key = String(state || '');
      const mapped = _SHELL_STATE_MAP[key] || _TUI_STATUS_MAP[key] || null;
      if (!mapped) return;
      const at = Date.now();
      if (_startedAt === 0) _startedAt = at;
      _setPhase(_phaseOf(mapped), at);
    },

    /** 工具起飞（消费方在 onToolCall 包装里调）。 */
    noteToolStart() {
      _toolCalls += 1;
      _markDirty();
    },

    /** 工具结果（消费方在 onToolResult 包装里调）。 */
    noteToolResult() {
      _toolResults += 1;
      _markDirty();
    },

    /** 每轮迭代开始（消费方在 onIteration 包装里调）。 */
    noteIteration(iteration, maxIterations) {
      if (Number(iteration) > 0) _iteration = Number(iteration);
      if (Number(maxIterations) > 0) _maxIterations = Number(maxIterations);
      _markDirty();
    },

    setMaxIterations(n) {
      if (Number(n) > 0) {
        _maxIterations = Number(n);
        _markDirty();
      }
    },

    /** 新回合重置（保留 maxIterations）。 */
    reset() {
      _phase = TURN_PHASES.WAITING_INPUT;
      _iteration = 0;
      _toolCalls = 0;
      _toolResults = 0;
      _loopBacks = 0;
      _retries = 0;
      _phaseBeforeFork = null;
      _startedAt = 0;
      _updatedAt = 0;
      _trail = [];
      _markDirty();
    },

    /**
     * 当前回合阶段快照（pure & total：无变化时返回同一引用）。
     * @returns {{
     *   phase: string, label: string, iteration: number, maxIterations: number,
     *   toolCalls: number, toolResults: number, loopBacks: number, retries: number,
     *   startedAt: number, updatedAt: number,
     *   trail: ReadonlyArray<{code:string,label:string,at:number,via?:string}>
     * }}
     */
    snapshot() {
      if (!_dirty && _snap) return _snap;
      _snap = Object.freeze({
        phase: _phase.code,
        label: _phase.label,
        iteration: _iteration,
        maxIterations: _maxIterations,
        toolCalls: _toolCalls,
        toolResults: _toolResults,
        loopBacks: _loopBacks,
        retries: _retries,
        startedAt: _startedAt,
        updatedAt: _updatedAt,
        trail: _trail,
      });
      _dirty = false;
      return _snap;
    },

    /** 一行人话：「第 2/8 轮 · 推理中 · 已执行 3 个工具 · 1 次回到推理 · 重试 2 次」。 */
    formatLine() {
      const parts = [];
      if (_iteration > 0) {
        parts.push(_maxIterations > 0 ? `第 ${_iteration}/${_maxIterations} 轮` : `第 ${_iteration} 轮`);
      }
      parts.push(_phase.label);
      if (_toolCalls > 0) parts.push(`已执行 ${_toolCalls} 个工具`);
      if (_loopBacks > 0) parts.push(`${_loopBacks} 次回到推理`);
      if (_retries > 0) parts.push(`重试 ${_retries} 次`);
      return parts.join(' · ');
    },
  };

  return tracker;
}

module.exports = {
  TURN_PHASES,
  createTurnPhaseTracker,
  _internals: { _LOOP_STATE_MAP, _SHELL_STATE_MAP, _TUI_STATUS_MAP },
};