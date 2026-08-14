'use strict';

/**
 * leafContractGuard.js — 「纯叶子契约」的机器强制单一真源(goal 2026-06-26
 * 「让其它模型维护 khyos 时不要越改越差,预设它们可能的失败点、让它们尽早回头,
 *  并把强模型与弱模型的差距以代码化的形式弥补」)。
 *
 * 背景:本仓有 ~30 个「纯叶子」服务(searchNecessity / multimodalIntentRouter /
 * memoryTier / bugSentinel …),每个文件的头部 docstring 都白纸黑字承诺同一组契约:
 *   - 零 IO(不碰文件系统 / 网络 / 子进程,确定性、可单测);
 *   - env 门控(KHY_* 默认开,关闭即字节回退);
 *   - fail-soft(绝不向调用方抛异常)。
 * 强模型把这些契约内化于心,改动时自然守住;弱模型只读得懂散文、守不住纪律——
 * 「修个 bug」时会顺手 `require('fs')`、把门控删掉、或让 docstring 与代码脱节,
 * 于是纯叶子被悄悄改成不纯,回归在很久以后才爆。本守卫把这些**散文承诺**变成
 * **确定性的机器检查**:谁把纯叶子改不纯,提交时(pre-commit → check:small-model:safety)
 * 立刻被点名挡回。这就是「差距代码化」——契约不再只活在强模型脑子里。
 *
 * 与既有门禁正交互补:
 *   - check-change-safety.js  看改动集合(爆炸半径 / 删除 / 敏感路径);
 *   - check-agent-rules.js    看通用反模式(硬编码端点 / 模糊状态 / 硬超时 kill);
 *   - 本守卫                   看「自声明纯叶子是否仍守住它自己承诺的契约」。
 *
 * 三条规则(零误报是底线,故只取经验证对现存全部叶子零误报的高价值不变量):
 *   1. conflict-marker(error,所有文件):未解决的 VCS 冲突标记。把
 *      「脏树误发布 → 用户远端编译炸」的失败点从发布时再前移到提交时。
 *   2. leaf-io(error,仅自声明纯叶子):真实的 IO require/调用(fs/child_process/
 *      net/http(s)/dns/… 或 execSync/spawn/process.exit)。相对 require(叶子→叶子)放行。
 *   3. leaf-gate-orphan(warning,仅自声明纯叶子):头部 docstring 把某 KHY_* 声明成
 *      本文件门控,但代码里已不再引用它 —— 门控很可能被删,docstring 成了谎言。
 *
 * 检测「本文件是否自声明纯叶子」:标记「纯叶子 / pure leaf」出现在文件**首个块注释**
 * (头部 docstring)内。仅在 `//` 行里**提到**别的叶子(如 toolUseLoop / webSearchService
 * 描述它 require 的叶子依赖)不算自声明,故这些做 IO 的编排器不会被误判。
 *
 * 纯叶子:零 IO、确定性、绝不抛、可单测。env 门控 KHY_LEAF_CONTRACT_GUARD(默认开,
 * 仅显式 0/false/off/no 关闭;关闭后 assessFile 返回空 findings)。本守卫自身遵守它所
 * 强制的契约,且对自己的源码零发现(冲突标记用拼接构造、IO 名只作正则字面量)。
 */

// ── env 门控(默认开,仅 0/false/off/no 关)─────────────────────────────
const OFF = new Set(['0', 'false', 'off', 'no']);
function isEnabled(env) {
  const v = (env || process.env || {}).KHY_LEAF_CONTRACT_GUARD;
  return !(v !== undefined && OFF.has(String(v).trim().toLowerCase()));
}

// ── 纯叶子自声明标记 ────────────────────────────────────────────────
// 仅「提到 / 描述」纯叶子概念不算自声明(否则本守卫 CLI、文档、编排器都会被误判)。
// 真正的自声明把标记与**契约词**紧贴成一句:「纯叶子:零 IO」「(纯叶子,单一真源)」
// 「纯叶子,env 门控」。故判据 = 标记出现在首个块注释内,且其 ±16 字符窗口里有契约词。
const LEAF_MARKER_RE = /纯叶子|pure[\s-]?leaf/gi;
const CONTRACT_TERMS_RE = /零\s*IO|确定性|绝不抛|单一真源|单一来源|env\s*门控|零依赖|零状态|可单测|无副作用|无状态/;
const GLOBAL_CONTRACT_TERMS_RE = /零\s*IO|确定性|绝不抛|单一真源|单一来源|env\s*门控|零依赖|零状态|可单测|无副作用|无状态/g;
// 模块标识符信号:≥3 字符的 ASCII 词(如 `vaultCore`)。出现在标记与契约词之间 =
// 「委派给纯叶子 <模块>(契约)」式描述,而非本文件自声明。
const LEAF_MODULE_IDENT_RE = /[A-Za-z][A-Za-z0-9_]{2,}/;
// 标记后紧跟「空格 + ≥3 字 ASCII 模块名」= 「(委托给)纯叶子 selfEditAdvisory」具名叶子引用。
// 自声明写法是「纯叶子:零 IO」「(纯叶子,单一真源)」——标记后是标点/契约词,不是模块名。
const LEAF_MARKER_TRAILING_MODULE_RE = /^[ \t]+[A-Za-z][A-Za-z0-9_]{2,}/;
const LEAF_ADJ_WINDOW = 16;

// leaf-* 规则(自声明检测 + 零 IO + 门控孤儿)只对「JS 风格块注释」语言成立——
// 纯叶子是 JS/TS/Vue 模块。markdown / json / yaml 等散文文件可能在示例里出现字面
// `/* … */`(如红线文档引用 `require('fs')`、`execSync(...)` 作反面教材),那会让
// firstBlockComment 把一大段散文误当头部 docstring → declaresLeaf 误判 → 红线描述被
// 当成真实 IO 报错。故把 leaf-* 规则限定到真有 `/* */` 块注释语义的代码扩展名;
// 冲突标记规则仍对所有文件生效(见规则 1)。
const LEAF_RULE_EXTS = new Set(['.js', '.cjs', '.mjs', '.ts', '.tsx', '.vue']);

/** 取小写扩展名(含点);无扩展名返回 ''。纯字符串运算,零 IO。 */
function fileExt(relPath) {
  const base = String(relPath || '');
  const slash = Math.max(base.lastIndexOf('/'), base.lastIndexOf('\\'));
  const name = slash >= 0 ? base.slice(slash + 1) : base;
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot).toLowerCase() : '';
}

// 冲突标记:用拼接构造,确保本文件源码里不出现 7 连字符的字面 marker(否则守卫扫
// 自己就误报)。规则要求同一文件**同时**含起始与结束标记,故 markdown 里孤立一个
// `<<<<<<<` 不误报(与 setup.py 的发布守卫同一从严判据)。
const CONFLICT_START = '<'.repeat(7);
const CONFLICT_MID = '='.repeat(7);
const CONFLICT_END = '>'.repeat(7);
const CONFLICT_START_RE = new RegExp('^' + CONFLICT_START + ' ');
const CONFLICT_END_RE = new RegExp('^' + CONFLICT_END + ' ');
const CONFLICT_MARKER_LINE_RE = new RegExp('^(?:' + CONFLICT_START + ' |' + CONFLICT_MID + '$|' + CONFLICT_END + ' )');

// IO require(真实调用形态 `require('fs')`):清晰属于 IO 的核心模块。相对 require
// (`require('./x')`/`require('../x')`,叶子→叶子)与 crypto/path/util 等纯/确定性
// 模块不在此列。源码里这串只作正则字面量(`require\(...`,转义反斜杠),不构成真实调用。
const IO_REQUIRE_RE = /\brequire\(\s*['"](?:node:)?(fs|fs\/promises|child_process|net|http|https|http2|dns|tls|dgram|worker_threads|cluster|readline|repl|inspector|v8|vm)['"]\s*\)/;
// IO 调用(即便模块经别处注入):同步执行 / 进程控制 / 标准流写。
const IO_CALL_RE = /\b(?:execSync|spawnSync|execFileSync|spawn|execFile)\s*\(|\bprocess\.exit\s*\(|\bprocess\.std(?:out|err)\.write\s*\(/;

// 门控自声明关键词(把某 KHY_ 当成本文件门控的信号)。刻意从严,只认强信号,
// 欠拦安全;并排除跨引用上下文(同 / 与 / 参见 / 复用 / see / [[…]])。
const GATE_CLAIM_KEYWORDS = ['门控', '主闸', '开关', 'gate', 'toggle'];
const CROSS_REF_RE = /同\s*$|与\s*$|参见|复用|另见|see\s+$|\[\[/i;
const KHY_TOKEN_RE = /KHY_[A-Z0-9_]+/g;

/**
 * 提取文件首个块注释(头部 docstring)。无块注释返回 ''。
 * @param {string} source
 * @returns {string}
 */
function firstBlockComment(source) {
  const text = String(source || '');
  const start = text.indexOf('/*');
  if (start < 0) return '';
  const end = text.indexOf('*/', start + 2);
  if (end < 0) return text.slice(start); // 未闭合:取到末尾
  return text.slice(start, end + 2);
}

/**
 * 本文件是否自声明为纯叶子:标记出现在首个块注释内,且其 ±16 字符窗口含契约词,
 * **且标记与契约词之间不夹模块标识符**。后一条用于区分真自声明(`(纯叶子,单一真源)`、
 * `单一真源(纯叶子)`——标记与契约词只隔标点/CJK)与「委派给纯叶子 X(契约)」式描述
 * (`委派纯叶子 vaultCore(单一真源)`——中间夹模块名 `vaultCore`)。后者只是「提到/描述」
 * 别处的叶子,本文件自身做 IO/打印,绝不该被套上叶子契约。
 * @param {string} source
 * @returns {boolean}
 */
function declaresLeaf(source) {
  const header = firstBlockComment(source);
  if (!header) return false;
  let m;
  LEAF_MARKER_RE.lastIndex = 0;
  while ((m = LEAF_MARKER_RE.exec(header)) !== null) {
    const mStart = m.index;
    const mEnd = mStart + m[0].length;
    const a = Math.max(0, mStart - LEAF_ADJ_WINDOW);
    const b = Math.min(header.length, mEnd + LEAF_ADJ_WINDOW);
    // 标记之后:契约词与标记之间不得夹模块标识符(`纯叶子 vaultCore(单一真源)` 被排除)。
    const after = header.slice(mEnd, b);
    const am = CONTRACT_TERMS_RE.exec(after);
    if (am && !LEAF_MODULE_IDENT_RE.test(after.slice(0, am.index))) return true;
    // 标记之后紧跟「空格 + 模块名」= 「委托给纯叶子 selfEditAdvisory」式委派引用(marker
    // 指向别处的具名叶子),非本文件自声明。这补齐了 after 分支「模块名夹在 marker 与契约词
    // 之间」的对称缺口——委派时模块名可能落在 marker 之后而非之间。跳过本次 marker 命中。
    if (LEAF_MARKER_TRAILING_MODULE_RE.test(header.slice(mEnd))) continue;
    // 标记之前:同理(`单一真源(纯叶子)`——契约词在前,中间只有标点 → 真自声明)。
    const before = header.slice(a, mStart);
    let bm = null;
    GLOBAL_CONTRACT_TERMS_RE.lastIndex = 0;
    for (let g; (g = GLOBAL_CONTRACT_TERMS_RE.exec(before)) !== null; ) bm = g;
    if (bm && !LEAF_MODULE_IDENT_RE.test(before.slice(bm.index + bm[0].length))) return true;
  }
  return false;
}

/**
 * 逐行分类:返回每行 { no, text, isComment, code }。code 为剥除注释后的代码片段
 * (用于在「非注释代码」中检索 require / 门控 token,避免注释里的字样误判)。
 * 简单状态机:跟踪块注释开合;不做字符串感知(对本守卫用途足够且偏保守)。
 * @param {string} source
 */
function classifyLines(source) {
  const lines = String(source || '').split(/\r?\n/);
  const out = [];
  let inBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    let code = '';
    let sawCode = false;
    let j = 0;
    while (j < raw.length) {
      if (inBlock) {
        const close = raw.indexOf('*/', j);
        if (close < 0) { j = raw.length; break; }
        j = close + 2;
        inBlock = false;
        continue;
      }
      const lineComment = raw.indexOf('//', j);
      const blockOpen = raw.indexOf('/*', j);
      // 取最近的注释起点
      let next = -1;
      let isLine = false;
      if (lineComment >= 0 && (blockOpen < 0 || lineComment < blockOpen)) { next = lineComment; isLine = true; }
      else if (blockOpen >= 0) { next = blockOpen; isLine = false; }
      if (next < 0) { code += raw.slice(j); j = raw.length; break; }
      code += raw.slice(j, next);
      if (isLine) { j = raw.length; break; }
      inBlock = true;
      j = next + 2;
    }
    sawCode = code.trim().length > 0;
    out.push({ no: i + 1, text: raw, code, isComment: !sawCode });
  }
  return out;
}

/** 收集整份源码剥注释后的代码文本(用于「token 是否在代码中出现」)。 */
function codeOnlyText(lineInfos) {
  return lineInfos.map(l => l.code).join('\n');
}

/**
 * 从头部 docstring 抽取「被本文件声明为门控」的 KHY_ token。
 * @param {string} header  首个块注释文本
 * @returns {string[]}  去重的 token 列表
 */
function claimedGateTokens(header) {
  const text = String(header || '');
  if (!text) return [];
  const tokens = new Set();
  let m;
  KHY_TOKEN_RE.lastIndex = 0;
  while ((m = KHY_TOKEN_RE.exec(text)) !== null) {
    const token = m[0];
    const idx = m.index;
    // 窗口:token 前后 24 字符内出现强门控关键词,且不在跨引用上下文中。
    const before = text.slice(Math.max(0, idx - 24), idx);
    const after = text.slice(idx + token.length, idx + token.length + 24);
    const window = before + ' ' + after;
    const hasKeyword = GATE_CLAIM_KEYWORDS.some(k => window.includes(k));
    if (!hasKeyword) continue;
    if (CROSS_REF_RE.test(before)) continue; // 「同 [[X]]」「复用 …」等跨引用,跳过
    tokens.add(token);
  }
  return [...tokens];
}

/**
 * 评估单个文件,返回契约违规 findings。纯函数:零 IO、绝不抛。
 * @param {object} args
 * @param {string} args.relPath  仓库相对路径(仅用于 finding 展示)
 * @param {string} args.source   文件全文
 * @param {object} [args.env]
 * @returns {{ findings: Array<{severity:'error'|'warning', rule:string, line:number, message:string, snippet:string}> }}
 */
function assessFile({ relPath = '', source = '', env } = {}) {
  if (!isEnabled(env)) return { findings: [] };
  const findings = [];
  const text = String(source || '');
  if (!text) return { findings };

  const lineInfos = classifyLines(text);

  // ── 规则 1:冲突标记(所有文件)──────────────────────────────────
  const hasStart = lineInfos.some(l => CONFLICT_START_RE.test(l.text));
  const hasEnd = lineInfos.some(l => CONFLICT_END_RE.test(l.text));
  if (hasStart && hasEnd) {
    for (const l of lineInfos) {
      if (CONFLICT_MARKER_LINE_RE.test(l.text)) {
        findings.push({
          severity: 'error',
          rule: 'conflict-marker',
          line: l.no,
          message: '未解决的版本控制冲突标记。先解决冲突再提交 —— 它会被原样打进发布包并让远端编译失败。',
          snippet: l.text.slice(0, 80),
        });
      }
    }
  }

  // 仅自声明纯叶子的文件才适用 leaf-* 规则。markdown/json/yaml 等散文文件即便含
  // 字面 `/* */` 示例也不参评(否则红线文档引用 IO 反例会被误报)——见 LEAF_RULE_EXTS。
  if (!LEAF_RULE_EXTS.has(fileExt(relPath))) return { findings };
  if (!declaresLeaf(text)) return { findings };

  const header = firstBlockComment(text);
  const codeText = codeOnlyText(lineInfos);

  // ── 规则 2:零 IO(error)─────────────────────────────────────────
  for (const l of lineInfos) {
    if (l.isComment || !l.code) continue;
    if (IO_REQUIRE_RE.test(l.code) || IO_CALL_RE.test(l.code)) {
      findings.push({
        severity: 'error',
        rule: 'leaf-io',
        line: l.no,
        message: '纯叶子里出现 IO(文件系统 / 网络 / 子进程 / 进程控制)。叶子必须零 IO、确定性、可单测 —— 把 IO 留在调用方,纯逻辑只接收已读入的数据。这正是契约要拦的「越改越不纯」。',
        snippet: l.text.trim().slice(0, 100),
      });
    }
  }

  // ── 规则 3:门控孤儿(warning)────────────────────────────────────
  for (const token of claimedGateTokens(header)) {
    const inCode = new RegExp('\\b' + token + '\\b').test(codeText);
    if (!inCode) {
      findings.push({
        severity: 'warning',
        rule: 'leaf-gate-orphan',
        line: 1,
        message: `头部 docstring 把 ${token} 声明为本文件门控,但代码里已不再引用它 —— 门控可能被删,功能被静默改成无法关闭/无法字节回退。请恢复门控,或同步更新 docstring。`,
        snippet: token,
      });
    }
  }

  return { findings };
}

module.exports = {
  isEnabled,
  declaresLeaf,
  firstBlockComment,
  fileExt,
  classifyLines,
  claimedGateTokens,
  assessFile,
};
