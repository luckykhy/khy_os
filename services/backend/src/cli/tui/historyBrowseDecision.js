'use strict';

/**
 * historyBrowseDecision — ↑/↓ 在缓冲区非空时是否转发给文本输入的决策叶子
 * (纯叶子:零 IO、确定性、绝不抛)。
 *
 * **现状(2026-08,Stage 2 之后):判定已迁出,本模块只剩兼容外壳。**
 * 方向键归属的单一真源现在是 `arrowRouting.js` 的 `resolveArrowAction()`
 * ——照抄 Claude Code 的 `context → bindings` 结构,由 context 栈决定 ↑/↓ 归谁。
 * App.js 块 4.7 只消费那个叶子,不再调用本文件。
 *
 * 为什么退役:CC 的 `Chat` context 对 up/down 是**无条件**绑定
 * (`{context:"Chat", bindings:{ up:"history:previous", down:"history:next" }}`)
 * ——不看缓冲区是否为空、不看有没有换行。而本叶子存在的理由,是一个已随 Stage 2 一并
 * 移除、代码中不再有任何引用的 env 变量 KHY_HISTORY_BROWSE_EDITING;它当初用来在
 * 「单行缓冲区非空」时**退回**到把竖直方向键吞掉的旧行为。那个旧行为本身就是 bug:
 * 第一次 ↑ 召回最近一条后缓冲区不再为空,于是后续 ↑ 全被吞,用户只能回溯一条、想再
 * 往前必须先清空整行。当初留那条旋钮是为了给修复一条字节级回退路径;既然对齐 CC 就
 * 意味着「无条件转发」是唯一正确解,留着回退等于留着一个开关让人把 bug 再打开,故一并
 * 退役 —— 现在这里没有任何可关闭的旋钮,本段只作退役记录。
 *
 * 保留本文件而非删除:`shouldBrowseHistoryWhileEditing` 语义已被 arrowRouting 的
 * `editing` context 完全覆盖(见下方实现),仍导出是为了不打断可能存在的外部
 * 引用;新代码请直接用 `arrowRouting.resolveArrowAction()`。
 *
 * 历史背景(供考古):多行缓冲区从一开始就无条件转发。useTextInput 把每次提交
 * (含内嵌换行)视为**一条**历史,所以转发的 ↑/↓ 移动的是一条提交记录,不是一个
 * 视觉行;它还会在第一次 ↑ 时暂存实时草稿、在 ↓ 走过最新一条时还原,因此转发不丢
 * 任何输入 —— 这与 Claude Code / bash / zsh / readline 的行为一致。
 */

/**
 * 是否允许在缓冲区非空时用 ↑/↓ 浏览历史。
 *
 * **恒为 true**:`KHY_HISTORY_BROWSE_EDITING` 门控已随 Stage 2 退役(理由见文件头)。
 * 保留函数签名以免打断外部引用;不再读 env,故参数被忽略。
 *
 * @returns {boolean} 恒 true
 */
function historyBrowseWhileEditingEnabled() {
  return true;
}

/**
 * 缓冲区非空时按下 ↑/↓ 是否应转发给文本输入。
 *
 * **恒为 true**,与 CC 的 Chat context 一致:单行与多行一视同仁。判定的单一真源是
 * `arrowRouting.resolveArrowAction()`(`editing` context 的 up/down 绑定)。
 *
 * @returns {boolean} 恒 true(转发)
 */
function shouldBrowseHistoryWhileEditing() {
  return true;
}

module.exports = { historyBrowseWhileEditingEnabled, shouldBrowseHistoryWhileEditing };
