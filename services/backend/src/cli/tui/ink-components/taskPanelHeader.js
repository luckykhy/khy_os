'use strict';

/**
 * taskPanelHeader.js — 纯叶子:把常驻任务清单面板的**全量任务**按状态计数,折成一行
 * CC 对齐的标题(对齐 CC src/components/TaskListV2.tsx 的 isStandalone 头行:
 *   `{N} tasks ({done} done, [{ip} in progress, ]{open} open)`
 * —— total + 完成(总在) + 进行中(仅 >0) + 待办(总在)。khy 携带 CC 没有的 error(✗)
 * 状态,故诚实扩展「错误」段,同样仅 >0 才出现)。
 *
 * khy 现状:TaskListPanel 头行只渲染静态标签 `任务清单`,没有任何 total/完成/进行中/待办
 * 的分解 —— 用户看不出清单整体进度。本叶子补上 CC 那段计数算术的「背后逻辑」。
 *
 * 契约(纯叶子):零 IO、确定性、绝不抛、单一真源(行首图标 → 状态的逆映射由
 * taskPanelLines.countTaskLinesByStatus 提供,本叶子不另立第二份图标表)。env 仅用于门控。
 *
 * 诚实红线:计数必须覆盖**全量**任务(可见行 `lines` + 全部隐藏行 `hiddenLines`)。
 *   - 隐藏计数 `hidden>0` 却拿不到等长的 `hiddenLines`(无法逐行归类)→ 返 '';
 *   - 任一行行首不是可识别图标(unknown>0)→ 返 '';
 *   - 门控关 → 返 ''。
 * 任一情形调用方都回退静态标题 `任务清单`,绝不少计/错计/臆造未携带的数据。
 */

const { countTaskLinesByStatus } = require('./taskPanelLines');

const _FALSY = new Set(['0', 'false', 'off', 'no']);

/**
 * 子门控(默认开,值为 0/false/off/no 时关)。关 → buildTaskPanelHeader 返 ''。
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
function taskPanelHeaderEnabled(env = process.env) {
  const flag = String((env && env.KHY_TASK_PANEL_HEADER) || '').trim().toLowerCase();
  return !_FALSY.has(flag);
}

/**
 * 构造任务清单面板的 CC 对齐标题。
 *
 * @param {object} opts
 * @param {string[]} opts.lines        - 可见行(行首带 ✓/→/✗/○ 图标)
 * @param {number} [opts.hidden]       - 被尾切隐藏的行数(coordinated 模式由 App 传入)
 * @param {string[]} [opts.hiddenLines]- 被尾切隐藏的行(逐行归类的真实来源)
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string} 形如「任务清单（共 N 项:X 完成、Y 进行中、Z 待办、W 错误)」;
 *                   无法诚实覆盖全量或门控关 → ''(调用方回退静态标题)
 */
function buildTaskPanelHeader(opts = {}, env = process.env) {
  if (!taskPanelHeaderEnabled(env)) return '';
  if (!opts || typeof opts !== 'object') return '';

  const lines = Array.isArray(opts.lines) ? opts.lines : [];
  if (lines.length === 0) return ''; // 空清单不渲染(调用方本就 return null)

  const hidden = Math.max(0, Number(opts.hidden) || 0);
  const hiddenLines = Array.isArray(opts.hiddenLines) ? opts.hiddenLines : [];

  // 诚实红线:有隐藏项却拿不到等长隐藏行 → 无法覆盖全量 → 回退静态标题。
  if (hidden > 0 && hiddenLines.length !== hidden) return '';

  const visible = countTaskLinesByStatus(lines);
  const hide = countTaskLinesByStatus(hiddenLines);
  // 任一行行首非已知图标 → 无法逐行归类 → 回退(绝不把它静默并进某一类)。
  if (visible.unknown > 0 || hide.unknown > 0) return '';

  const completed = visible.completed + hide.completed;
  const inProgress = visible.in_progress + hide.in_progress;
  const pending = visible.pending + hide.pending;
  const error = visible.error + hide.error;
  const total = completed + inProgress + pending + error; // === lines.length + hidden(已校验)

  // CC 头行结构:完成(总在) → 进行中(仅 >0) → 待办(总在);khy 诚实扩展 错误(仅 >0)。
  const parts = [`${completed} 完成`];
  if (inProgress > 0) parts.push(`${inProgress} 进行中`);
  parts.push(`${pending} 待办`);
  if (error > 0) parts.push(`${error} 错误`);

  return `任务清单（共 ${total} 项:${parts.join('、')}）`;
}

module.exports = { taskPanelHeaderEnabled, buildTaskPanelHeader };
