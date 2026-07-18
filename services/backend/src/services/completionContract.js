'use strict';

// [AI-弱模型·照抄] 本文件是**纯叶子**:零 IO、确定性、绝不抛(坏输入返安全默认)、可单测、
//   关闭即字节回退(门控在调用方 goalStopGate 处施加)。判定/文案全在叶子里,IO 由调用方做。

/**
 * completionContract.js — 纯叶子:从目标文本解析用户预先声明的「完成标准」(completion
 * contract),并据回复里的证据逐条核对。
 * (参考 Hermes Agent v0.18.0「验证」支柱的 completion contracts:提前定义"什么叫完成",
 *  Agent 据证据判断进度。)
 *
 * 与证据门(goalStopGate.claimsVerificationWithoutEvidence)的分工:
 *   - 证据门判「声称验证却*完全*拿不出证据」——粗粒度、对任何目标生效;
 *   - 本叶子判「用户*预先声明了具体标准*,但证据未逐条覆盖」——细粒度、仅当目标含标准时生效。
 * 目标未声明任何标准时 parseCompletionContract 返回空 criteria → 调用方跳过 → 行为不变。
 *
 * 纯叶子契约:零 IO(无 fs/net/process/无参 Date)、确定性(同输入→同输出)、绝不抛。
 */

const _MAX_CRITERIA = 12;        // 上限,防目标里堆一长串把 redrive 文案撑爆
const _MAX_CRITERION_CHARS = 200;
const _MAX_SCAN_LINES = 40;      // 标准段最多向后扫描的行数

// 「完成标准」段的标题信号(中英)。命中后收集其后的条目。
const _CRITERIA_HEADING_RE =
  /(完成标准|验收标准|验收门|验收条件|完成定义|定义完成|完成条件|什么叫完成|怎样算完成|算完成的标准|success\s+criteria|definition\s+of\s+done|acceptance\s+criteria|completion\s+criteria|done\s+when)/i;
// 条目符号(- * • / 数字. 数字) / ①-⑩ / [ ] 复选框)。
const _BULLET_RE = /^\s*(?:[-*•·]|\d+[.)、]|[①②③④⑤⑥⑦⑧⑨⑩]|\[[ xX]?\])\s+/;
// markdown 标题行(用于探测标准段结束)。
const _MD_HEADING_RE = /^\s{0,3}#{1,6}\s+/;

// 「测试类」标准的证据信号(自包含,不跨文件耦合,保叶子独立)。
const _TEST_EVIDENCE_RE =
  /(测试[^。\n]{0,20}?(?:通过|全绿)|全部通过|全绿|单测[^。\n]{0,10}?(?:通过|全绿)|\d+\s*(?:passed|passing|通过)|\d+\s*\/\s*\d+|[✓✔✅]|\bPASS\b|node\s+--test|npm\s+(?:run\s+)?test|\bjest\b|\bpytest\b|go\s+test|cargo\s+test)/i;

// 「检查类」标准:按标准文本里出现的具体检查名,派生对应的证据信号。
const _CHECK_TOKENS = [
  { re: /arch:god/i, ev: /arch:god/i },
  { re: /maintainer|维护映射|维护者/i, ev: /maintainer/i },
  { re: /\blint\b|eslint/i, ev: /\blint\b|eslint/i },
  { re: /node\s*--check|语法检查/i, ev: /node\s+--check/i },
  { re: /守卫|guard/i, ev: /守卫|guard|check-/i },
  { re: /构建|编译|\bbuild\b/i, ev: /构建|编译|\bbuild\b/i },
  { re: /检查|校验|\bcheck\b/i, ev: /检查|校验|\bcheck\b/i },
];

// 收敛到 utils/toStr 单一真源(逐字节委托,调用点不变)
const _str = require('../utils/toStr').toStr;

function _clip(s, n = _MAX_CRITERION_CHARS) {
  const t = _str(s).trim();
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}

function _escapeRe(s) {
  return _str(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 一段文本是否「像一条可执行命令」(用于抓反引号内容 / 判命令类标准)。 */
function _looksLikeCommand(s) {
  const t = _str(s).trim();
  if (!t || t.length > _MAX_CRITERION_CHARS) return false;
  if (/(^|\s)(npm|npx|node|yarn|pnpm|pytest|jest|cargo|go|make|bash|sh|python3?|deno|bun)\b/i.test(t)) return true;
  return /\barch:god\b|\bmaintainer\b|:check\b|(^|\s)--\w/.test(t);
}

/** 把命令文本编成一个宽松匹配其在回复里出现的正则(空白折叠为 \s+)。 */
function _commandPattern(cmd) {
  const norm = _str(cmd).trim().replace(/\s+/g, ' ');
  const escaped = _escapeRe(norm).split(' ').join('\\s+');
  try {
    return new RegExp(escaped, 'i');
  } catch {
    return new RegExp(''); // 兜底:永远匹配(避免坏正则把标准判成永远缺失)
  }
}

/** 从自由文本标准里取若干显著词,任一出现即视为有证据(保守偏向"已满足",避免过度拦截)。 */
function _freeformPattern(text) {
  const toks = _str(text).match(/[A-Za-z_][A-Za-z0-9_.:\-]{3,}|[一-龥]{2,}/g) || [];
  const uniq = [];
  for (const t of toks) {
    if (!uniq.includes(t)) uniq.push(t);
    if (uniq.length >= 5) break;
  }
  if (uniq.length === 0) return new RegExp(''); // 无显著词 → 永远匹配 → 视为满足
  try {
    return new RegExp(uniq.map(_escapeRe).join('|'), 'i');
  } catch {
    return new RegExp('');
  }
}

/**
 * 为一条标准文本派生 { kind, pattern }。kind ∈ test|check|command|freeform。
 * 顺序讲究:test / check 先于 command —— 「arch:god 无超限」这类**散文里提到某检查名**应归 check
 * (证据=该检查名出现),而非当成需逐字命中的整句命令。纯命令(如 `make deploy`)才归 command。
 * @param {string} text
 * @returns {{ kind: string, pattern: RegExp }}
 */
function _deriveEvidencePattern(text) {
  const t = _str(text).trim();
  if (/测试|全绿|单测|回归|\btests?\b|\bjest\b|\bpytest\b|node\s+--test/i.test(t)) {
    return { kind: 'test', pattern: _TEST_EVIDENCE_RE };
  }
  for (const tok of _CHECK_TOKENS) {
    if (tok.re.test(t)) return { kind: 'check', pattern: tok.ev };
  }
  if (_looksLikeCommand(t)) {
    return { kind: 'command', pattern: _commandPattern(t) };
  }
  return { kind: 'freeform', pattern: _freeformPattern(t) };
}

function _stripBullet(line) {
  return _str(line).replace(_BULLET_RE, '').trim();
}

function _pushCriterion(criteria, seen, rawText) {
  // 去掉反引号:让「`npm run maintainer:check` 通过」这类条目文本干净,便于分类与去重。
  const text = _clip(_str(rawText).replace(/`/g, '').trim());
  if (!text) return;
  const key = text.toLowerCase().replace(/\s+/g, ' ');
  if (seen.has(key)) return;
  seen.add(key);
  const { kind, pattern } = _deriveEvidencePattern(text);
  criteria.push({ kind, text, pattern });
}

/**
 * 从目标文本解析完成标准契约。两个来源:
 *   1) 反引号内的命令(任意位置):`npm test`、`arch:god` 等;
 *   2) 「完成标准 / 验收 / definition of done」标题段之后的条目(条目符号行,或段内含可验证信号的行)。
 * 都没有 → 返回空 criteria(调用方据此跳过,行为不变)。绝不抛。
 * @param {string} goalText
 * @returns {{ criteria: Array<{kind,text,pattern}>, hasContract: boolean }}
 */
function parseCompletionContract(goalText) {
  const s = _str(goalText);
  const criteria = [];
  const seen = new Set();

  // 1) 标准段(先解析,便于随后对反引号命令做包含式去重)。
  const lines = s.split(/\r?\n/);
  let headingIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (_CRITERIA_HEADING_RE.test(lines[i])) { headingIdx = i; break; }
  }
  if (headingIdx !== -1) {
    let collected = 0;
    const end = Math.min(lines.length, headingIdx + 1 + _MAX_SCAN_LINES);
    for (let i = headingIdx + 1; i < end; i++) {
      if (criteria.length >= _MAX_CRITERIA) break;
      const line = lines[i];
      const trimmed = _str(line).trim();
      if (!trimmed) {
        if (collected > 0) break; // 已收集到条目后遇空行 → 段结束
        continue;                 // 段与标题间的前导空行 → 跳过
      }
      // 遇到下一个 markdown 标题 或 另一个「标准」标题 → 段结束。
      if (_MD_HEADING_RE.test(line)) break;
      if (collected > 0 && _CRITERIA_HEADING_RE.test(line)) break;
      if (_BULLET_RE.test(line)) {
        _pushCriterion(criteria, seen, _stripBullet(line));
        collected++;
      } else if (collected === 0) {
        // 段首非条目行:仅当它自身含可验证信号(命令/测试/检查)才当作一条标准,
        // 否则视为散文,忽略(不把普通说明误当标准)。
        const { kind } = _deriveEvidencePattern(trimmed.replace(/`/g, ''));
        if (kind !== 'freeform') { _pushCriterion(criteria, seen, trimmed); collected++; }
      } else {
        break; // 条目之间的非条目行 → 段结束
      }
    }
  }

  // 2) 反引号命令(任意位置);若已被某条标准文本包含则跳过,避免重复。
  try {
    const re = /`([^`\n]{1,200})`/g;
    let m;
    while ((m = re.exec(s)) !== null) {
      if (criteria.length >= _MAX_CRITERIA) break;
      const inner = _str(m[1]).trim();
      if (!_looksLikeCommand(inner)) continue;
      const low = inner.toLowerCase();
      const dup = criteria.some((c) => {
        const t = c.text.toLowerCase();
        return t.includes(low) || low.includes(t);
      });
      if (dup) continue;
      _pushCriterion(criteria, seen, inner);
    }
  } catch { /* ignore */ }

  return { criteria, hasContract: criteria.length > 0 };
}

/**
 * 据回复里的证据逐条核对契约。绝不抛;坏正则视为"已满足"(不过度拦截)。
 * @param {string} reply
 * @param {{ criteria: Array<{kind,text,pattern}> }} contract
 * @returns {{ satisfied: Array, missing: Array, ratio: number, allMet: boolean, total: number }}
 */
function matchEvidenceAgainstContract(reply, contract) {
  const s = _str(reply);
  const criteria = contract && Array.isArray(contract.criteria) ? contract.criteria : [];
  const satisfied = [];
  const missing = [];
  for (const c of criteria) {
    // 自由文本(散文)标准无可靠证据信号 → 视为信息性、永不阻塞收尾(只在 redrive 文案里列出参考);
    // 仅可验证类(command/test/check)参与门控,避免因模糊措辞过度拦截。
    if (c && c.kind === 'freeform') { satisfied.push(c); continue; }
    let ok = false;
    try {
      const p = c && c.pattern;
      ok = p instanceof RegExp ? p.test(s) : new RegExp(_str(p), 'i').test(s);
    } catch {
      ok = true; // 坏正则 → 视为满足,绝不因内部错误反而阻止收尾
    }
    (ok ? satisfied : missing).push(c);
  }
  const total = criteria.length;
  return {
    satisfied,
    missing,
    ratio: total === 0 ? 1 : satisfied.length / total,
    allMet: missing.length === 0,
    total,
  };
}

/**
 * 构建「完成标准未逐条覆盖」的再驱动指令。要求模型实际执行缺失标准并粘贴证据后再收尾。
 * @param {object} goal - 活动目标(需 goal.text)
 * @param {Array<{text}>} missing - 尚缺证据的标准
 * @param {object} [opts]
 * @param {string} [opts.userMessage]
 * @returns {string}
 */
function buildContractRedriveMessage(goal, missing, { userMessage } = {}) {
  const text = (goal && goal.text) || '';
  const list = (Array.isArray(missing) ? missing : [])
    .slice(0, _MAX_CRITERIA)
    .map((c, i) => `  ${i + 1}. ${_clip(c && c.text)}`)
    .join('\n');
  return [
    '[SYSTEM: 目标声明了明确的完成标准(completion contract),但本轮回复里缺少对以下标准的**具体证据** —— 现在还不能判定达成',
    '(对齐 Hermes Agent v0.18.0 completion contracts:提前定义"什么叫完成",据证据逐条核对)。',
    `当前目标:「${text}」`,
    '尚缺证据的完成标准:',
    list || '  (无)',
    '请**实际执行**上述每一条,并把证据(命令输出 / 测试通过数 / 退出码 / 文件摘录)原样粘贴;',
    '所有标准都有证据后,再给出完成报告并调用 GoalTool(action=clear) 收尾。',
    userMessage ? `用户原始请求: ${String(userMessage).slice(0, 300)}` : '',
    ']',
  ].filter(Boolean).join('\n');
}

module.exports = {
  parseCompletionContract,
  matchEvidenceAgainstContract,
  buildContractRedriveMessage,
  // 供聚焦单测
  _deriveEvidencePattern,
  _looksLikeCommand,
};
