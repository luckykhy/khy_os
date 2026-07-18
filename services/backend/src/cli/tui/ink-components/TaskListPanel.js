'use strict';

/**
 * TaskListPanel — 常驻任务清单面板(缺口②:TodoWrite 可见性 + 计划执行可见性)。
 *
 * 合并两源,渲染统一的 ✓/→/✗/○ 多行勾选列表(in_progress(→)行 cyan 高亮):
 *  - `tools/_taskStore.snapshot()`:模型主动调 TodoWrite/TaskCreate 的 V2 依赖图 + V1 清单;
 *  - `services/taskPanelState.getTasks()`:计划批准后 executePlan 逐步喂入的步骤进度
 *    (Ink 执行计划用 stub renderer,既不写 _taskStore 也不写 stdout,故计划进度此前
 *    只在 transcript 滚动、不进常驻面板——本合并把它接回输入框上方的面板)。
 * 面板挂在 App 的 live 区,靠现有 `nowTick` 1s heartbeat 自然重渲染。
 *
 * 设计约束:
 *  - fault isolation:任何异常(store 未就绪/抛错)一律 try/catch 吞掉返 null,
 *    清单是辅助显示,绝不能拖垮整个 TUI。
 *  - 空清单返 null(不占屏)。
 *  - 纯展示,无副作用,无订阅泄漏。
 *
 * 逃生阀 `KHY_TASK_PANEL`(默认 on,整个面板);`KHY_PLAN_TASK_PANEL`(默认 on,
 * 仅计划进度合并,关则字节回退为只读 _taskStore)。
 */

const React = require('react');
const inkRuntime = require('../inkRuntime');
const { mergeTaskLines, summarizeHiddenTaskLines, taskPriorityCapEnabled, splitTaskLinesBySource } = require('./taskPanelLines');
// 刀23:每行样式(含 completed ✓ 的 strikethrough,对齐 CC TaskListV2)由纯叶子 SSOT 收敛。
const { taskLineStyle } = require('./taskLineStyle');
// 刀28:头行按状态计数(total/完成/进行中/待办[/错误],对齐 CC TaskListV2 isStandalone 头行)。
const { buildTaskPanelHeader } = require('./taskPanelHeader');

function TaskListPanel(props = {}) {
  // Two render modes:
  //  • Coordinated (App passes `lines`): App is the SSOT — it reads both sources
  //    ONCE, merges, and caps height via liveRegionBudget so the panel and
  //    StreamingBlock's reserve agree (keeps the live region < rows → no scroll
  //    jump). `hidden` is how many lines were tail-capped away.
  //  • Standalone (no `lines` prop): legacy self-read path (byte-revert; also what
  //    the unit tests exercise by calling TaskListPanel() directly).
  const coordinated = Array.isArray(props.lines);

  let lines;
  let hidden = 0;
  if (coordinated) {
    if (process.env.KHY_TASK_PANEL === '0') return null;
    lines = props.lines;
    hidden = Math.max(0, Number(props.hidden) || 0);
  } else {
    // Fault isolation: 两源均拉取式消费,任何异常都不得冒泡到 ink 渲染树。
    let snap = '';
    let planTasks = null;
    try {
      if (process.env.KHY_TASK_PANEL === '0') return null;
      const taskStore = require('../../../tools/_taskStore');
      snap = typeof taskStore.snapshot === 'function' ? taskStore.snapshot() : '';
      if (process.env.KHY_PLAN_TASK_PANEL !== '0') {
        const panelState = require('../../../services/taskPanelState');
        planTasks = typeof panelState.getTasks === 'function' ? panelState.getTasks() : null;
      }
    } catch {
      return null;
    }
    lines = mergeTaskLines(snap, planTasks);
  }

  const { Box, Text } = inkRuntime.get();
  const h = React.createElement;
  if (!lines.length) return null;

  // 刀28:头行从静态 `任务清单` 升级为 CC 对齐的按状态计数。计数覆盖全量(可见
  // lines + 隐藏 hiddenLines);无法诚实覆盖全量或门控关 → buildTaskPanelHeader 返
  // '' → 逐字节回退静态标题 `任务清单`。
  const header = buildTaskPanelHeader(
    { lines, hidden, hiddenLines: props.hiddenLines }, process.env) || '任务清单';

  // 语义分区(缺口②):把「本会话清单」(计划步骤 + V1 TodoWrite)与「项目任务 · 跨会话」
  // (持久化 large-task store)拆成带标签的两段,不再当成一种任务混显示。分组只在展示层进行,
  // header/hidden 仍消费未分组的扁平 `lines`(计数不变)。门控关 / 仅单一来源 → splitTaskLinesBySource
  // 返 null → 逐字节回退今日扁平渲染(键 `task-${i}` 与 taskLineStyle 完全一致)。
  const groups = splitTaskLinesBySource(lines, process.env);
  const body = [];
  if (groups) {
    let gi = 0;
    for (const g of groups) {
      body.push(h(Text, { key: `task-group-${g.key}`, dimColor: true }, `— ${g.label} —`));
      for (const line of g.lines) {
        body.push(h(Text, { key: `task-${gi}`, ...taskLineStyle(line, process.env) }, line));
        gi += 1;
      }
    }
  } else {
    lines.forEach((line, i) => body.push(h(Text, { key: `task-${i}`, ...taskLineStyle(line, process.env) }, line)));
  }

  const children = [
    h(Text, { key: 'task-title', dimColor: true }, header),
    ...body,
  ];
  if (hidden > 0) {
    // 尾切提示:与 StreamingBlock「实时仅显示末尾」同款诚实告知,完整清单在本轮历史可回看。
    // 刀19:隐藏项按状态分解(对齐 CC TaskListV2.hiddenSummary)。分解来自被丢弃行的行首
    // 图标(真实结构),任一行无法识别或门控关 → bd 为 '' → 逐字节回退原始计数标记。
    // 刀30:优先级保活开启后,留下的不再是「末尾 N 行」而是「优先级最高的 N 行」
    // (进行中/待办优先),故去掉「末尾」二字以免谎称尾切;门控关回退「末尾」措辞。
    const bd = summarizeHiddenTaskLines(props.hiddenLines, process.env);
    const _tail = taskPriorityCapEnabled(process.env) ? '' : '末尾';
    children.push(h(Text, { key: 'task-hidden', dimColor: true },
      bd
        ? `⋯ 仅显示${_tail} ${lines.length} 项（另有 ${bd}）`
        : `⋯ 仅显示${_tail} ${lines.length} 项（另有 ${hidden} 项未显示）`));
  }

  return h(Box, { flexDirection: 'column', marginTop: 1, borderStyle: 'round', borderColor: 'gray', paddingX: 1 },
    ...children,
  );
}

module.exports = TaskListPanel;
