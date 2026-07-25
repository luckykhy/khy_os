'use strict';

/**
 * claimReconciler.js — 正文矛盾核对（DESIGN-ARCH-047 PHASE 4）。
 *
 * 威胁：经外部 agent 中转的助手**正文**可能夹带伪造的动作声称（「我已删库 / 测试全过 /
 * 已部署」）而实际从未发生对应工具调用 —— 即「夹带伪造」。
 *
 * 本模块**确定性**地把中转正文里的动作声称与本地 `toolCallLog` 交叉核对：用一份**版本化的
 * 中英双语「动词→工具族」allow-list 词库**（纯正则/关键词，**绝无模型调用**）抽取声称，
 * 逐条查本地日志是否有同族**成功**工具；缺/失败 → 记一条矛盾 `{claim, expectedTool}`。
 *
 * 姿态：**fail-OPEN** —— 仅咨询性。任何异常/畸形输入 → 返回空矛盾，绝不阻断 turn、绝不改
 * 模型正文，只把结果注入 `_khyTrace.contradictions` 供投影渲染 `⚠ unverified claim`。
 * 只应对 producer != khy-local 的正文跑（由调用方门控），不误报本地正文。
 */

const LEXICON_VERSION = 1;

// ── 否定守卫(KHY_CLAIM_NEGATION_GUARD·默认开)─────────────────────────────────
// 缺陷:动作族关键词只匹动词本身(如 edit 族 `修改了?(文件|代码)?`),对紧贴其前的
// **否定词**视而不见 —— khyos 收尾小结的标准样板「未修改任何文件。」里的「修改」被当成
// 「改了文件」的声称,反去索要 Edit 记录 → 每个只读/纯命令轮都误报「动作声称对不上工具
// 记录」,自毁「确定性复核」的可信度。本守卫在判定声称前,若动词紧邻否定(未/没有/无需/
// 不/别 … / not/never/without …),即认定这是「**没**做该动作」的陈述,跳过不计为声称。
// 与本模块「零假阳性优先(宁可漏报,绝不误报)」姿态一致:否定邻近即倾向不报。
// 门控关(0/false/off/no)→ _firstUnnegatedMatch 退化为原 `re.exec` 首匹配,逐字节回退。
const _NEG_OFF = new Set(['0', 'false', 'off', 'no']);
function _isNegationGuardEnabled(env) {
  try {
    const v = (env || process.env || {}).KHY_CLAIM_NEGATION_GUARD;
    return !(v !== undefined && _NEG_OFF.has(String(v).trim().toLowerCase()));
  } catch { return true; }
}

// 动词紧邻的单字否定(未/没/无/毋/勿/别/不);多字否定词在稍宽窗口内(没有/无需/尚未…);
// 英文否定在动词前 ~16 字符内(the file was not modified / never / without …)。
const _NEG_ADJ_RE = /(未|没|无|無|毋|勿|别|不)$/;
const _NEG_NEAR_RE = /(没有|无需|无须|无法|尚未|从未|并未|毫无|未曾|未能)/;
const _NEG_EN_RE = /\b(no|not|never|without|nothing|none|isn't|wasn't|weren't|didn't|don't|doesn't|won't|can't|cannot|couldn't|shouldn't)\b/i;

/** 该声称匹配处的动词是否被紧邻否定(是 → 非声称,应跳过)。 */
function _isNegatedClaim(text, idx) {
  try {
    if (typeof text !== 'string' || !(idx >= 0)) return false;
    const adj = text.slice(Math.max(0, idx - 1), idx);        // 紧贴动词的 1 个字
    if (_NEG_ADJ_RE.test(adj)) return true;                   // 未修改 / 没删除 / 不部署
    const near = text.slice(Math.max(0, idx - 4), idx);       // 稍宽窗口的多字否定
    if (_NEG_NEAR_RE.test(near)) return true;                 // 没有修改 / 无需修改 / 尚未提交
    const en = text.slice(Math.max(0, idx - 16), idx);        // 英文否定在动词前若干词
    if (_NEG_EN_RE.test(en)) return true;
    return false;
  } catch { return false; }
}

/**
 * 找该族第一处**非否定**声称。门控关时退化为原 `re.exec(text)` 首匹配(逐字节回退)。
 * 用全局克隆迭代,绝不改动 CLAIM_FAMILIES 里被冻结的原正则状态。
 */
function _firstUnnegatedMatch(re, text, negOn) {
  if (!negOn) return re.exec(text);
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  let m;
  while ((m = g.exec(text)) !== null) {
    if (m.index === g.lastIndex) g.lastIndex += 1;            // 防零宽匹配死循环
    if (!_isNegatedClaim(text, m.index)) return m;
  }
  return null;
}

// 动词→工具族 allow-list（中英双语）。每族一组关键词正则 + 该族认可的工具名/壳命令关键词。
// 版本化、确定性；新增声称类型只在此处扩词库。
const CLAIM_FAMILIES = Object.freeze([
  {
    family: 'delete',
    expectedTool: 'Delete',
    claim: /\b(deleted|removed|rm -rf|dropped (the )?(table|database|db))\b|删除了?|删库|移除了?|清空了?/i,
    toolNames: /(delete|remove|rm|unlink|drop)/i,
    shellCmd: /\b(rm|rmdir|unlink|drop\s+(table|database))\b/i,
  },
  {
    family: 'write',
    expectedTool: 'Write',
    claim: /\b(wrote|created|saved|generated) (the |a )?(file|new file)\b|写入了?|创建了?(文件)?|保存了?(文件)?|新建了?(文件)?/i,
    toolNames: /(write|create|save|new_?file|touch)/i,
    shellCmd: /\b(touch|tee|>\s*\S+)\b/i,
  },
  {
    family: 'edit',
    expectedTool: 'Edit',
    claim: /\b(edited|modified|updated|patched) (the )?(file|code)\b|修改了?(文件|代码)?|编辑了?(文件)?|改好了?|更新了?(文件|代码)?/i,
    toolNames: /(edit|modify|patch|replace|update_?file|multiedit)/i,
    shellCmd: /\b(sed -i|patch)\b/i,
  },
  {
    family: 'test',
    expectedTool: 'test',
    claim: /\b(tests? (all )?passed?|all tests? pass|ran (the )?tests?|test suite (passed|green))\b|测试(全部|都)?(通过|过了|全过|绿)|跑(完|过)了?测试|单测通过/i,
    toolNames: /(test|jest|pytest|mocha|vitest)/i,
    shellCmd: /\b(npm (run )?test|jest|pytest|mocha|vitest|go test|cargo test|node --test)\b/i,
  },
  {
    family: 'commit',
    expectedTool: 'git commit',
    claim: /\b(committed|made a commit|pushed (the )?(commit|changes))\b|提交了?(代码|改动)?|已提交|推送了?|已推送/i,
    toolNames: /(git|commit)/i,
    shellCmd: /\bgit\s+(commit|push)\b/i,
  },
  {
    family: 'deploy',
    expectedTool: 'deploy',
    claim: /\b(deployed|shipped (to )?(prod|production)|released (to )?prod)\b|部署了?|已部署|上线了?|已上线|发布了?(到)?(生产|线上)?/i,
    toolNames: /(deploy|release|ship|publish)/i,
    shellCmd: /\b(deploy|kubectl apply|docker push|npm publish|helm upgrade)\b/i,
  },
]);

/** 取一条日志的成功标志（兼容 `entry.success` 与 `entry.result.success` 两种形状）。 */
function _isSuccess(entry) {
  if (!entry || typeof entry !== 'object') return false;
  if (entry.success === true) return true;
  if (entry.result && entry.result.success === true) return true;
  return false;
}

/** 取一条日志可能携带的壳命令字符串（用于 test/git/deploy 等经 shell 跑的声称）。 */
function _shellCommand(entry) {
  const p = entry && entry.params;
  if (!p || typeof p !== 'object') return '';
  for (const k of ['command', 'cmd', 'script', 'code']) {
    if (typeof p[k] === 'string' && p[k].trim()) return p[k];
  }
  return '';
}

/** 该成功日志条目满足哪些工具族。 */
function _familiesOf(entry) {
  const fams = new Set();
  const name = String((entry && entry.tool) || '');
  const cmd = _shellCommand(entry);
  for (const fam of CLAIM_FAMILIES) {
    if (fam.toolNames.test(name)) fams.add(fam.family);
    else if (cmd && fam.shellCmd.test(cmd)) fams.add(fam.family);
  }
  return fams;
}

/**
 * 核对中转正文声称 vs 本地工具日志。确定性、无模型、fail-open。
 * @param {string} proseText  中转助手正文
 * @param {Array}  toolCallLog  `[{tool, params, success|result:{success}, ...}]`
 * @returns {{contradictions: Array<{claim:string, expectedTool:string, found:false}>, lexiconVersion:number}}
 */
function reconcile(proseText, toolCallLog = [], opts = {}) {
  const empty = { contradictions: [], lexiconVersion: LEXICON_VERSION };
  try {
    const text = typeof proseText === 'string' ? proseText : '';
    if (!text.trim()) return empty;
    const log = Array.isArray(toolCallLog) ? toolCallLog : [];
    const negOn = _isNegationGuardEnabled(opts && opts.env);

    // 本地已成功满足的工具族集合（只认 success===true）。
    const satisfied = new Set();
    for (const entry of log) {
      if (!_isSuccess(entry)) continue;
      for (const fam of _familiesOf(entry)) satisfied.add(fam);
    }

    const contradictions = [];
    for (const fam of CLAIM_FAMILIES) {
      const m = _firstUnnegatedMatch(fam.claim, text, negOn);
      if (!m) continue;
      if (satisfied.has(fam.family)) continue; // 声称有对应成功工具 → 不矛盾
      contradictions.push({
        claim: _snippet(text, m.index),
        expectedTool: fam.expectedTool,
        found: false,
      });
    }
    return { contradictions, lexiconVersion: LEXICON_VERSION };
  } catch {
    // fail-OPEN：核对是咨询性证据，出错绝不阻断/隔离正文。
    return empty;
  }
}

/** 取声称所在句子的简短片段（用于人读标签，不泄露整段正文）。 */
function _snippet(text, idx) {
  const start = Math.max(0, text.lastIndexOf('\n', idx) + 1);
  let end = text.indexOf('\n', idx);
  if (end === -1) end = text.length;
  let s = text.slice(start, end).trim();
  if (s.length > 80) s = s.slice(0, 79) + '…';
  return s;
}

module.exports = {
  LEXICON_VERSION,
  CLAIM_FAMILIES,
  reconcile,
  _isNegatedClaim,
  _isNegationGuardEnabled,
};
