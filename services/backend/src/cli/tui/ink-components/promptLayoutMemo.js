'use strict';

/**
 * promptLayoutMemo — gate helper for memoizing PromptFrame's per-render input
 * re-wrap (goal「khy 动画/输入体验卡顿,无法做真正的软件项目」).
 *
 * 背景:PromptFrame 在组件体里**无条件**调用 `layoutPromptRows({value,offset,cols,
 * placeholder,maxRows})`,该函数对整条输入 buffer 逐字符跑 `string-width`(CJK 宽度)重排
 * 成视觉行。而 App 有 ~20 个 useState + 忙碌时 1s `nowTick` 心跳 + hint/footer 等定时器,
 * **任何**无关状态变化都会触发 PromptFrame 重渲染 → 即便 value 没变也把整条 buffer 重排一遍。
 * buffer 里坐着一段多 KB 粘贴时,就是每次无关重渲染都 O(buffer) 次 string-width = 打字/心跳发卡。
 *
 * layoutPromptRows 是**纯函数**(只依赖 {value,offset,cols,placeholder,maxRows},dwidth 确定),
 * 故用 React.useMemo 按这五个输入记忆逐字节等价:输入不变则复用上一帧的 rows,零重排。
 *
 * 门控 KHY_PROMPT_LAYOUT_MEMO(默认开):关 → 调用方每帧重算(逐字节回退今日行为)。本叶子只
 * 提供门控查询(useMemo 是 hook 必须在组件内调用),契约:零 IO、确定性、绝不抛。
 */

const { isFlagEnabled } = require('../../../services/flagRegistry');

/**
 * PromptFrame 输入重排记忆是否启用。未登记/异常 → 保守放行(true)。
 * @param {object} [env]
 * @returns {boolean}
 */
function isPromptLayoutMemoEnabled(env = process.env) {
  try { return isFlagEnabled('KHY_PROMPT_LAYOUT_MEMO', env); }
  catch { return true; }
}

module.exports = { isPromptLayoutMemoEnabled };
