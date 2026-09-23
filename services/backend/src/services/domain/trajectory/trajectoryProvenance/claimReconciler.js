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
 * 另提供 `reconcileToolMentions`：核对正文里「通过 X / 用 X」式的**工具点名**是否真的
 * 在本轮调用过（动词词库覆盖不到的虚构场景，见函数头注释）。
 *
 * 姿态：**fail-OPEN** —— 仅咨询性。任何异常/畸形输入 → 返回空矛盾，绝不阻断 turn、绝不改
 * 模型正文，只把结果注入 `_khyTrace.contradictions` 供投影渲染 `⚠ unverified claim`。
 * 只应对 producer != khy-local 的正文跑（由调用方门控），不误报本地正文。
 */

const LEXICON_VERSION = 1;

// 否定守卫族行为保真抽至 ./claimNegation 纯叶子(只依赖 process.env + 自身正则,无 back-edge),
// 此处重新 require 再导出,使 _isNegatedClaim/_isNegationGuardEnabled 公共面与抽取前一致。
const { _isNegationGuardEnabled, _isNegatedClaim, _firstUnnegatedMatch } = require('./claimNegation');

// 动词→工具族 allow-list（中英双语）。每族一组关键词正则 + 该族认可的工具名/壳命令关键词。
// 版本化、确定性；新增声称类型只在此处扩词库。
const CLAIM_FAMILIES = Object.freeze([
  {
    family: 'delete',
    expectedTool: 'Delete',
    claim:
      /\b(deleted|removed|rm -rf|dropped (the )?(table|database|db))\b|删除了?|删库|移除了?|清空了?/i,
    toolNames: /(delete|remove|rm|unlink|drop)/i,
    shellCmd: /\b(rm|rmdir|unlink|drop\s+(table|database))\b/i,
  },
  {
    family: 'write',
    expectedTool: 'Write',
    claim:
      /\b(wrote|created|saved|generated) (the |a )?(file|new file)\b|写入了?|创建了?(文件)?|保存了?(文件)?|新建了?(文件)?/i,
    toolNames: /(write|create|save|new_?file|touch)/i,
    shellCmd: /\b(touch|tee|>\s*\S+)\b/i,
  },
  {
    family: 'edit',
    expectedTool: 'Edit',
    claim:
      /\b(edited|modified|updated|patched) (the )?(file|code)\b|修改了?(文件|代码)?|编辑了?(文件)?|改好了?|更新了?(文件|代码)?/i,
    toolNames: /(edit|modify|patch|replace|update_?file|multiedit)/i,
    shellCmd: /\b(sed -i|patch)\b/i,
  },
  {
    family: 'test',
    expectedTool: 'test',
    claim:
      /\b(tests? (all )?passed?|all tests? pass|ran (the )?tests?|test suite (passed|green))\b|测试(全部|都)?(通过|过了|全过|绿)|跑(完|过)了?测试|单测通过/i,
    toolNames: /(test|jest|pytest|mocha|vitest)/i,
    shellCmd: /\b(npm (run )?test|jest|pytest|mocha|vitest|go test|cargo test|node --test)\b/i,
  },
  {
    family: 'commit',
    expectedTool: 'git commit',
    claim:
      /\b(committed|made a commit|pushed (the )?(commit|changes))\b|提交了?(代码|改动)?|已提交|推送了?|已推送/i,
    toolNames: /(git|commit)/i,
    shellCmd: /\bgit\s+(commit|push)\b/i,
  },
  {
    family: 'deploy',
    expectedTool: 'deploy',
    claim:
      /\b(deployed|shipped (to )?(prod|production)|released (to )?prod)\b|部署了?|已部署|上线了?|已上线|发布了?(到)?(生产|线上)?/i,
    toolNames: /(deploy|release|ship|publish)/i,
    shellCmd: /\b(deploy|kubectl apply|docker push|npm publish|helm upgrade)\b/i,
  },
]);

/** 取一条日志的成功标志（兼容 `entry.success` 与 `entry.result.success` 两种形状）。 */
function _isSuccess(entry) {
  if (!entry || typeof entry !== 'object') {
    return false;
  }
  if (entry.success === true) {
    return true;
  }
  if (entry.result && entry.result.success === true) {
    return true;
  }
  return false;
}

/** 取一条日志可能携带的壳命令字符串（用于 test/git/deploy 等经 shell 跑的声称）。 */
function _shellCommand(entry) {
  const p = entry && entry.params;
  if (!p || typeof p !== 'object') {
    return '';
  }
  for (const k of ['command', 'cmd', 'script', 'code']) {
    if (typeof p[k] === 'string' && p[k].trim()) {
      return p[k];
    }
  }
  return '';
}

/** 该成功日志条目满足哪些工具族。 */
function _familiesOf(entry) {
  const fams = new Set();
  const name = String((entry && entry.tool) || '');
  const cmd = _shellCommand(entry);
  for (const fam of CLAIM_FAMILIES) {
    if (fam.toolNames.test(name)) {
      fams.add(fam.family);
    } else if (cmd && fam.shellCmd.test(cmd)) {
      fams.add(fam.family);
    }
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
    if (!text.trim()) {
      return empty;
    }
    const log = Array.isArray(toolCallLog) ? toolCallLog : [];
    const negOn = _isNegationGuardEnabled(opts && opts.env);

    // 本地已成功满足的工具族集合（只认 success===true）。
    const satisfied = new Set();
    for (const entry of log) {
      if (!_isSuccess(entry)) {
        continue;
      }
      for (const fam of _familiesOf(entry)) {
        satisfied.add(fam);
      }
    }

    const contradictions = [];
    for (const fam of CLAIM_FAMILIES) {
      const m = _firstUnnegatedMatch(fam.claim, text, negOn);
      if (!m) {
        continue;
      }
      if (satisfied.has(fam.family)) {
        continue;
      } // 声称有对应成功工具 → 不矛盾
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
  if (end === -1) {
    end = text.length;
  }
  let s = text.slice(start, end).trim();
  if (s.length > 80) {
    s = s.slice(0, 79) + '…';
  }
  return s;
}

// ── 工具点名核对(KHY_TOOL_MENTION_GUARD·默认开)──────────────────────────────
// 缺陷(2026-09 会话 2deaa521):弱模型会在收尾汇总里点名从未调用过的工具并宣称其
// 产出(「通过 dataFetch 拉取到 30 条日线数据」,而本轮工具日志里没有任何 dataFetch
// 调用)。动词词库(CLAIM_FAMILIES)按动作族匹配,覆盖不到这种「点名工具本身」的
// 声称;这里补一层**工具点名**核对:正文以执行性框架提到某注册工具名
// (「通过 X / 用 X / X 成功」)而该工具本轮从未被调用 → 记一条矛盾。
// 姿态与 reconcile 一致:确定性、零模型、fail-open、零假阳性优先 ——
//   · 只认这份版本化名单里的注册工具名(词边界;大小写/下划线/连字符不敏感);
//   · 建议/虚拟语气的提及(「可以让我用 X」「建议用 X」「先用 X」)不算点名;
//   · 否定邻近不算点名(复用 _isNegatedClaim)。
// 版本化点名名单:条目用注册表习惯大小写(展示用),匹配时大小写/分隔符不敏感。
const MENTION_TOOL_NAMES = Object.freeze([
  'Write',
  'WriteFile',
  'Edit',
  'MultiEdit',
  'Read',
  'ReadFile',
  'Glob',
  'find_files',
  'Grep',
  'rg',
  'WebSearch',
  'web_search',
  'WebFetch',
  'web_fetch',
  'dataFetch',
  'backtest',
  'shellCommand',
  'shell_command',
  'Bash',
  'bash',
  'shell',
  'PowerShell',
  'powershell',
  'cmd',
  'pwsh',
  'todoWrite',
  'todo_write',
  'askUserQuestion',
  'imageGen',
  'videoGen',
]);

const _NEG_OFF_GUARD = new Set(['0', 'false', 'off', 'no']);
function _isToolMentionGuardEnabled(env) {
  try {
    const v = (env || process.env || {}).KHY_TOOL_MENTION_GUARD;
    return !(v !== undefined && _NEG_OFF_GUARD.has(String(v).trim().toLowerCase()));
  } catch {
    return true;
  }
}

/** 工具名 → 正则片段:按 _/- 分词后允许任意分隔,匹配 dataFetch/data_fetch/data fetch。 */
function _mentionNamePattern(name) {
  return String(name)
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[\\s_-]*');
}

/** 执行性框架:工具名前接动作介词/动词,或后接完成/成功类词 —— 缺一不算点名。
 *  \b 两侧词边界:CJK/反引号邻接仍成立,但阻止「shadeFetch」这类子串误配。 */
function _mentionFrameRegex(core) {
  return new RegExp(
    `(?:通过|用|使用|调用|执行|运行|经由|借助)\\s*[\`「『]?\\b${core}\\b[\\s_-]*(?:工具)?` +
      `|[\`「『]?\\b${core}\\b[\\s_-]*(?:工具)?\\s*(?:成功|已完成|完成|调用成功|执行成功|跑完|拉取|获取|返回)`,
    'gi'
  );
}

// 建议/虚拟语气标记:命中在提及之前的近邻窗口 → 不算点名(「可以让我用 X」「先用 X」)。
const _MODAL_BEFORE_RE =
  /(可以|可|建议|让我|帮忙|请|试试|需要|若|如果|能否|或者|或|再|先|然后|并|不要|别|无需|无法|尚未|不能)$/;

function _isModalMention(text, idx) {
  try {
    if (typeof text !== 'string' || !(idx >= 0)) {
      return false;
    }
    return _MODAL_BEFORE_RE.test(text.slice(Math.max(0, idx - 8), idx));
  } catch {
    return false;
  }
}

/**
 * 核对正文「工具点名」vs 本轮实际调用过的工具名列表。确定性、无模型、fail-open。
 * @param {string} proseText 助手正文(收尾汇总)
 * @param {Array<string>} executedToolNames 本轮真实调用过的工具名(Write/dataFetch/…)
 * @param {object} [opts]
 * @param {object} [opts.env] 默认 process.env(门 KHY_TOOL_MENTION_GUARD)
 * @returns {{contradictions: Array<{claim:string, expectedTool:string, found:false}>, lexiconVersion:number}}
 */
function reconcileToolMentions(proseText, executedToolNames = [], opts = {}) {
  const empty = { contradictions: [], lexiconVersion: LEXICON_VERSION };
  try {
    const text = typeof proseText === 'string' ? proseText : '';
    if (!text.trim() || !_isToolMentionGuardEnabled(opts && opts.env)) {
      return empty;
    }
    const executed = new Set(
      (Array.isArray(executedToolNames) ? executedToolNames : [])
        .map((n) => String(n || '').replace(/[\s_-]+/g, '').toLowerCase())
        .filter(Boolean)
    );

    const contradictions = [];
    for (const name of MENTION_TOOL_NAMES) {
      const norm = String(name).replace(/[\s_-]+/g, '').toLowerCase();
      if (executed.has(norm)) {
        continue; // 本轮真调用过 → 点名成立,无矛盾
      }
      const re = _mentionFrameRegex(_mentionNamePattern(name));
      let m;
      while ((m = re.exec(text)) !== null) {
        if (m.index === re.lastIndex) {
          re.lastIndex += 1;
        }
        if (_isNegatedClaim(text, m.index)) {
          continue;
        }
        if (_isModalMention(text, m.index)) {
          continue;
        }
        contradictions.push({
          claim: _snippet(text, m.index),
          expectedTool: name,
          found: false,
        });
        break; // 每个工具名记一条即可,足够定位
      }
    }
    return { contradictions, lexiconVersion: LEXICON_VERSION };
  } catch {
    // fail-OPEN:核对是咨询性证据,出错绝不阻断正文。
    return empty;
  }
}

module.exports = {
  LEXICON_VERSION,
  CLAIM_FAMILIES,
  MENTION_TOOL_NAMES,
  reconcile,
  reconcileToolMentions,
  _isNegatedClaim,
  _isNegationGuardEnabled,
  _isToolMentionGuardEnabled,
};
