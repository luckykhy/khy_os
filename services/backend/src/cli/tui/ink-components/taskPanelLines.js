'use strict';

/**
 * taskPanelLines.js — 纯叶子:把计划面板状态(taskPanelState 的步骤数组)格式化为
 * TaskListPanel 可渲染的 ✓/→/✗/○ 行(行首图标与 `_taskStore.snapshot()` 同构),
 * 并把它与 snapshot 文本合并成统一行列表。
 *
 * 契约(纯叶子):零 IO、确定性、绝不抛、单一真源、无副作用。输入畸形一律 fail-soft
 * 返回 [](或原样保留),绝不让格式化拖垮渲染。原有两个格式化器(formatPanelStateLines /
 * mergeTaskLines)不读 env;新增的 `summarizeHiddenTaskLines` 自带子门控
 * `KHY_TASK_HIDDEN_BREAKDOWN`(读 env 仅用于门控,符合全局 leaf 契约),门控关返 ''
 * 让调用方逐字节回退原始计数。
 */

// 计划步骤状态 → 行首图标(与 snapshot 的 ✓/→/○ 对齐,error 追加 ✗)。
const STATUS_ICON = { completed: '✓', in_progress: '→', error: '✗', pending: '○' };

/**
 * 单个状态 → 图标。未知状态保守归 pending(○)。
 * @param {string} status
 * @returns {string}
 */
function panelStatusIcon(status) {
  return STATUS_ICON[String(status || '').trim()] || '○';
}

/**
 * 计划步骤数组 → 行数组。null/非数组/空描述项一律剔除。
 * @param {Array<{description: string, status: string}>|null|undefined} tasks
 * @returns {string[]}
 */
function formatPanelStateLines(tasks) {
  if (!Array.isArray(tasks)) return [];
  const out = [];
  for (const t of tasks) {
    if (!t) continue;
    const desc = String(t.description || '').trim();
    if (!desc) continue;
    out.push(`${panelStatusIcon(t.status)} ${desc}`);
  }
  return out;
}

/**
 * 合并 `_taskStore.snapshot()` 文本 + 计划面板步骤。
 *
 * 计划行在前(当前执行焦点),模型 TodoWrite/TaskCreate 行在后。逐字符相同的行
 * (trim 后)只保留首次出现,避免两源重复。两者皆空 → []。
 *
 * @param {string} snapshotText - _taskStore.snapshot() 的返回(可空)
 * @param {Array<{description: string, status: string}>|null} panelTasks
 * @returns {string[]}
 */
function mergeTaskLines(snapshotText, panelTasks) {
  const planLines = formatPanelStateLines(panelTasks);
  const snapLines = String(snapshotText || '')
    .split('\n')
    .filter((l) => l.trim().length);

  const seen = new Set();
  const out = [];
  for (const line of [...planLines, ...snapLines]) {
    const key = line.trim();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  return out;
}

/**
 * 子门控:隐藏任务的「按状态分解」摘要(默认开,值为 0/false/off/no 时关)。
 * 关 → summarizeHiddenTaskLines 返 ''(调用方逐字节回退原始计数)。
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
function taskHiddenBreakdownEnabled(env = process.env) {
  const flag = String((env && env.KHY_TASK_HIDDEN_BREAKDOWN) || '').trim().toLowerCase();
  return !(flag === '0' || flag === 'false' || flag === 'off' || flag === 'no');
}

// 行首图标 → 状态(panelStatusIcon 的逆映射,用于从已渲染行回推状态)。
const ICON_STATUS = { '✓': 'completed', '→': 'in_progress', '✗': 'error', '○': 'pending' };

/**
 * 把已渲染行(行首带 ✓/→/✗/○ 图标)按状态计数(单一真源:复用 ICON_STATUS 逆映射,
 * 不另立第二份图标表)。行首非已知图标 → 计入 `unknown`(调用方据此决定是否回退,
 * 绝不静默归错类)。零 IO、确定性、绝不抛。
 *
 * @param {string[]} lines - 行数组(行首带状态图标)
 * @returns {{completed:number,in_progress:number,pending:number,error:number,unknown:number}}
 */
function countTaskLinesByStatus(lines) {
  const counts = { completed: 0, in_progress: 0, pending: 0, error: 0, unknown: 0 };
  if (!Array.isArray(lines)) return counts;
  for (const line of lines) {
    const head = String(line || '').trimStart().charAt(0);
    const status = ICON_STATUS[head];
    if (status) counts[status] += 1;
    else counts.unknown += 1;
  }
  return counts;
}

/**
 * 把「被截断的隐藏行」按状态分解成一句诚实摘要(对齐 CC TaskListV2.hiddenSummary)。
 *
 * 每条已渲染行行首是 panelStatusIcon 写入的图标(✓/→/○/✗),故分解来自**真实结构**,
 * 不是模糊启发式。次序对齐 CC:进行中 → 待办 → 已完成 → 错误,仅非零项出现。
 *
 * 诚实边界:任一隐藏行行首不是可识别图标 → 返 ''(调用方回退原始计数,绝不少计);
 * 空数组/非数组 → '';门控关 → ''。返回不含前导符号,由调用方拼进标记串。
 *
 * @param {string[]} hiddenLines - 被 capTaskLines 丢弃的行(行首带状态图标)
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string} 形如「2 进行中, 3 待办, 1 已完成」;无法分解或门控关 → ''
 */
function summarizeHiddenTaskLines(hiddenLines, env = process.env) {
  if (!taskHiddenBreakdownEnabled(env)) return '';
  if (!Array.isArray(hiddenLines) || hiddenLines.length === 0) return '';

  const counts = { in_progress: 0, pending: 0, completed: 0, error: 0 };
  for (const line of hiddenLines) {
    const head = String(line || '').trimStart().charAt(0);
    const status = ICON_STATUS[head];
    if (!status) return ''; // 行首非已知图标 → 放弃分解,回退原始计数(绝不少计)
    counts[status] += 1;
  }

  const parts = [];
  if (counts.in_progress > 0) parts.push(`${counts.in_progress} 进行中`);
  if (counts.pending > 0) parts.push(`${counts.pending} 待办`);
  if (counts.completed > 0) parts.push(`${counts.completed} 已完成`);
  if (counts.error > 0) parts.push(`${counts.error} 错误`);
  return parts.join(', ');
}

/**
 * 子门控:任务面板「本会话清单 vs 跨会话项目任务」语义分组(默认开,值为 0/false/off/no 时关)。
 * 关 → splitTaskLinesBySource 返 null,调用方逐字节回退今日扁平渲染。
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
function taskPanelSplitEnabled(env = process.env) {
  const flag = String((env && env.KHY_TASK_PANEL_SPLIT) || '').trim().toLowerCase();
  return !(flag === '0' || flag === 'false' || flag === 'off' || flag === 'no');
}

// _taskStore.snapshot() 为持久化 large-task(V2)行写入的结构标记:`<icon> #<id> …`
// (状态图标后紧跟 `#`)。计划步骤(taskPanelState)与 V1 TodoWrite 行则是
// `<icon> <文本>`,图标后不带 `#`。这是我们自己 snapshot() 确定性写入的结构信号,
// 而非对任务文案的模糊启发式——故据此判定「跨会话项目任务」是可靠的。
const _PROJECT_LINE_RE = /^\s*[✓→○✗]\s+#\S/;

/**
 * 把已合并的任务行按**来源生命周期**拆成两组,消除「三套语义混在一个面板当成一种任务」:
 *  - 「本会话清单」= 计划步骤(taskPanelState)+ V1 TodoWrite(会话启动已隔离,见会话边界刀);
 *  - 「项目任务 · 跨会话」= 持久化 large-task store(_taskStore,正当长存)。
 *
 * 分组依据是 `_taskStore.snapshot()` 为 V2 行写入的结构标记 `<icon> #<id>`(见 _PROJECT_LINE_RE),
 * 属确定性结构信号、非文案启发式。诚实边界:某条会话行文案若恰以「`#` + 非空白」紧跟状态图标起头,
 * 会被归入项目组——纯属**显示分区**,绝不改动扁平回退路径的字节、不增删任何行、不影响
 * header/hidden/priority 各叶子(它们仍消费未分组的扁平 lines)。
 *
 * 零 IO、确定性、绝不抛。
 *
 * @param {string[]} lines - 已合并(且可能已 cap)的任务行,行首带状态图标
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{key:string, label:string, lines:string[]}[]|null}
 *          门控关 / 非数组 / 空 / 仅单一来源(无可拆分)→ null(调用方逐字节回退扁平渲染)
 */
function splitTaskLinesBySource(lines, env = process.env) {
  if (!taskPanelSplitEnabled(env)) return null;
  if (!Array.isArray(lines) || lines.length === 0) return null;
  const session = [];
  const project = [];
  for (const line of lines) {
    (_PROJECT_LINE_RE.test(String(line || '')) ? project : session).push(line);
  }
  // 仅当两组都非空才值得分区;单一来源 → null,让调用方回退今日扁平渲染(不加无谓标签)。
  if (session.length === 0 || project.length === 0) return null;
  return [
    { key: 'session', label: '本会话清单', lines: session },
    { key: 'project', label: '项目任务 · 跨会话', lines: project },
  ];
}

/**
 * 子门控:任务清单截断时的「按状态生存优先级」选择(默认开,值为 0/false/off/no 时关)。
 * 关 → 调用方 `capTaskLines` 逐字节回退历史尾切(slice(cut))。
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
function taskPriorityCapEnabled(env = process.env) {
  const flag = String((env && env.KHY_TASK_PRIORITY_CAP) || '').trim().toLowerCase();
  return !(flag === '0' || flag === 'false' || flag === 'off' || flag === 'no');
}

// 截断时的「生存优先级」(数值越小越优先保活)。对齐 CC TaskListV2 截断优先级
// prioritized = [recentCompleted, inProgress, pending, olderCompleted] 的**核心意图**:
// 活动中(进行中)与待办优先于陈旧已完成存活,使长清单截断不会把用户最该看到的
// 「正在进行的任务」挤掉(khy 历史盲目尾切会丢掉非末尾的 → 行)。
// 诚实边界:khy 任务行**不携带完成时间戳**,无法区分 CC 的 recentCompleted(≤30s)与
// olderCompleted,故把全部已完成归**最低**生存优先级(绝不臆造时间戳谎称「最近完成」);
// error(✗)是 CC 不具的 khy 显式状态,归入高优先级(失败需被看见)。
const _SURVIVAL_RANK = { in_progress: 0, error: 1, pending: 2, completed: 3 };

/**
 * 截断时按状态生存优先级选出存活的 cap 行(进行中/错误 > 待办 > 已完成)。
 * 同一状态档内**保留 khy 既有「尾锚定」哲学**(原始靠后者优先存活,与
 * `liveRegionBudget` 注释的「尾切=实时仅显示末尾」一致,绝不删此刻意设计);
 * 仅在**跨状态档**时用优先级覆盖,把活动任务从陈旧已完成手里救回。最后按
 * 原始顺序恢复显示(列表仍自上而下读)。
 *
 * 诚实边界:任一行行首图标无法识别(非 ✓/→/✗/○)→ 返 `null`(调用方回退历史尾切,
 * 绝不在不确定状态下错排/误隐);无截断(cap≥行数)亦返 `null`(由调用方原样处理)。
 * 纯函数:零 IO、确定性、绝不抛。
 *
 * @param {string[]} lines - 行数组(行首带状态图标)
 * @param {number} cap - 保活上界
 * @returns {{kept:string[], hiddenLines:string[]}|null}
 */
function selectTaskLinesByPriority(lines, cap) {
  if (!Array.isArray(lines)) return null;
  const n = lines.length;
  if (!Number.isFinite(cap) || cap < 0 || cap >= n) return null; // 无截断 → 调用方处理
  const ranked = [];
  for (let i = 0; i < n; i++) {
    const head = String(lines[i] || '').trimStart().charAt(0);
    const status = ICON_STATUS[head];
    if (!status) return null; // 任一行不可识别 → 放弃优先级,回退尾切
    ranked.push({ i, rank: _SURVIVAL_RANK[status] });
  }
  // 生存优先级升序;同档**降序**原始下标(尾锚定:靠后者先存活,守 khy 既有哲学)。
  const keptIdx = new Set(
    ranked
      .slice()
      .sort((a, b) => (a.rank - b.rank) || (b.i - a.i))
      .slice(0, cap)
      .map((x) => x.i),
  );
  const kept = [];
  const hiddenLines = [];
  for (let i = 0; i < n; i++) {
    (keptIdx.has(i) ? kept : hiddenLines).push(lines[i]); // 按原始顺序恢复显示
  }
  return { kept, hiddenLines };
}

module.exports = {
  panelStatusIcon,
  formatPanelStateLines,
  mergeTaskLines,
  summarizeHiddenTaskLines,
  taskHiddenBreakdownEnabled,
  countTaskLinesByStatus,
  taskPanelSplitEnabled,
  splitTaskLinesBySource,
  taskPriorityCapEnabled,
  selectTaskLinesByPriority,
};
