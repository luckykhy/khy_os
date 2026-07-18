'use strict';

/**
 * crossBranchSynthesis.js — 跨支综合的纯叶子单一真源(零 IO·确定性·绝不抛)。
 *
 * 背后逻辑(学自 Stello «把线性对话炸开成一张网» 的收口):一张会话森林里,各分支各自
 * 探索一个方向、各自攒下 memory(外向摘要)与 insight。**跨支综合**= 让一次反思读遍**所有**
 * 分支的 digest,产出:① 一段「根综合」(整张网到目前为止学到了什么、哪些分支冲突/互补、
 * 哪些洞见可复用)②给**每个**分支回写一条一次性 insight(把别支的相关发现「投递」过去)。
 *
 * 这一层刻意拆成两个**确定性纯函数**(零 LLM):
 *   - planSynthesis(digests)  → {prompt, targetIds}:确定性拼装提示串 + 待回写节点 id 集。
 *   - applySynthesis(raw, digests) → {perNodeInsight, rootSynthesis}:确定性解析模型回文。
 * 真正调用模型(llmGenerate)与写盘(putInsight/putMemory)在薄壳 sessionForestService;
 * 无模型/离线 → 薄壳诚实「综合不可用」,绝不伪造(对齐 khy Tier-A 诚实降级)。
 *
 * 契约 (CONTRACT): 零 IO、确定性、绝不抛、无副作用;一切经入参注入,绝不读 process.env
 * (gate 函数除外,仅读 env 形参)、绝不触文件/Date/crypto/child_process。仅依赖语言内置。
 *
 * 注意:本文件刻意不在注释里书写 require-调用样式,避免架构债扫描器把它当幽灵依赖。零依赖。
 */

const FALSY = new Set(['0', 'false', 'off', 'no']);

const SYNTH_MARKER = '[[SYNTHESIS]]';
const NODE_MARKER_RE = /^\[\[NODE\s+([^\]]+)\]\]\s*$/;

/**
 * 门控:KHY_CROSS_BRANCH_SYNTHESIS 默认开。falsy(0/false/off/no/空)→ 关。大小写不敏感 + trim。
 * @param {object} [env]
 * @returns {boolean}
 */
function synthesisEnabled(env) {
  const e = env || {};
  const raw = e.KHY_CROSS_BRANCH_SYNTHESIS;
  if (raw === undefined || raw === null) return true;
  return !FALSY.has(String(raw).trim().toLowerCase());
}

// 收敛到 utils/toStr 单一真源(逐字节委托,调用点不变)
const _str = require('../utils/toStr').toStr;

// 收敛到 utils/truncateEllipsis 单一真源(逐字节/语义等价委托,调用点不变)
const _truncate = require('../utils/truncateEllipsis');

/**
 * 确定性拼装跨支综合提示串。读遍各分支 digest 的 memory/insight,要求模型按**严格分节标记**
 * 输出根综合 + 每节点一条 insight,便于 applySynthesis 零歧义解析。
 *
 * @param {Array<{id, label?, status?, memory?, insight?}>} digests
 * @returns {{prompt:string, targetIds:string[]}}
 *   - prompt：发给 llmGenerate 的完整提示(digests 为空 → 仍返回结构完整但空 body 的提示)。
 *   - targetIds：所有合法节点 id(供薄壳逐个 putInsight + 校验解析回文里的 id)。
 */
function planSynthesis(digests) {
  const list = Array.isArray(digests) ? digests : [];
  const targetIds = [];
  const blocks = [];
  for (const d of list) {
    if (!d || typeof d !== 'object') continue;
    const id = _str(d.id);
    if (!id) continue;
    targetIds.push(id);
    const label = _truncate(d.label, 60);
    const status = _str(d.status);
    const memory = _truncate(d.memory, 600);
    const insight = _truncate(d.insight, 400);
    blocks.push([
      `[[NODE ${id}]]`,
      `标签:${label}${status ? `(${status})` : ''}`,
      memory ? `memory(外向摘要):${memory}` : 'memory:(空)',
      insight ? `insight(待读):${insight}` : 'insight:(空)',
    ].join('\n'));
  }

  const prompt = [
    '你是一张「会话拓扑网」的综合者。下面是这张网上**所有分支**各自攒下的 digest',
    '(每个分支一段:标签 / memory 外向摘要 / 待读 insight)。请通读后产出两部分:',
    '',
    '1) 一段「根综合」:这张网到目前为止学到了什么、哪些分支结论冲突或互补、哪些洞见可被复用。',
    '2) 给**每个**分支回写一条简短 insight:把**其它**分支里与它相关的发现「投递」给它',
    '   (≤3 行;若某分支无可投递的跨支信息,就写一句它当前的下一步建议)。',
    '',
    '严格按以下格式输出(标记必须逐字一致,绝不增删):',
    SYNTH_MARKER,
    '<根综合文本>',
    '[[NODE <分支id>]]',
    '<给该分支的 insight>',
    '[[NODE <分支id>]]',
    '<给该分支的 insight>',
    '… 每个分支一段 …',
    '绝不包含密钥/令牌。',
    '',
    '=== 各分支 digest ===',
    blocks.length ? blocks.join('\n\n') : '(当前网中暂无分支)',
  ].join('\n');

  return { prompt, targetIds };
}

/**
 * 确定性解析模型回文 → {perNodeInsight:{id:text}, rootSynthesis}。
 *
 * 解析规则:按行扫描,`[[SYNTHESIS]]` 起的段归 rootSynthesis;`[[NODE <id>]]` 起的段归
 * perNodeInsight[id](仅当 id ∈ digests 的合法集,未知 id 段丢弃,绝不臆造节点)。
 *
 * Fail-soft:若回文里**找不到任何标记**(模型没按格式来)→ 退化为「整段进根综合」
 * (rootSynthesis = 整个 rawText.trim()),perNodeInsight 为空。绝不抛。
 *
 * @param {string} rawText
 * @param {Array<{id}>} digests
 * @returns {{perNodeInsight: Object<string,string>, rootSynthesis: string}}
 */
function applySynthesis(rawText, digests) {
  const perNodeInsight = Object.create(null);
  // 防呆:只解析字符串(llmGenerate.content 恒为串);非串 → 空结果,绝不把 "42" 之类当综合。
  if (typeof rawText !== 'string') {
    return { perNodeInsight, rootSynthesis: '' };
  }
  const text = rawText;
  const known = new Set();
  for (const d of (Array.isArray(digests) ? digests : [])) {
    if (d && d.id != null) known.add(_str(d.id));
  }

  let rootSynthesis = '';

  const lines = text.split('\n');
  let mode = null;   // 'root' | 'node'
  let curNodeId = null;
  let buf = [];
  let sawMarker = false;

  const flush = () => {
    const body = buf.join('\n').trim();
    if (mode === 'root') {
      rootSynthesis = body;
    } else if (mode === 'node' && curNodeId && known.has(curNodeId)) {
      // 同 id 多段 → 后段覆盖(确定性)。
      perNodeInsight[curNodeId] = body;
    }
    buf = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === SYNTH_MARKER) {
      flush();
      mode = 'root';
      curNodeId = null;
      sawMarker = true;
      continue;
    }
    const nm = trimmed.match(NODE_MARKER_RE);
    if (nm) {
      flush();
      mode = 'node';
      curNodeId = nm[1].trim();
      sawMarker = true;
      continue;
    }
    buf.push(line);
  }
  flush();

  // Fail-soft:没有任何标记 → 整段当根综合。
  if (!sawMarker) {
    rootSynthesis = text.trim();
  }

  return { perNodeInsight, rootSynthesis };
}

module.exports = {
  synthesisEnabled,
  planSynthesis,
  applySynthesis,
  SYNTH_MARKER,
};
