'use strict';

/**
 * inertiaCompletion.js — 模型中途断线时的「惯性完成 + 无感衔接」策略(单一真源)。
 *
 * 背景(goal 2026-06-25):流式适配器在 ECONNRESET / 过早关闭且**已有进度**时,会以
 * PARTIAL 结果 resolve(`interrupted:true` + 模型已下达的 `toolUseBlocks`,见
 * services/gateway/adapters/_openaiSseStream.js 的 stream.on('error')),而不是 reject
 * 成 errorType。toolUseLoop 因此「盲目地」执行了这些已下达的工具调用 —— 这本身就是
 * 一种惯性,但循环并不知道这是一次断线回合,于是:
 *   1) 不会把被中断截断、参数残缺的坏 tool_use 挡在执行之外(执行垃圾调用);
 *   2) 不会在「重连」后的下一次模型调用里显式告诉模型「你刚断过线,以下结果由惯性
 *      完成,请据此续跑、勿重复」—— 即用户要的「完成后再告诉模型已经断开 + 无感衔接」;
 *   3) 重连失败时不会把这次被吸收的瞬断对用户做出有意义的交代。
 *
 * 本模块是纯叶子(无 IO、可单测):判定断线惯性回合、过滤可执行 block、生成给模型的
 * 重连提示与给用户的软提示。env `KHY_INERTIA_COMPLETION=0` 整体回退到原「盲目执行」行为。
 *
 * 注意:这里只关心「断线 partial(无 errorType)」这一条已经会 fall-through 执行的路径。
 * 真正变成 errorType 的断线(零进度 reject)没有可执行的 block,不在本模块范围。
 */

/** env 闸:默认开;'0'/'false'/'off' 关闭 → 调用方按原盲目行为处理。 */
function isEnabled(env = process.env) {
  const v = env && env.KHY_INERTIA_COMPLETION;
  if (v === '0' || v === 'false' || v === 'off') return false;
  return true;
}

/**
 * 一次回合是「断线惯性回合」当且仅当流式层交回的是一次断线导致的 PARTIAL 结果
 * (`interrupted === true`)且仍携带模型已下达的 tool_use 块。
 *
 * 严格只认 `interrupted === true`:一次干净的 max_tokens 截断(finishReason:'length'
 * 但 **没有** interrupted)不是断线,绝不能被误判进惯性路径(那条由 _maxTokensRecovery 管)。
 */
function isInertiaTurn(aiResult, env = process.env) {
  if (!isEnabled(env)) return false;
  if (!aiResult || aiResult.interrupted !== true) return false;
  const blocks = aiResult.toolUseBlocks;
  return Array.isArray(blocks) && blocks.length > 0;
}

function _blockName(block) {
  return (block && (block.name || (block.function && block.function.name))) || '';
}

/**
 * 防御:断线可能把一个 tool_use 块在「参数」中途截断,留下不可解析的残缺 input。
 * 执行这种垃圾调用比跳过它更糟。判定可执行:
 *   - 必须有工具名;server_tool_use 由服务端处理,绝不本地派发 → 视为不可执行;
 *   - input 为对象 → 可执行;
 *   - input 缺失 / 空串 → 可执行(下游 normalizeToolCall 默认成 {} ,与正常路径一致);
 *   - input 为字符串 → 必须能 JSON.parse 才可执行(残缺 JSON → 跳过)。
 */
function _isExecutableBlock(block) {
  if (!block) return false;
  if (block.type === 'server_tool_use') return false;
  if (!_blockName(block)) return false;
  let input = block.input;
  if (input == null) input = block.params;
  if (input == null && block.function) input = block.function.arguments;
  if (input == null || input === '') return true;
  if (typeof input === 'object') return true;
  if (typeof input === 'string') {
    try { JSON.parse(input); return true; } catch { return false; }
  }
  return false;
}

/**
 * 把已下达的 block 拆成可执行 / 被丢弃两份。可执行的放行给循环的常规解析/执行路径
 * (惯性完成);被丢弃的(截断坏块)计数,用于提示「另有 N 个调用因截断被跳过」。
 */
function filterExecutableBlocks(blocks) {
  const list = Array.isArray(blocks) ? blocks : [];
  const executable = [];
  const dropped = [];
  for (const b of list) {
    if (_isExecutableBlock(b)) executable.push(b);
    else dropped.push(b);
  }
  return { executable, dropped };
}

/**
 * 注入到「重连」那次模型调用的 [SYSTEM: …] 提示:显式告诉模型它刚断过线,下列工具
 * 结果由惯性完成,通道已恢复 → 据此续跑、勿重复。无可announce内容时返回 '' (调用方不注入)。
 */
function buildModelReconnectHint({ executedTools = [], droppedCount = 0 } = {}) {
  const names = (executedTools || []).filter(Boolean);
  if (!names.length && !droppedCount) return '';
  const did = names.length
    ? `通道中断期间已由惯性自动完成以下已下达的操作(无需模型):${names.join('、')}。`
    : '通道在你下达工具调用后中途断开。';
  const dropNote = droppedCount
    ? `另有 ${droppedCount} 个调用因中断被截断、参数残缺已跳过,如仍需请重新发起。`
    : '';
  return '[SYSTEM: 上一回合模型通道中途断开;' + did + dropNote
    + '通道现已恢复,请直接基于上方工具结果继续推进,切勿重复已完成的调用。]';
}

/**
 * 给用户的简短、不惊扰的一行提示。
 *   - reconnected=true:无感续接语气(成功路径其实不打扰用户,这里仅备用)。
 *   - reconnected=false:惯性已完成、通道未恢复语气(用在重连耗尽后的打捞路径)。
 * 无内容时返回 ''。
 */
function buildUserInertiaNotice({ executedCount = 0, droppedCount = 0, reconnected = true } = {}) {
  if (!executedCount && !droppedCount) return '';
  const head = reconnected
    ? `⟳ 通道曾瞬断,已用惯性完成 ${executedCount} 个已下达的步骤并自动续接`
    : `⟳ 通道中途断开,已用惯性完成 ${executedCount} 个已下达的步骤(通道未恢复,以上为已完成结果)`;
  const tail = droppedCount ? `;跳过 ${droppedCount} 个被截断的调用` : '';
  return head + tail + '。';
}

/** 汇总惯性事件给 loop 返回对象(数据契约,供程序/UI 消费)。 */
function summarizeInertia(events) {
  const list = Array.isArray(events) ? events : [];
  if (!list.length) return null;
  let executed = 0;
  let dropped = 0;
  for (const e of list) {
    executed += Number(e && e.executed) || 0;
    dropped += Number(e && e.dropped) || 0;
  }
  return { turns: list.length, executed, dropped };
}

module.exports = {
  isEnabled,
  isInertiaTurn,
  filterExecutableBlocks,
  buildModelReconnectHint,
  buildUserInertiaNotice,
  summarizeInertia,
};
