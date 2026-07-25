'use strict';

/**
 * issueReport.js — `/issue`(创建 GitHub issue / bug 报告)的「参数解析 + 会话上下文摘要 +
 * issue 正文/URL 构造」零 IO 确定性单一真源(纯叶子)。
 *
 * 契约 (CONTRACT): 零 IO、确定性、绝不抛、无副作用;只读入参,绝不读 process.env、绝不触文件、
 * 绝不 spawn 子进程、绝不调 Date。无任何依赖。
 *
 * 背后的逻辑(对齐 Claude Code `/issue`):CC 的 /issue 做四件有价值的确定性事:
 *   ① 手写参数解析 `[--label|-l <v>]* [--assignee|-a <v>]* <title...>`;
 *   ② 解析 git remote(SSH `git@github.com:owner/repo.git` / HTTPS)→ `{owner,repo}`;
 *   ③ **从会话 JSONL transcript 自动汇总 issue 正文**(取最近 N 个 user/assistant 回合各截 200 字 +
 *      抽取最近 3 条 error 工具结果归到「Recent errors」)—— 这是最高价值、最可复用的后端逻辑;
 *   ④ 降级阶梯的 URL 构造(URL 编码 issues/new 链接 + body 超长信号)。
 * 真正的 IO(读 git remote / 读 transcript / 跑 gh / 写草稿)在薄壳 handlers/issue.js;本叶子只算。
 *
 * **诚实边界**:实际「创建 issue」需 gh CLI + GitHub 认证 + 网络(薄壳里 spawn);离线时降级为
 * 浏览器 URL + 本地草稿(getDataDir('issue-drafts')),绝不假装已创建。本叶子只产离线可算的那部分。
 */

const MAX_TURN_CHARS = 200; // 每回合正文截断长度(对齐 CC)
const MAX_ERRORS = 3; // 抽取最近错误条数(对齐 CC)
const DEFAULT_MAX_TURNS = 5; // 默认汇总回合数(对齐 CC)
const DEFAULT_MAX_URL_BODY = 4096; // URL body 上限(超过则薄壳落草稿,对齐 CC)

/**
 * 解析 `/issue` 参数。手写解析器(对齐 CC parseIssueArgs)。
 * 格式:`[--label|-l <v>]* [--assignee|-a <v>]* <title words...>`。
 * @param {string[]} args
 * @returns {{title:string, labels:string[], assignees:string[], valid:boolean, parseError:string|null}}
 */
function parseIssueArgs(args) {
  const list = Array.isArray(args) ? args.map((a) => String(a == null ? '' : a)) : [];
  const labels = [];
  const assignees = [];
  const titleWords = [];
  let parseError = null;

  for (let i = 0; i < list.length; i += 1) {
    const tok = list[i];
    if (tok === '--label' || tok === '-l') {
      const v = list[i + 1];
      if (v === undefined || v.startsWith('-')) { parseError = `${tok} 需要一个值`; break; }
      labels.push(v);
      i += 1;
    } else if (tok === '--assignee' || tok === '-a') {
      const v = list[i + 1];
      if (v === undefined || v.startsWith('-')) { parseError = `${tok} 需要一个值`; break; }
      assignees.push(v);
      i += 1;
    } else if (tok.startsWith('--') || (tok.startsWith('-') && tok.length > 1 && !/^-\d/.test(tok))) {
      // 未知 flag(排除负数那种 -1);标题词不应以 - 开头。
      parseError = `未知参数:${tok}`;
      break;
    } else {
      titleWords.push(tok);
    }
  }

  const title = titleWords.join(' ').trim();
  const valid = !parseError && title.length > 0;
  if (!parseError && title.length === 0) parseError = '缺少 issue 标题';
  return { title, labels, assignees, valid, parseError };
}

/**
 * 从 git remote URL 解析 `{host, owner, repo}`。支持 SSH 与 HTTPS 形式;去除 .git 后缀。
 * @param {string} remoteUrl
 * @returns {{host:string, owner:string, repo:string}|null}
 */
function parseRemoteOwnerRepo(remoteUrl) {
  const url = String(remoteUrl == null ? '' : remoteUrl).trim();
  if (!url) return null;

  // SSH: git@github.com:owner/repo(.git)
  let m = /^[^@]+@([^:]+):([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(url);
  if (m) return { host: m[1], owner: m[2], repo: m[3] };

  // ssh://git@host/owner/repo(.git) 或 https://host/owner/repo(.git)
  m = /^(?:ssh|https?):\/\/(?:[^@/]+@)?([^/]+)\/([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(url);
  if (m) return { host: m[1], owner: m[2], repo: m[3] };

  return null;
}

/** 从 transcript 条目的 content(string 或 block 数组)抽取纯文本。 */
function _extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const block of content) {
      if (typeof block === 'string') parts.push(block);
      else if (block && typeof block === 'object' && typeof block.text === 'string') parts.push(block.text);
    }
    return parts.join(' ');
  }
  return '';
}

/** 从 transcript 条目里抽取「错误工具结果」文本(防御性:不同 schema 都尽量命中)。 */
function _extractErrors(entry) {
  const out = [];
  const content = entry && entry.content;
  if (!Array.isArray(content)) return out;
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const isErr = block.is_error === true || block.isError === true ||
      (block.type === 'tool_result' && (block.is_error || block.error));
    if (isErr) {
      const txt = _extractText(block.content != null ? block.content : block.text);
      if (txt) out.push(txt);
    }
  }
  return out;
}

function _truncate(s, max) {
  const str = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  if (str.length <= max) return str;
  return `${str.slice(0, max)}…`;
}

/** 去除 markdown 模板的 YAML front-matter(对齐 CC detectIssueTemplate)。 */
function _stripFrontMatter(tpl) {
  const s = String(tpl == null ? '' : tpl);
  const m = /^---\n[\s\S]*?\n---\n?/.exec(s);
  return m ? s.slice(m[0].length) : s;
}

/**
 * 从会话 transcript 汇总 issue 正文(对齐 CC getTranscriptSummary + 模板拼接)。
 * @param {object} opts
 *   @param {Array}  [opts.transcript] 解析后的 JSONL 条目 [{role,content,isMeta,...}]
 *   @param {number} [opts.maxTurns]  最近回合数(默认 5)
 *   @param {string} [opts.template]  .github issue 模板原文(可空)
 *   @param {string} [opts.title]     issue 标题(用于正文头部,可空)
 * @returns {string}
 */
function buildIssueBody(opts = {}) {
  const transcript = Array.isArray(opts.transcript) ? opts.transcript : [];
  const maxTurns = Number.isFinite(opts.maxTurns) && opts.maxTurns > 0 ? Math.floor(opts.maxTurns) : DEFAULT_MAX_TURNS;
  const template = opts.template ? _stripFrontMatter(opts.template) : '';

  // 收集 user/assistant 回合(跳过 meta),取最近 maxTurns。
  const turns = [];
  const errors = [];
  for (const e of transcript) {
    if (!e || typeof e !== 'object' || e.isMeta) continue;
    if (e.role === 'user' || e.role === 'assistant') {
      const text = _truncate(_extractText(e.content), MAX_TURN_CHARS);
      if (text) turns.push({ role: e.role, text });
    }
    for (const err of _extractErrors(e)) errors.push(err);
  }
  const recentTurns = turns.slice(-maxTurns);
  const recentErrors = errors.slice(-MAX_ERRORS);

  const lines = [];
  if (recentTurns.length) {
    lines.push('## 会话上下文(最近回合)');
    lines.push('');
    for (const t of recentTurns) {
      lines.push(`**${t.role}:** ${t.text}`);
      lines.push('');
    }
  }
  if (recentErrors.length) {
    lines.push('### Recent errors');
    lines.push('');
    for (const err of recentErrors) {
      lines.push('```');
      lines.push(_truncate(err, MAX_TURN_CHARS * 2));
      lines.push('```');
      lines.push('');
    }
  }
  if (template.trim()) {
    lines.push('---');
    lines.push('');
    lines.push(template.trim());
  }
  if (!lines.length) {
    lines.push('(无可汇总的会话记录)');
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function _enc(s) {
  return encodeURIComponent(String(s == null ? '' : s));
}

/**
 * 构造浏览器降级 URL(对齐 CC fallback)。body 超过 maxBodyLen 时截断并置 bodyTruncated=true
 * (薄壳据此把完整 body 落本地草稿)。
 * @param {object} opts {host,owner,repo,title,body,labels[],maxBodyLen}
 * @returns {{url:string|null, bodyTruncated:boolean}}
 */
function buildIssueUrl(opts = {}) {
  const host = opts.host || 'github.com';
  const owner = opts.owner;
  const repo = opts.repo;
  if (!owner || !repo) return { url: null, bodyTruncated: false };

  const maxBodyLen = Number.isFinite(opts.maxBodyLen) && opts.maxBodyLen > 0
    ? Math.floor(opts.maxBodyLen) : DEFAULT_MAX_URL_BODY;
  const fullBody = String(opts.body == null ? '' : opts.body);
  const bodyTruncated = fullBody.length > maxBodyLen;
  const body = bodyTruncated ? fullBody.slice(0, maxBodyLen) : fullBody;

  const params = [];
  if (opts.title) params.push(`title=${_enc(opts.title)}`);
  if (body) params.push(`body=${_enc(body)}`);
  const labels = Array.isArray(opts.labels) ? opts.labels.filter(Boolean) : [];
  if (labels.length) params.push(`labels=${_enc(labels.join(','))}`);

  const query = params.length ? `?${params.join('&')}` : '';
  const url = `https://${host}/${owner}/${repo}/issues/new${query}`;
  return { url, bodyTruncated };
}

// 收敛到 utils/isOffValue 单一真源(逐字节委托,调用点不变)
const _falsy = require('../../utils/isOffValue');

/** 门控读取(KHY_ISSUE 默认开;关 → 命令不接管)。注入 env,叶子不读 process.env。 */
function isEnabled(env = {}) {
  return !_falsy(env && env.KHY_ISSUE === undefined ? 'true' : (env && env.KHY_ISSUE));
}

module.exports = {
  parseIssueArgs,
  parseRemoteOwnerRepo,
  buildIssueBody,
  buildIssueUrl,
  isEnabled,
  DEFAULT_MAX_URL_BODY,
  DEFAULT_MAX_TURNS,
};
