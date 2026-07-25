'use strict';

/**
 * atMentionInject.js — `@path` 文件/目录提及 → 内容注入的单一真源。
 *
 * 背景(goal 2026-06-28「我只要用 TUI,REPL 有而 TUI 没有的功能要补齐,两处对齐」):
 * classic readline REPL 在提交时把 `@file` 展开成 `[File: …]\n```…```\n` 内容块、把 `@dir`
 * 展开成 `[Directory: …]` 目录树注入给模型(repl.js:4940-4998),并拦截敏感文件(.env/.pem/
 * id_rsa…)。Ink TUI 的 `@` 此前只做路径自动补全,提交时**不注入内容**——模型只看到字面
 * `@path`,要靠自己再调工具去读,且敏感文件拦截也缺失。
 *
 * 本模块把这段逻辑抽成两处(classic REPL + TUI)共用的单一真源,避免各写一套正则与敏感清单
 * 而漂移。目录树复用既有 `cli/repl/toolOutputRender._buildDirTree`(再单一真源一层,不重写)。
 *
 * 薄 IO(stat + 读取被显式 @ 提及的文件):确定性、**绝不抛**。任何失败(文件不存在、读不了)
 * 都安静跳过该提及,绝不打断提交。env 门控 `KHY_AT_MENTION_INJECT`(默认开,仅显式 0/false/
 * off/no 关闭;关闭后逐字节回退到「不注入、原文不动」)。env / cwd 经 opts 注入可测。
 *
 * 与 classic 完全一致的安全 / 体积约束:
 *   - 敏感文件名 / 扩展名拦截(SENSITIVE_NAMES / SENSITIVE_EXTS)。
 *   - 单文件读取上限 100KB(超出只取前 100KB 并在 sizeInfo 注明)。
 *   - 目录树 maxDepth=3 / maxFiles=80。
 *   - 不存在的 @ 提及(可能是邮箱 / 社交 handle)安静跳过。
 */

const fs = require('fs');
const path = require('path');

const _FALSY = new Set(['0', 'false', 'off', 'no']);

const SENSITIVE_NAMES = new Set(['.env', '.pem', '.key', '.crt', '.pfx', '.p12',
  'id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa', 'credentials', 'secret',
  '.admin_initial_password', '.htpasswd', 'shadow', '.netrc', '.pgpass']);
const SENSITIVE_EXTS = new Set(['.pem', '.key', '.crt', '.pfx', '.p12', '.jks', '.keystore']);
const MAX_FILE_SIZE = 100 * 1024;

// CC 后端口径对齐:@file 提及的大小标注走 CC `formatFileSize` 单一真源(ccFormat SSOT),
// 而非本地 `(b/1024).toFixed(1)KB`——后者对 15 字节的 note.txt 会塌成无意义的 "0.0KB",
// 且永远显 KB(无 bytes/MB/GB 进位)。门控 KHY_CC_FORMAT(经 ccFormatEnabled)默认开;
// 关 / require 失败 → 逐字节回退旧 `toFixed(1)KB` 口径。
function _formatMentionSize(bytes, env, legacyFracDigits) {
  try {
    const { ccFormatEnabled, ccFormatFileSize } = require('./ccFormat');
    if (ccFormatEnabled(env)) {
      const out = ccFormatFileSize(bytes);
      if (out) return out;
    }
  } catch { /* fall through to legacy */ }
  // byte-identical legacy: ≤MAX 分支历史用 toFixed(1)、>MAX 的「of NKB」用 toFixed(0)。
  return `${(bytes / 1024).toFixed(legacyFracDigits)}KB`;
}

/**
 * 门控判定。默认开,仅显式 0/false/off/no 关闭。
 * @param {object} [env]
 * @returns {boolean}
 */
function isEnabled(env) {
  const v = (env || process.env || {}).KHY_AT_MENTION_INJECT;
  return !(v !== undefined && _FALSY.has(String(v).trim().toLowerCase()));
}

/**
 * 解析输入里的 `@path` 提及,把存在的文件/目录展开成注入块。
 *
 * @param {string} text         本轮提交文本
 * @param {object} [opts]
 * @param {string} [opts.cwd]   相对路径解析基准(默认 KHYQUANT_CWD || process.cwd())
 * @param {object} [opts.env]   注入 env(测试用)
 * @returns {{
 *   text: string,                                       // 注入后的文本(或原文)
 *   reads: Array<{relPath:string, kind:'file'|'dir', sizeInfo:string}>,  // 成功读入的提及(供调用方打印 Read 行)
 *   blocked: Array<string>,                             // 被拦截的敏感文件 basename
 *   changed: boolean                                    // 是否真的注入了内容
 * }}
 */
function resolveAtMentions(text, opts = {}) {
  const input = String(text == null ? '' : text);
  const empty = { text: input, reads: [], blocked: [], changed: false };
  try {
    if (!isEnabled(opts.env)) return empty;
    if (!input.includes('@')) return empty;

    const cwd = opts.cwd || process.env.KHYQUANT_CWD || process.cwd();
    const atMentionRe = /@([\w./-]+[\w.])/g;
    const mentions = [];
    let m;
    while ((m = atMentionRe.exec(input)) !== null) {
      mentions.push({ fullMatch: m[0], relPath: m[1] });
    }
    if (mentions.length === 0) return empty;

    let _buildDirTree;
    try { ({ _buildDirTree } = require('./repl/toolOutputRender')); }
    catch { _buildDirTree = null; }

    const reads = [];
    const blocked = [];
    const injections = [];

    for (const mention of mentions) {
      const resolvedPath = path.isAbsolute(mention.relPath)
        ? mention.relPath
        : path.resolve(cwd, mention.relPath);
      const basename = path.basename(resolvedPath).toLowerCase();
      const ext = path.extname(resolvedPath).toLowerCase();
      if (SENSITIVE_NAMES.has(basename) || SENSITIVE_EXTS.has(ext)) {
        blocked.push(path.basename(resolvedPath));
        continue;
      }
      try {
        const stat = fs.statSync(resolvedPath);
        if (stat.isFile()) {
          const content = fs.readFileSync(resolvedPath, 'utf-8').slice(0, MAX_FILE_SIZE);
          const sizeInfo = stat.size > MAX_FILE_SIZE
            ? `first 100KB of ${_formatMentionSize(stat.size, opts.env, 0)}`
            : _formatMentionSize(stat.size, opts.env, 1);
          reads.push({ relPath: mention.relPath, kind: 'file', sizeInfo });
          injections.push({
            match: mention.fullMatch,
            block: `[File: ${mention.relPath}]\n\`\`\`\n${content}\n\`\`\``,
          });
        } else if (stat.isDirectory() && _buildDirTree) {
          const tree = _buildDirTree(resolvedPath, { maxDepth: 3, maxFiles: 80 });
          reads.push({ relPath: mention.relPath, kind: 'dir', sizeInfo: `${tree.fileCount} ${require('./ccPlural').pluralOr(tree.fileCount, 'file')}` });
          injections.push({
            match: mention.fullMatch,
            block: `[Directory: ${mention.relPath}]\n${tree.text}`,
          });
        }
      } catch { /* mention doesn't resolve — could be email/social handle, skip */ }
    }

    if (injections.length === 0) return { text: input, reads, blocked, changed: false };

    let cleanedInput = input;
    for (const inj of injections) {
      cleanedInput = cleanedInput.replace(inj.match, inj.match.slice(1));
    }
    const contentBlocks = injections.map(inj => inj.block).join('\n\n');
    return {
      text: `${cleanedInput}\n\n${contentBlocks}`,
      reads,
      blocked,
      changed: true,
    };
  } catch {
    return empty;
  }
}

module.exports = {
  isEnabled,
  resolveAtMentions,
  SENSITIVE_NAMES,
  SENSITIVE_EXTS,
};
