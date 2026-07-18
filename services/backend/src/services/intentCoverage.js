'use strict';

/**
 * intentCoverage.js — 「答得没接住意图」收尾回核(纯叶子,零 IO / env / state)。
 *
 * 背景:`buildIntentAssuranceDirective`(khyUpgradeRuntime)把用户逐字点名的高精度
 * 诉求(引用短语 / 文件路径 / "另外…还有…" 尾随子请求)抽进系统提示框,但模型回答
 * 出来之后**从不回核**——没有任何一步检查最终回复是否真把这些点名诉求接住了。
 * 这正是「答得没接住意图」最直接的根:漏掉一个子请求、对某个被点名的文件只字不提。
 *
 * 本模块在收尾(模型自认完工、无工具调用)时,用同一批结构化锚点回核最终回复:
 * 仅当某个**用户明确点名的具体诉求**在回复(及已落地的修改文件名)里**完全没被
 * 提及**时,才判定「遗漏」并产一次性补全提示。
 *
 * ── 设计铁律:零假阳性 ───────────────────────────────────────────────
 * 误报 = 无谓追问 = 更不顺滑,危害大于漏报。所以只认三类**高精度、几乎不可能被
 * 改写**的诉求,其余(泛词、裸中文名词)一律不检:
 *   1) 引号内字面(中英引号)—— 用户引用即要求逐字保留,模型理应回显。
 *   2) 文件路径 / 带扩展名的文件名 —— 用户点名某文件,回复理应提及(按全名或基名)。
 *   3) 代码风格标识符(含下划线 / 数字 / 驼峰,长度≥5)—— 不会被自然语言改写。
 * 「提及」= 该 token 作为子串出现在 (回复 + 已修改文件名) 任意处即视为接住——
 * 哪怕模型说的是「config.json 我没动,因为…」也算接住了(它意识到了这个诉求)。
 * 我们只抓**彻底沉默**这种最强的「漏接」信号。
 *
 * 纯函数,可独立单测。开关与接缝在 toolUseLoop 侧。
 */

// 太泛、单独出现不足以判定"被遗漏"的 token —— 命中即跳过,绝不据此追问。
const GENERIC_TOKENS = new Set([
  'readme', 'index', 'main', 'test', 'tests', 'data', 'config', 'file',
  'code', 'src', 'app', 'util', 'utils', 'lib', 'tmp', 'temp', 'log', 'logs',
]);

// 文件路径抽取正则的两种形态:
//   - 有界(默认):路径分量长度上限 255(文件系统单分量硬上限),避免
//     `(?:[…]+[\/\\])+[…]+` 里贪婪 `+` 段在超长无分隔字符串(如粘贴的乱码)上
//     发生灾难性回溯(O(n²) → 事件循环挂死 = DoS)。对一切真实路径逐字节等价。
//   - 传统(门控关闭时的字节回退):无界 `+`,保留历史行为。
// 见 assessIntentCoverage 的 pathRedosGuard 选项(接缝在 toolUseLoop)。
const PATH_RE_BOUNDED = /(?:[A-Za-z0-9_.\-]{1,255}[\/\\])+[A-Za-z0-9_.\-]{1,255}|\b[A-Za-z0-9_\-]+\.[A-Za-z0-9]{1,8}\b/g;
const PATH_RE_LEGACY = /(?:[A-Za-z0-9_.\-]+[\/\\])+[A-Za-z0-9_.\-]+|\b[A-Za-z0-9_\-]+\.[A-Za-z0-9]{1,8}\b/g;

// 收敛到 utils/toLowerCaseSafe 单一真源(逐字节委托,调用点不变)
const _norm = require('../utils/toLowerCaseSafe');

/**
 * 从一段文本里抽出"高精度可检诉求"。返回 [{ label, keys[] }]:
 *  - label:展示给模型的人读片段;
 *  - keys:用于在干草堆里做子串命中的(已小写)候选形式(如路径全名 + 基名)。
 * 仅抽引用字面 / 文件路径 / 代码标识符三类,其余忽略(见铁律)。
 *
 * @param {string} text
 * @param {boolean} [pathRedosGuard=true] 有界路径正则(默认开,防灾难性回溯);
 *   传 false 使用历史无界正则(字节回退,重新暴露 O(n²) DoS)。
 */
function _checkableFromText(text, pathRedosGuard = true) {
  const raw = String(text == null ? '' : text);
  const reqs = [];
  const seen = new Set();
  const add = (label, keys) => {
    const norm = keys.map(_norm).filter(Boolean).filter((k) => !GENERIC_TOKENS.has(k));
    if (!norm.length) return;
    const sig = norm.join('|');
    if (seen.has(sig)) return;
    seen.add(sig);
    reqs.push({ label: String(label || '').trim() || norm[0], keys: norm });
  };

  let m;

  // 1) 引号内字面(中英文引号)。最强信号:用户引用 → 要求逐字保留。
  const quoteRe = /[「『“"'`]([^「『”"'`\n]{2,60})[」』”"'`]/g;
  while ((m = quoteRe.exec(raw)) !== null) {
    const lit = m[1].trim();
    if (lit.length >= 2) add(lit, [lit]);
  }

  // 2) 文件路径 / 带扩展名的文件。按全名 + 基名两形式命中。先记录命中跨度,
  //    随后从副本里抹掉,避免第 3 步标识符扫描把路径的词干(如 a_b.js → a_b)
  //    当成另一条诉求重复上报。
  const pathRe = pathRedosGuard
    ? new RegExp(PATH_RE_BOUNDED.source, PATH_RE_BOUNDED.flags)
    : new RegExp(PATH_RE_LEGACY.source, PATH_RE_LEGACY.flags);
  let rawNoPaths = raw;
  while ((m = pathRe.exec(raw)) !== null) {
    const tok = m[0];
    const base = tok.split(/[\/\\]/).pop();
    add(tok, base && base !== tok ? [tok, base] : [tok]);
    rawNoPaths = rawNoPaths.split(tok).join(' ');
  }

  // 3) 代码风格标识符:含下划线 / 数字,或驼峰大小写混排,长度≥5。
  const identRe = /\b[A-Za-z][A-Za-z0-9_]{4,}\b/g;
  while ((m = identRe.exec(rawNoPaths)) !== null) {
    const id = m[0];
    const codey = /[_0-9]/.test(id) || (/[a-z]/.test(id) && /[A-Z]/.test(id));
    if (codey) add(id, [id]);
  }

  return reqs;
}

// 回复看起来是在向用户**反问 / 澄清**(意图框规则 #5:多目标不清先问一句)。
// 此时模型是有意暂停而非漏接 —— 绝不追问。
function _looksLikeClarification(reply) {
  const r = String(reply || '').trim();
  if (!r) return false;
  if (/[?？]\s*$/.test(r)) return true;
  return /(请问|请先确认|需要我先|你是想|是否需要|哪一个|澄清一下|which (one|of)|could you clarify|do you want me to|should i)\b/i.test(r);
}

/**
 * assessIntentCoverage —— 回核最终回复是否接住了用户点名的高精度诉求。
 *
 * @param {object} input
 *   - reply:模型最终回复文本。
 *   - rawMessage:用户原始消息(干净原文,用于抽引用字面)。
 *   - anchors:detailAnchors(buildIntentAssuranceDirective 已抽)。
 *   - tailDetails:尾随子请求子句("另外/还有/also…")。
 *   - extraCoveredText:额外算作"已接住"的上下文(如已修改文件名、工具名),
 *       防止"模型用工具改了 config.json 但 prose 没回显文件名"的假阳性。
 * @returns {{ shouldNudge:boolean, missing:Array<{label,keys}>, checked:number }}
 */
function assessIntentCoverage(input = {}) {
  const reply = String(input && input.reply != null ? input.reply : '');
  const rawMessage = String(input && input.rawMessage != null ? input.rawMessage : '');
  const anchors = Array.isArray(input && input.anchors) ? input.anchors : [];
  const tailDetails = Array.isArray(input && input.tailDetails) ? input.tailDetails : [];
  const extraCoveredText = String(input && input.extraCoveredText != null ? input.extraCoveredText : '');
  // 有界路径正则默认开;调用方(toolUseLoop 接缝)可显式传 false 走字节回退。
  const pathRedosGuard = input && input.pathRedosGuard === false ? false : true;

  const empty = { shouldNudge: false, missing: [], checked: 0 };
  if (!reply.trim()) return empty;
  if (_looksLikeClarification(reply)) return empty;

  // 汇总可检诉求:原文里的引用字面 + 各 anchor 内的高精度 token + 尾随子句内的高精度 token。
  const reqs = [];
  const seenSig = new Set();
  const collect = (list) => {
    for (const r of list) {
      const sig = r.keys.join('|');
      if (seenSig.has(sig)) continue;
      seenSig.add(sig);
      reqs.push(r);
    }
  };
  collect(_checkableFromText(rawMessage, pathRedosGuard));
  for (const a of anchors) collect(_checkableFromText(a, pathRedosGuard));
  for (const t of tailDetails) collect(_checkableFromText(t, pathRedosGuard));

  if (reqs.length === 0) return empty;

  // 干草堆:回复 + 额外已接住上下文(已改文件名 / 工具名)。
  const haystack = _norm(`${reply}\n${extraCoveredText}`);
  const missing = reqs.filter((r) => !r.keys.some((k) => haystack.includes(k)));

  if (missing.length === 0) return { shouldNudge: false, missing: [], checked: reqs.length };

  return {
    shouldNudge: true,
    missing: missing.slice(0, 4),
    checked: reqs.length,
  };
}

/**
 * buildIntentCoverageNudge —— 把遗漏诉求拼成一次性补全提示(喂模型,非用户可见)。
 * 精确点名缺失项,要求补处理或一句说明跳过原因,且勿重复已答。
 */
function buildIntentCoverageNudge(missing) {
  const items = (Array.isArray(missing) ? missing : []).filter(Boolean);
  if (!items.length) return '';
  const bullet = items
    .map((m, i) => `${i + 1}. ${String((m && m.label) || (m && m.keys && m.keys[0]) || '').slice(0, 80)}`)
    .join('\n');
  return [
    '[SYSTEM: 用户在请求里明确点到了下面这些,但你的回复似乎没接住(完全没提到):',
    bullet,
    '请补上对这些点的处理;如果其中某项是有意跳过的,各用一句话说明原因。',
    '不要重复已经答好的部分,只补缺口。]',
  ].join('\n');
}

module.exports = {
  assessIntentCoverage,
  buildIntentCoverageNudge,
  // 内部导出供测试。
  _checkableFromText,
  _looksLikeClarification,
};
