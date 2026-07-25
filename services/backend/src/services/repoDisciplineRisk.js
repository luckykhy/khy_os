'use strict';

/**
 * repoDisciplineRisk.js — 纯叶子:Khyos「仓库纪律与风险」管理的单一真源。
 *
 * 背景(真缺口):仓库纪律的规则此前**只以英文散文形式**散落在 `constants/prompts.js`
 * 的 `getGitOperationsSection()`,而风险检查则散落各处且各有盲区:
 *   - 提交信息质量评分(`forge/forgeCore.evaluateCommitQuality`)**只跑远程仓库**,从不作用于本地待提交;
 *   - 敏感信息检测(`scripts/check-change-safety.js` 的 `SENSITIVE_PATH_RE`)**只看路径**,不扫 diff 内容里粘进普通文件的密钥;
 *   - 大文件守卫**只按文件数量**(`WARN/ERROR_CHANGED_FILE_COUNT`),没有按字节大小或二进制产物的判断;
 *   - 可变性分级(`evolutionPolicy.classifyPath`)只治**自治进化**,不为人工/助手发起的提交给风险提示。
 * 于是 Khyos 无法以单一真源「陈述纪律 + 对一次本地提交/推送产出确定性风险裁决」。
 *
 * 本叶子把「仓库纪律宪章」与「提交/推送风险评估」收成一处单一真源:
 *   - DISCIPLINE_RULES —— 机器可读的纪律宪章(EN directive 供提示词、ZH rule/why 供人看);
 *   - scanSecretLeaks() —— 高置信度密钥**内容**扫描(填补真缺口,强上下文+抑制占位符=零假阳性导向);
 *   - assessFileRisk()  —— 大文件 / 二进制产物风险(按字节大小,填补真缺口);
 *   - assessCommitMessage() —— **复用** forgeCore.evaluateCommitQuality(把远程评分器用到本地);
 *   - classifyPathRisk() —— **复用** evolutionPolicy.classifyPath(不可变/受护区域=人工改动的风险提示,诚实:仅提示不阻断);
 *   - assessRepoRisk()  —— 复合裁决 clean / caution / block;
 *   - buildGitSafetyBullets() / describeDisciplineCharter() —— 把宪章渲染给提示词 / CLI(单源,杜绝散文漂移)。
 *
 * 契约:零 IO(只读 process.env 做门控,不碰 fs/网络/子进程/git/流;文件大小由调用方在薄 IO 层取来传入)、
 * 确定性、绝不抛(fail-soft,任何坏输入都返回安全空值)、env 门控 `KHY_REPO_DISCIPLINE` 默认开。
 * 门控关 → `isEnabled()===false` → 评估返回 `{enabled:false, verdict:'clean', findings:[]}`,
 * 且 `buildGitSafetyBullets()` 让提示词回退到逐字节相同的旧散文(由 prompts.js 持有 LEGACY 串)。
 *
 * 全局门控惯例:khyos 所有 KHY_* 开关读法为「仅 0/false/off/no(去空白小写)才算关」。
 */

// 复用既有纯叶子真源——绝不重造提交质量评分与路径分级。
const forgeCore = require('./forge/forgeCore');
const evolutionPolicy = require('./evolutionPolicy');

const REPO_DISCIPLINE_MARKER = 'KHY_REPO_DISCIPLINE';

const _FALSY = new Set(['0', 'false', 'off', 'no']);

// trim+小写 nullish-安全规整单一真源 utils/normLower。
const _norm = require('../utils/normLower');

/** 门控:默认开,仅显式 0/false/off/no 才关。 */
function isEnabled(env = process.env) {
  return !_FALSY.has(_norm(env && env.KHY_REPO_DISCIPLINE));
}

// ── 纪律宪章(单一真源)────────────────────────────────────────────────────────
// 每条:id / severity / directive(EN,渲染进系统提示词)/ rule(ZH,给人看)/ why(ZH)。
// 取自 prompts.js 既有 Git Safety Protocol 散文 + 补全(branch-first / no-secrets /
// no-large-binary / conventional-commits),从此提示词与 CLI/工具同源,改一处即同步。
const DISCIPLINE_RULES = Object.freeze([
  {
    id: 'no-commit-without-ask', severity: 'high',
    directive: 'NEVER create a commit unless the user explicitly asks; if intent is unclear, ask first',
    rule: '只有用户明确要求时才创建提交;意图不清先问',
    why: '提交是有副作用的动作,代用户决定会污染历史',
  },
  {
    id: 'no-git-config', severity: 'high',
    directive: 'NEVER update the git config',
    rule: '绝不擅自修改 git config',
    why: '改全局/仓库配置会悄悄改变身份与行为,影响后续所有操作',
  },
  {
    id: 'no-destructive', severity: 'high',
    directive: 'NEVER run destructive git commands (push --force, reset --hard, checkout ., restore ., clean -f, branch -D) unless the user explicitly requests them',
    rule: '未经明确要求绝不跑破坏性命令(push --force / reset --hard / checkout . / clean -f / branch -D)',
    why: '这些命令不可逆,极易丢失未提交工作或他人提交',
  },
  {
    id: 'no-skip-hooks', severity: 'critical',
    directive: 'NEVER skip hooks (--no-verify, --no-gpg-sign, etc.) unless the user explicitly requests it',
    rule: '绝不跳过钩子(--no-verify / --no-gpg-sign 等)',
    why: '钩子是仓库门禁;跳过等于绕过纪律与安全检查',
  },
  {
    id: 'no-force-push-main', severity: 'critical',
    directive: 'NEVER force-push to main/master; warn the user if they request it',
    rule: '绝不对 main/master 强推;用户要求也先警告',
    why: '强推主干会改写他人历史、丢失提交,几乎不可恢复',
  },
  {
    id: 'new-commit-not-amend', severity: 'high',
    directive: 'Always create NEW commits rather than amending unless the user explicitly requests --amend; when a pre-commit hook fails the commit did NOT happen, so --amend would modify the PREVIOUS commit and may destroy work',
    rule: '总是新建提交而非 --amend(除非用户明确要求);钩子失败时本次提交并未发生,--amend 会改到上一条',
    why: '误用 amend 会销毁上一条提交里的工作',
  },
  {
    id: 'no-blind-add-all', severity: 'medium',
    directive: "Prefer adding specific files by name over 'git add -A' / 'git add .', which can include secrets (.env, credentials) or large binaries",
    rule: '按文件名暂存,避免 git add -A / git add .',
    why: '一把梭暂存可能误纳 .env / 凭据或大二进制',
  },
  {
    id: 'branch-first', severity: 'high',
    directive: 'On the default branch (main/master), create a new branch before committing non-trivial work',
    rule: '在默认分支(main/master)上作业前先开新分支',
    why: '直接在主干提交/推送会绕过评审、污染发布线',
  },
  {
    id: 'no-secrets', severity: 'critical',
    directive: 'NEVER commit secrets, tokens, or private keys; once in history they are effectively leaked and hard to purge',
    rule: '绝不把密钥/令牌/私钥提交进仓库',
    why: '一旦进入历史即视同泄露,难以彻底清除',
  },
  {
    id: 'no-large-binary', severity: 'medium',
    directive: 'Do not commit large files or build artifacts; use .gitignore or external storage instead',
    rule: '不提交大文件/构建产物,改用 .gitignore 或外部存储',
    why: '撑爆仓库、拖慢 clone、且无法 diff',
  },
  {
    id: 'conventional-commits', severity: 'medium',
    directive: 'Write Conventional Commits messages that explain intent; avoid vague subjects (wip / update / fix)',
    rule: '提交信息遵循 Conventional Commits 并说明意图,避免 wip/update/fix 等笼统主题',
    why: '可读的历史是协作与回溯的基础',
  },
]);

// ── 密钥内容扫描(填补真缺口)──────────────────────────────────────────────────
// 高置信度模式:每条都自带强结构(固定前缀 + 长度),误报率极低。绝不在结果里回显完整密钥。
const SECRET_PATTERNS = Object.freeze([
  { id: 'aws-access-key-id', re: /\bAKIA[0-9A-Z]{16}\b/, label: 'AWS Access Key ID' },
  { id: 'private-key-block', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/, label: '私钥块 (PEM)' },
  { id: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/, label: 'GitHub Token' },
  { id: 'gitlab-pat', re: /\bglpat-[A-Za-z0-9_-]{20,}\b/, label: 'GitLab Personal Access Token' },
  { id: 'openai-key', re: /\bsk-[A-Za-z0-9]{20,}\b/, label: 'OpenAI 风格 API Key (sk-)' },
  { id: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, label: 'Slack Token' },
  { id: 'slack-webhook', re: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]{20,}/, label: 'Slack Webhook URL' },
  { id: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/, label: 'Google API Key' },
]);

// 通用「赋值给敏感变量名的疑似密钥」:须强上下文(变量名是 secret/token/...)+足够长 + 非占位符。
const GENERIC_SECRET_RE = /\b(?:secret|token|passwd|password|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?token)\b['"]?\s*[:=]\s*['"]([^'"\n]{16,})['"]/i;

// 占位符 / 明显非真值——抑制假阳性(零假阳性导向)。
const PLACEHOLDER_RE = /^(?:x{3,}|\.{3,}|<.*>|your[_-]|example|changeme|change[_-]?me|placeholder|dummy|sample|fake|none|null|undefined|todo|redacted|\*{3,}|\$\{?[a-z_]+\}?|process\.env|os\.environ)/i;

/** 掩码:只露前 4 字符,其余以 … 代,绝不回显完整密钥。 */
function _mask(secret) {
  const s = String(secret || '');
  if (s.length <= 4) return '****';
  return `${s.slice(0, 4)}…(${s.length} chars)`;
}

/**
 * 从文本/统一 diff 中扫描疑似密钥。若输入像 unified diff(含 `diff --git` 或 `+++ `),
 * 只扫新增行(以 `+` 开头、非 `+++`),即一次提交真正引入的风险面;否则全文扫描。
 * 纯计算,绝不抛,无命中返回 []。
 * @param {string} text
 * @returns {Array<{kind:'secret', category:'risk', id:string, label:string, severity:'critical', line:number, masked:string}>}
 */
function scanSecretLeaks(text) {
  try {
    const raw = String(text || '');
    if (!raw) return [];
    const allLines = raw.split(/\r?\n/);
    const looksLikeDiff = /^diff --git /m.test(raw) || /^\+\+\+ /m.test(raw);
    const out = [];
    const seen = new Set();
    for (let i = 0; i < allLines.length; i += 1) {
      const lineText = allLines[i];
      if (looksLikeDiff) {
        if (!lineText.startsWith('+') || lineText.startsWith('+++')) continue;
      }
      const scanText = looksLikeDiff ? lineText.slice(1) : lineText;

      for (const pat of SECRET_PATTERNS) {
        const m = scanText.match(pat.re);
        if (!m) continue;
        const hit = m[0];
        const key = `${pat.id}:${hit}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ kind: 'secret', category: 'risk', id: pat.id, label: pat.label, severity: 'critical', line: i + 1, masked: _mask(hit), message: `疑似泄露${pat.label}(${_mask(hit)}) —— 绝不可提交进仓库` });
      }

      const gm = scanText.match(GENERIC_SECRET_RE);
      if (gm && gm[1] && !PLACEHOLDER_RE.test(gm[1].trim())) {
        const val = gm[1];
        const key = `generic:${val}`;
        if (!seen.has(key)) {
          seen.add(key);
          out.push({ kind: 'secret', category: 'risk', id: 'generic-assignment', label: '疑似硬编码密钥(敏感变量名 = 字面量)', severity: 'critical', line: i + 1, masked: _mask(val), message: `疑似硬编码密钥(${_mask(val)}) —— 敏感变量名直接赋了字面量,绝不可提交` });
        }
      }
    }
    return out;
  } catch {
    return [];
  }
}

// ── 大文件 / 二进制产物风险(填补真缺口)────────────────────────────────────────
const LARGE_FILE_BYTES = 5 * 1024 * 1024;            // >5MB 单文件 = high
const WARN_FILE_BYTES = 1 * 1024 * 1024;             // >1MB = medium 提醒
// 构建产物 / 二进制扩展名:这类文件几乎不该进版本库(应忽略或走外部存储)。
const ARTIFACT_EXTS = new Set([
  'exe', 'dll', 'so', 'dylib', 'o', 'a', 'class', 'jar', 'war',
  'zip', 'tar', 'gz', 'tgz', 'bz2', '7z', 'rar',
  'whl', 'node', 'wasm', 'bin', 'dmg', 'pkg', 'msi', 'iso', 'pdb', 'lib',
]);

function _ext(path) {
  const p = _norm(path);
  const i = p.lastIndexOf('.');
  if (i < 0 || i === p.length - 1) return '';
  return p.slice(i + 1);
}

/**
 * 评估一批文件的大小/类型风险。调用方在薄 IO 层把 {path, size(bytes)} 取来传入。
 * 纯计算,绝不抛。
 * @param {Array<{path:string, size?:number}>} files
 * @returns {Array<{kind:string, category:'risk', severity:string, path:string, message:string, bytes?:number}>}
 */
function assessFileRisk(files) {
  try {
    const rows = Array.isArray(files) ? files : [];
    const out = [];
    for (const f of rows) {
      if (!f || typeof f !== 'object') continue;
      const path = String(f.path || '').trim();
      if (!path) continue;
      const size = Number(f.size);
      const ext = _ext(path);
      if (Number.isFinite(size) && size >= LARGE_FILE_BYTES) {
        out.push({ kind: 'large-file', category: 'risk', severity: 'high', path, bytes: size, message: `大文件 ${_humanSize(size)} —— 不该直接提交,改用 .gitignore 或外部存储` });
      } else if (ARTIFACT_EXTS.has(ext)) {
        out.push({ kind: 'binary-artifact', category: 'risk', severity: 'medium', path, message: `二进制/构建产物 .${ext} —— 这类文件通常应忽略而非提交` });
      } else if (Number.isFinite(size) && size >= WARN_FILE_BYTES) {
        out.push({ kind: 'large-file', category: 'risk', severity: 'medium', path, bytes: size, message: `较大文件 ${_humanSize(size)} —— 确认是否应进版本库` });
      }
    }
    return out;
  } catch {
    return [];
  }
}

function _humanSize(bytes) {
  const b = Number(bytes);
  if (!Number.isFinite(b) || b < 0) return '?';
  if (b < 1024) return `${b}B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)}KB`;
  return `${(b / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * 评估本地提交信息质量——复用 forgeCore.evaluateCommitQuality(把远程评分器用到本地)。
 * 空信息 → 单独标 critical。纯计算,绝不抛。
 * @param {string} message
 * @returns {{empty:boolean, score:number, grade:string, conventional:boolean, notes:string[]}}
 */
function assessCommitMessage(message) {
  try {
    const msg = String(message || '').trim();
    if (!msg) return { empty: true, score: 0, grade: 'N/A', conventional: false, notes: ['提交信息为空'] };
    const subject = msg.split('\n')[0].trim();
    const q = forgeCore.evaluateCommitQuality([{ subject, message: msg, isMerge: false }]);
    return {
      empty: false,
      score: q.score,
      grade: q.grade,
      conventional: q.conventionalRatio >= 1,
      notes: Array.isArray(q.notes) ? q.notes : [],
    };
  } catch {
    return { empty: false, score: 0, grade: 'N/A', conventional: false, notes: [] };
  }
}

/**
 * 路径风险——复用 evolutionPolicy.classifyPath。
 * 诚实边界:evolutionPolicy 的 SCOPE 是「自治进化」,对人工/助手发起的改动**不阻断**;
 * 这里只把触碰不可变/受护区域当作**风险提示**(advisory),让人知道改这里要格外谨慎、走评审。
 * @param {string} path
 * @returns {{tier:string, severity:string, message:string}|null}
 */
function classifyPathRisk(path) {
  try {
    const c = evolutionPolicy.classifyPath(path);
    if (!c) return null;
    if (c.tier === 'immutable') {
      return { tier: c.tier, severity: 'high', message: `触碰不可变区域(${c.rule}:${c.reason}) —— 人工改动须格外谨慎并经评审` };
    }
    if (c.tier === 'guarded') {
      return { tier: c.tier, severity: 'medium', message: `触碰受护区域(${c.rule}:${c.reason}) —— 改动牵连面广,确认有意为之` };
    }
    return null;
  } catch {
    return null;
  }
}

const _DEFAULT_MAIN = new Set(['main', 'master']);

/**
 * 复合风险裁决:把密钥/大文件/提交质量/分支/强推/钩子/暂存方式/路径分级合成一个 verdict。
 * 门控关 → 安全空裁决。fail-soft,绝不抛。
 *
 * @param {object} input
 * @param {string} [input.branch]      当前分支名
 * @param {string} [input.mainBranch]  默认分支名(缺省按 main/master 判断)
 * @param {boolean} [input.force]      本次是否强推
 * @param {boolean} [input.noVerify]   本次是否跳过钩子
 * @param {boolean} [input.addAll]     本次是否 git add -A/.
 * @param {boolean} [input.amend]      本次是否 --amend
 * @param {Array<{path,size}>} [input.files]  改动文件 + 字节大小
 * @param {string} [input.diffText]    待提交 diff 文本(用于密钥扫描)
 * @param {string} [input.message]     待提交信息
 * @param {Object} [input.env]
 * @returns {{enabled:boolean, verdict:'clean'|'caution'|'block', findings:Array, commitQuality:Object|null, summary:string}}
 */
function assessRepoRisk(input = {}) {
  const env = (input && input.env) || (typeof process !== 'undefined' ? process.env : {});
  if (!isEnabled(env)) {
    return { enabled: false, verdict: 'clean', findings: [], commitQuality: null, summary: '仓库纪律与风险评估已关闭(KHY_REPO_DISCIPLINE)' };
  }

  const findings = [];
  try {
    // 1) 密钥内容(critical)。
    for (const s of scanSecretLeaks(input.diffText)) findings.push(s);

    // 2) 大文件 / 二进制产物。
    for (const f of assessFileRisk(input.files)) findings.push(f);

    // 3) 路径分级(不可变/受护)。
    const files = Array.isArray(input.files) ? input.files : [];
    for (const f of files) {
      const path = f && typeof f === 'object' ? String(f.path || '') : String(f || '');
      const pr = path ? classifyPathRisk(path) : null;
      if (pr) findings.push({ kind: 'path-tier', category: 'discipline', severity: pr.severity, path, tier: pr.tier, message: pr.message });
    }

    // 4) 分支纪律。
    const branch = _norm(input.branch);
    const main = _norm(input.mainBranch);
    const onMain = branch && (branch === main || (!main && _DEFAULT_MAIN.has(branch)));
    if (onMain) {
      findings.push({ kind: 'branch-first', category: 'discipline', severity: 'high', message: `当前在默认分支(${branch})上 —— 作非琐碎改动前应先开新分支` });
      if (input.force) {
        findings.push({ kind: 'no-force-push-main', category: 'discipline', severity: 'critical', message: `强推默认分支(${branch}) —— 会改写他人历史,绝不允许` });
      }
    }

    // 5) 跳过钩子 / 暂存方式 / amend。
    if (input.noVerify) findings.push({ kind: 'no-skip-hooks', category: 'discipline', severity: 'critical', message: '本次跳过了钩子(--no-verify) —— 绕过了仓库门禁' });
    if (input.addAll) findings.push({ kind: 'no-blind-add-all', category: 'discipline', severity: 'medium', message: '使用了 git add -A/.,可能误纳密钥或大二进制 —— 优先按文件名暂存' });
    if (input.amend) findings.push({ kind: 'new-commit-not-amend', category: 'discipline', severity: 'high', message: '本次为 --amend —— 若钩子曾失败会改到上一条提交,优先新建提交' });

    // 6) 提交信息质量。
    let commitQuality = null;
    if (input.message !== undefined && input.message !== null) {
      commitQuality = assessCommitMessage(input.message);
      if (commitQuality.empty) {
        findings.push({ kind: 'empty-commit-message', category: 'risk', severity: 'critical', message: '提交信息为空' });
      } else if (commitQuality.grade === 'F' || commitQuality.grade === 'D') {
        findings.push({ kind: 'weak-commit-message', category: 'discipline', severity: 'medium', message: `提交信息质量偏低(${commitQuality.grade}/${commitQuality.score}):${commitQuality.notes.join(';')}` });
      }
    }

    const verdict = _verdict(findings);
    return { enabled: true, verdict, findings, commitQuality, summary: _summary(verdict, findings) };
  } catch {
    return { enabled: true, verdict: 'clean', findings, commitQuality: null, summary: '评估时遇到异常,已安全降级' };
  }
}

function _verdict(findings) {
  let hasCritical = false;
  let hasCaution = false;
  for (const f of findings) {
    if (!f) continue;
    if (f.severity === 'critical') hasCritical = true;
    else if (f.severity === 'high' || f.severity === 'medium') hasCaution = true;
  }
  if (hasCritical) return 'block';
  if (hasCaution) return 'caution';
  return 'clean';
}

function _summary(verdict, findings) {
  const n = findings.length;
  if (verdict === 'block') return `发现 ${n} 项问题,含须立即处理的严重风险(block):提交/推送前必须解决`;
  if (verdict === 'caution') return `发现 ${n} 项纪律/风险提示(caution):建议处理后再提交/推送`;
  return '未发现明显的仓库纪律或风险问题(clean)';
}

// ── 宪章渲染(单源,杜绝散文漂移)──────────────────────────────────────────────

/**
 * 渲染系统提示词里 Git Safety Protocol 的项目符号列表(英文 directive)。
 * prompts.js 门控开时调用本函数;门控关时返回旧散文(LEGACY,逐字节回退)。
 * @returns {string} 形如 "- ...\n- ..." 的列表
 */
function buildGitSafetyBullets() {
  return DISCIPLINE_RULES.map((r) => `- ${r.directive}`).join('\n');
}

/** 自描述(给 CLI `khy repo charter` / 工具 / 帮助用)。 */
function describeDisciplineCharter(env = process.env) {
  return {
    enabled: isEnabled(env),
    gate: 'KHY_REPO_DISCIPLINE',
    marker: REPO_DISCIPLINE_MARKER,
    rules: DISCIPLINE_RULES.map((r) => ({ id: r.id, severity: r.severity, rule: r.rule, why: r.why })),
  };
}

module.exports = {
  REPO_DISCIPLINE_MARKER,
  DISCIPLINE_RULES,
  SECRET_PATTERNS,
  isEnabled,
  scanSecretLeaks,
  assessFileRisk,
  assessCommitMessage,
  classifyPathRisk,
  assessRepoRisk,
  buildGitSafetyBullets,
  describeDisciplineCharter,
};
