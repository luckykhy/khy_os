'use strict';

/**
 * taskLineStyle — 常驻任务面板每行的 Ink 文本样式 SSOT(刀23)。
 *
 * 对齐 CC `src/components/TaskListV2.tsx::TaskItem`:
 *   <Text bold={isInProgress} strikethrough={isCompleted} dimColor={isCompleted || isBlocked}>
 * CC 对**已完成**任务的标题做 `strikethrough`(划掉),让长清单里「已做完的事」
 * 一眼可辨被划掉,而不只是变暗。Khy 历史的行样式分类器只给 ✓ 行 green+dim,
 * **从不加 strikethrough**——长清单里已完成项只是暗绿,扫读时与待办难区分。
 *
 * 行首图标即真实状态(✓ completed / → in_progress / ✗ error / ○ pending),
 * 来自 `_taskStore`/`taskPanelState` 的结构化状态(非模糊推断),故按图标着色+划线
 * 是确定性的,无需任何启发式猜测。
 *
 * 门控 `KHY_TASK_STRIKETHROUGH` 默认开;关 → 不附加 strikethrough,逐字节回退
 * 历史 `_iconStyle`(仅 color/bold/dimColor)。
 *
 * 诚实边界(刻意不纳入):
 *  ① Khy 面板每行是**单个 Text 节点**(图标+文本同节点),故 strikethrough 作用于
 *     整行(含 ✓ 图标),而非如 CC 仅划 subject 文本——这是渲染结构决定的刻意简化,
 *     非缺陷;拆成「图标 Text + 文本 Text」会改动布局,超出本刀「样式逻辑对齐」范围。
 *  ② 仅 completed(✓)加划线,对齐 CC `strikethrough={isCompleted}`;in_progress(→)
 *     的 bold、pending(○)的 dim、error(✗)的 red 等其余样式**不动**。Khy 的
 *     cyan/green/red 着色是相对 CC(CC 文本仅 bold/dim,着色在图标)的增强,保留不删。
 *  ③ CC 对 pending **不** dimColor、对 blocked 才 dim;Khy 对 pending 做 dim 是可辩护的
 *     「弱化未开始项」设计,非明显更差,本刀不动(改之即删既有刻意选择,违诚实红线)。
 */

function taskStrikethroughEnabled(env = process.env) {
  const flag = String((env && env.KHY_TASK_STRIKETHROUGH) || '').trim().toLowerCase();
  return !(flag === '0' || flag === 'false' || flag === 'off' || flag === 'no');
}

// 行首非空白首字符 → Ink 文本样式。与历史 _iconStyle 同源;唯一新增:门控开时
// completed(✓)行附加 strikethrough:true。门控关 → 与历史返回对象逐字节一致。
function taskLineStyle(line, env = process.env) {
  const ch = String(line).trimStart()[0];
  if (ch === '→') return { color: 'cyan', bold: true };
  if (ch === '✓') {
    return taskStrikethroughEnabled(env)
      ? { color: 'green', dimColor: true, strikethrough: true }
      : { color: 'green', dimColor: true };
  }
  if (ch === '✗') return { color: 'red' };
  if (ch === '○') return { dimColor: true };
  return {};
}

module.exports = { taskStrikethroughEnabled, taskLineStyle };
