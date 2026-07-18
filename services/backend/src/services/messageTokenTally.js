'use strict';

/**
 * messageTokenTally — per-message token-estimate memo for the agentic task loop.
 *
 * 背景(goal「khy 任务体验卡顿,无法做真正的软件项目」):toolUseLoop 每次迭代都要估算
 * 「当前会话已用多少 token」来驱动容量/溢出闸门(capacityFlow 的 pre/post/error 三个
 * checkpoint)。原实现是对**整条 conversationMessages** 跑 reduce,每个 message 都
 * `JSON.stringify(m.content)` + `estimateTokens`(内部 `text.match(/[一-鿿…]/g)`
 * 全文正则扫描)。而 conversationMessages 每轮 push ~2 条只增不减,同一 checkpoint 每轮又
 * 跑 2–3 次 → **O(N²) in transcript bytes / turn**,且带 stringify+正则的重常数,正好落在
 * 「模型返回 → 工具派发」之间的阻塞主路径上 = 任务执行发卡的一个真实来源。
 *
 * 关键不变量(取证已确认):message 一旦入队即不再原地改内容;seam/capacity 决策返回**新
 * 数组但复用同一 message 对象**(见 toolUseLoop seamResult.messages / applyDecision)。故
 * 「token 估算」是 message 对象身份的纯函数 → 用 WeakMap 按对象身份记忆逐字节等价,幸存
 * message 每轮命中、只有本轮新增的 message 才计算。message 被 GC(轮次结束数组丢弃)→
 * WeakMap 自动逐出,零泄漏。
 *
 * 逐字节等价:sumMessageTokens 的每元素表达式与原 reduce 一字不差;命中缓存返回的恰是同一
 * (message, estimateFn) 直接计算会得到的值。门控 KHY_MSG_TOKEN_MEMO(默认开;off/0/false/no
 * → 每元素直接算、完全不碰 WeakMap = 今日行为逐字节回退)。契约:确定性、绝不改变可观测
 * 行为(含对 null message 的抛出语义)。
 */

const { isFlagEnabled } = require('./flagRegistry');

// message 对象 → { fn, tokens }。keyed by 对象身份;fn 一并存,estimateFn 变了就重算,
// 保证无论调用方传哪个估算函数都逐字节正确(真实路径 estimateTokens 是稳定的模块函数引用,
// Node 模块缓存 → 恒命中;罕见 fallback arrow 每处新建 → 不命中即重算,仍正确)。
const _memo = new WeakMap();

/**
 * 门控查询。未登记/异常 → 保守放行(true),与 flagRegistry 语义一致。
 * @param {object} [env]
 * @returns {boolean}
 */
function isMsgTokenMemoEnabled(env = process.env) {
  try { return isFlagEnabled('KHY_MSG_TOKEN_MEMO', env); }
  catch { return true; }
}

/**
 * 求整条 messages 的 token 估算和,按 message 对象身份记忆逐条估算。
 * 逐字节等价于:messages.reduce((s,m)=>s+estimateFn(string?content:JSON.stringify(content||'')),0)
 *
 * @param {Array<object>} messages
 * @param {function(string): number} estimateFn
 * @param {object} [env]
 * @returns {number}
 */
function sumMessageTokens(messages, estimateFn, env = process.env) {
  // 防御:真实路径 messages 恒为数组、estimateFn 恒为函数(此分支为死路),返回 0 不改主路径。
  if (!Array.isArray(messages) || typeof estimateFn !== 'function') return 0;

  const memo = isMsgTokenMemoEnabled(env);
  let sum = 0;
  for (const m of messages) {
    // WeakMap 只接受非 null 对象为键;null / 原始值走直算分支,保留原 reduce 的可观测行为
    // (null.content 抛错 → 冒泡给调用方的 try/catch,与原实现一致)。
    const canMemo = memo && m !== null && typeof m === 'object';
    if (canMemo) {
      const hit = _memo.get(m);
      if (hit !== undefined && hit.fn === estimateFn) { sum += hit.tokens; continue; }
    }
    // 直算:与原 reduce 每元素表达式一字不差。
    const tokens = estimateFn(typeof m.content === 'string' ? m.content : JSON.stringify(m.content || ''));
    if (canMemo) _memo.set(m, { fn: estimateFn, tokens });
    sum += tokens;
  }
  return sum;
}

/** 清空记忆(测试/显式复位用;WeakMap 无法遍历,这里换新实例)。 */
function _clearMemo() { /* WeakMap 不可清空,测试用新对象即天然隔离;保留占位以对齐叶子约定 */ }

module.exports = {
  isMsgTokenMemoEnabled,
  sumMessageTokens,
  _clearMemo,
};
