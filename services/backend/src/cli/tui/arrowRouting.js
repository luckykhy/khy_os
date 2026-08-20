'use strict';

/**
 * arrowRouting — 方向键归属的单一真源(纯叶子:零 IO、零 env、确定性、绝不抛)。
 *
 * 背景(参照实现:Claude Code keybindings 注册表)。CC 不用 ad-hoc 条件判断方向键该
 * 归谁,而是维护一个 **context 栈**:同一个 ↑ 在不同 context 下解析成不同**动作名**,
 * 由栈顶 context 独占。CC 注册表原文(节选):
 *   {context:"Chat",         bindings:{ up:"history:previous", down:"history:next" }}
 *   {context:"Autocomplete", bindings:{ up:"autocomplete:previous", down:"autocomplete:next" }}
 *   {context:"Transcript",   bindings:{ up:"scroll:lineUp",  down:"scroll:lineDown" }}
 * 注意 Chat context 里 up/down 是**无条件**绑定的 —— 不看缓冲区是否为空、不看有没有
 * 换行。「缓冲区非空就吞掉竖直方向键」是 khy 独有的历史包袱,不是 CC 的设计。
 *
 * khy 的 App.js 块 4.7 其实**已经**是一个 context 栈,只是隐式写成一串有序 `if`,
 * 判定条件(`shellViewOpen` / `busy && empty` / `!busy && empty` / `!empty`)与动作实现
 * (`setShellScroll` / `query.dequeueLast` / `textInput.onInput`)缠在一起,读的人要把
 * 优先级从缩进里反推。本叶子把**判定**抽出来:输入交互状态,输出 CC 风格的动作名;
 * App.js 只剩「动作名 → 副作用」的 switch。优先级从此有唯一的、可单测的定义处。
 *
 * 动作名词表刻意与 CC 同构(`history:*` / `scroll:*` / `subview:*`),其中 `scroll:lineUp`
 * `scroll:lineDown` 与 scrollActions 叶子共用同一套裸名,调用方可直接喂给 applyScroll。
 *
 * **不含**的 context:`Transcript`(视图打开时在 App.js 更早的分支里独占全部输入,
 * 根本到不了块 4.7)、vim / plan / help(各自持有自己的按键处理,块 4.7 整体被跳过)、
 * completion(补全菜单自己的 useInput 更早消费)。这些都不是本叶子的判定范围。
 */

/** 交互 context 名(= 判定优先级顺序,栈顶在前)。 */
const CONTEXTS = Object.freeze(['shellView', 'executing', 'idle', 'editing']);

/** 本叶子可能返回的全部动作名(顺序无语义,仅供守卫/测试做全集校验)。 */
const ARROW_ACTIONS = Object.freeze([
  'history:previous', // ↑ 回溯上一条已提交的历史(草稿由 useTextInput 自行暂存)
  'history:next', // ↓ 走向更新的历史;走过最新一条时恢复草稿
  'scroll:lineUp', // 子视图上滚一行
  'scroll:lineDown', // 子视图下滚一行
  'subview:exit', // ← 退出当前子视图
  'subview:openShell', // ↓ 打开 shell 窥视面板
  'queue:editLast', // ↑ 把最后一条排队未发的消息取回输入框编辑
  'input:forward', // 交给 textInput(光标移动等)
  'noop', // 明确吞掉:此 context 下该方向无绑定
]);

const _ACTION_SET = new Set(ARROW_ACTIONS);
const _CONTEXT_SET = new Set(CONTEXTS);

/**
 * 从 ink 的 key 对象取方向。同时按下多个方向(ink 不会,但防御性)时按
 * 上→下→左→右 取第一个,保证确定性。
 * @param {*} key ink useInput 的 key 对象
 * @returns {'up'|'down'|'left'|'right'|null}
 */
function arrowDirection(key) {
  if (!key || typeof key !== 'object') {
    return null;
  }
  if (key.upArrow) {
    return 'up';
  }
  if (key.downArrow) {
    return 'down';
  }
  if (key.leftArrow) {
    return 'left';
  }
  if (key.rightArrow) {
    return 'right';
  }
  return null;
}

/**
 * 由交互状态推出 context 名。**这就是块 4.7 的优先级**,从此只有这一个定义处。
 *
 * @param {{shellViewOpen?:boolean, busy?:boolean, empty?:boolean}} state
 * @returns {'shellView'|'executing'|'idle'|'editing'}
 */
function resolveContext(state) {
  const s = state && typeof state === 'object' ? state : {};
  if (s.shellViewOpen) {
    return 'shellView';
  }
  const empty = !!s.empty;
  if (s.busy && empty) {
    return 'executing';
  }
  if (!s.busy && empty) {
    return 'idle';
  }
  return 'editing';
}

// ── 各 context 的方向键绑定表(照抄 CC 的「context → bindings」结构)────────────
//
// executing 的 ↑ 是**条件绑定**(队列为空时无可取回),故在 _resolve 里单独处理;
// 其余全是静态映射,一眼可读、可 diff。
const _BINDINGS = Object.freeze({
  shellView: Object.freeze({
    up: 'scroll:lineUp',
    down: 'scroll:lineDown',
    left: 'subview:exit',
    right: 'noop', // 面板里的 → 无绑定,吞掉(别漏进输入缓冲区)
  }),
  executing: Object.freeze({
    up: 'queue:editLast', // 仅 queueLen > 0 时;否则降为 noop(见 _resolve)
    down: 'subview:openShell',
    left: 'noop',
    right: 'noop',
  }),
  idle: Object.freeze({
    up: 'history:previous',
    down: 'history:next',
    left: 'noop', // 没有子视图可退出 → 无绑定
    right: 'input:forward', // 空缓冲区上光标右移是 no-op,但仍按原样转发
  }),
  editing: Object.freeze({
    // CC 的 Chat context 对 up/down 是无条件绑定 —— 缓冲区有没有文本、有没有换行都
    // 一样回溯历史。useTextInput 会在第一次 ↑ 时暂存草稿、↓ 走过最新一条时还原,
    // 所以转发不丢任何东西。多行缓冲区同样转发:useTextInput 把含换行的提交视为**一条**
    // 历史,每次 ↑/↓ 移动恰好一条,不是一个视觉行。
    up: 'history:previous',
    down: 'history:next',
    left: 'input:forward',
    right: 'input:forward',
  }),
});

/**
 * 方向键 → 动作名。这是块 4.7 的全部判定逻辑。
 *
 * @param {object} args
 * @param {object} [args.key] ink 的 key 对象(取 upArrow/downArrow/leftArrow/rightArrow)
 * @param {string} [args.direction] 直接给方向,优先于 key(便于测试与复用)
 * @param {string} [args.context] 显式 context;缺省由 shellViewOpen/busy/empty 推出
 * @param {boolean} [args.shellViewOpen] shell 窥视面板是否打开
 * @param {boolean} [args.busy] 是否有回合在执行中
 * @param {boolean} [args.empty] 输入缓冲区是否为空
 * @param {number} [args.queueLen] 排队未发消息条数(仅 executing 的 ↑ 用)
 * @returns {string|null} 动作名;非方向键输入 → null
 */
function resolveArrowAction(args) {
  const a = args && typeof args === 'object' ? args : {};

  const dir =
    typeof a.direction === 'string' && ['up', 'down', 'left', 'right'].includes(a.direction)
      ? a.direction
      : arrowDirection(a.key);
  if (!dir) {
    return null; // 不是方向键 → 本叶子不表态,调用方继续走它的兜底
  }

  const ctx = _CONTEXT_SET.has(a.context) ? a.context : resolveContext(a);
  const action = _BINDINGS[ctx][dir];

  // executing 的 ↑ 是条件绑定:队列空时没有可取回的消息,降为吞掉(与历史一致 —— 当时
  // 写作 `if (key.upArrow && query.queueLen > 0) {…} … return;`,落到末尾的 return)。
  if (action === 'queue:editLast' && !(Number(a.queueLen) > 0)) {
    return 'noop';
  }
  return action;
}

module.exports = {
  CONTEXTS,
  ARROW_ACTIONS,
  arrowDirection,
  resolveContext,
  resolveArrowAction,
  // 供守卫/测试校验返回值合法性,免得测试自己再抄一份词表。
  isArrowAction: (v) => _ACTION_SET.has(v),
};
