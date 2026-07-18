'use strict';

/**
 * memoryOpsNotice —— 纯叶子 (pure leaf):把「写记忆 / 召回记忆」这两个动作渲染成
 *   一行**面向用户**的确定性告知语的单一真源。
 *
 * 契约 (CONTRACT):零 IO(不碰 fs / 时钟 / 子进程 / 网络;所有事实由调用方读入后作参数
 *   传进来)、确定性(同入参恒定同输出)、绝不抛(任何畸形入参一律吞成空串 '')、单一真源
 *   (写/召回告知语的措辞与门控只在这里派生)、env 门控默认开(`KHY_MEMORY_NOTICE`,仅
 *   {0,false,off,no} 关闭;关闭即两个 format 均返 ''、上层不 onStatus =「字节回退」到
 *   静默行为)。fail-soft:success 非真、无有效 name、空召回一律返 '' 不打扰用户。
 *
 * 背景(闭合的断桥):Khy 有两条**静默**的记忆动作,违反「写记忆和回忆时明确告知用户」:
 *   1) 确定性 NL 捕获 `_maybeAutoSaveMemory`(cli/ai.js)写入记忆后,返回值在
 *      aiChatCore.js 被直接丢弃,用户永远不知道刚被写了一条记忆(死字段)。
 *   2) 主动/预热/相关三段召回把记忆折进系统提示,`filenames` 只用于 dedup(_memSurfaced),
 *      从不面向用户播报「回忆了什么」。
 *   本叶子把这两个动作各渲成一行 onStatus 告知,消费上面两个被丢弃/半死的信号。
 *
 * 诚实边界:
 *   - 写告知区分落地位置——`ephemeral`(短期会话记忆,session 结束即忘)标「本会话」,
 *     否则标「已落盘」;`action==='skip'|'skip-duplicate'` 标「已存在(未重复写入)」,
 *     绝不谎报「新写入」。
 *   - 召回告知只播报**具名可核**的召回文件(_memSurfaced 里的),数量截断到前 N 个 + 「等 M 条」,
 *     绝不为未具名的相关块编造文件名(under-claim 是诚实的)。
 *   - 只告知,不改变任何记忆的写入/召回决策(纯装饰层)。
 */

/** 门控 falsy 词集(与仓内 sibling 门约定一致:大小写 / 首尾空白归一后比较)。 */
const _OFF = new Set(['0', 'false', 'off', 'no']);

/** 召回告知里最多逐一点名的文件数;超出的以「等 N 条」概述。 */
const _RECALL_NAME_CAP = 3;

/** 记忆类型 → 面向用户的中文标签(单一真源;未知类型回退通用「记忆」)。 */
const _TYPE_LABEL = Object.freeze({
  user: '身份',
  feedback: '反馈',
  project: '项目',
  reference: '参考',
});

/**
 * 门控:默认开。仅 env ∈ {0,false,off,no}(归一后)关闭。
 * @returns {boolean}
 */
function isNoticeEnabled() {
  const raw = process.env.KHY_MEMORY_NOTICE;
  if (raw == null) return true;
  return !_OFF.has(String(raw).trim().toLowerCase());
}

/** 从 .md 文件名派生一个精简可读的记忆名(去扩展名;绝不抛)。 */
function _prettyName(filename) {
  const s = String(filename == null ? '' : filename).trim();
  if (!s) return '';
  return s.replace(/\.md$/i, '');
}

/**
 * 渲染「写记忆」告知语。
 * @param {object} result - `_maybeAutoSaveMemory` 的返回:期望 {kind:'memory', success,
 *   name, type, tier, action, ephemeral}。非 memory 种类 / 非成功 / 无 name → ''。
 * @returns {string} 告知语,或 ''(门关 / 畸形 / 不该告知)。
 */
function formatWriteNotice(result) {
  try {
    if (!isNoticeEnabled()) return '';
    if (!result || typeof result !== 'object') return '';
    if (result.kind !== 'memory') return '';        // 指令提案走别的评审队列,不在此告知
    if (result.success !== true) return '';
    const name = String(result.name == null ? '' : result.name).trim();
    if (!name) return '';

    const typeLabel = _TYPE_LABEL[result.type] || '记忆';
    const action = String(result.action == null ? '' : result.action);
    // 已存在 / 去重命中:诚实标注未新写入。
    if (action === 'skip' || action === 'skip-duplicate') {
      return `🧠 记忆已存在（未重复写入）：${typeLabel}·${name}`;
    }
    // 落地位置:短期会话记忆(session 结束即忘) vs 落盘。
    const where = result.ephemeral === true ? '本会话' : '已落盘';
    return `🧠 已写入${typeLabel}记忆（${where}）：${name}`;
  } catch {
    return '';
  }
}

/**
 * 渲染「召回记忆」告知语。
 * @param {Array<string>|Set<string>} filenames - 本轮**具名**召回并注入提示的记忆文件名集合
 *   (即 aiChatCore 的 _memSurfaced)。空 / 非可迭代 → ''。
 * @returns {string} 告知语,或 ''(门关 / 畸形 / 无召回)。
 */
function formatRecallNotice(filenames) {
  try {
    if (!isNoticeEnabled()) return '';
    let list = [];
    if (Array.isArray(filenames)) list = filenames;
    else if (filenames instanceof Set) list = Array.from(filenames);
    else if (filenames && typeof filenames[Symbol.iterator] === 'function') list = Array.from(filenames);
    else return '';

    const names = [];
    for (const fn of list) {
      const p = _prettyName(fn);
      if (p) names.push(p);
    }
    if (names.length === 0) return '';

    const shown = names.slice(0, _RECALL_NAME_CAP);
    const rest = names.length - shown.length;
    const tail = rest > 0 ? ` 等 ${names.length} 条` : '';
    return `🧠 召回 ${names.length} 条相关记忆：${shown.join('、')}${tail}`;
  } catch {
    return '';
  }
}

module.exports = {
  isNoticeEnabled,
  formatWriteNotice,
  formatRecallNotice,
  _TYPE_LABEL,
  _RECALL_NAME_CAP,
};
