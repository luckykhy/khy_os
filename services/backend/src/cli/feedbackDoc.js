'use strict';

/**
 * feedbackDoc.js — 纯叶子(零 IO · 确定性 · 绝不抛 · 可单测)。
 *
 * 承 Goal(Thread 4)「缺少的工具和 /菜单全部补齐」。真缺口:khy 命令面**没有**
 * `/feedback`(与 `/bug` 别名)——对齐 Claude Code `/feedback`(对工具本身提反馈/报 bug)。
 * 注意这与既有 `/issue` **语义不同**:`/issue` 从 git remote 定位并向**用户自己的仓库**
 * 建 GitHub issue;`/feedback` 是对 **khy 这个工具本身**的反馈,受众/落点都不同,故绝不
 * 复用 `/issue` 把反馈错投进用户的产品仓库(那是不诚实的错路由)。
 *
 * khy-native 诚实边界(核心):khy **没有任何遥测/反馈云端汇聚点**,红线亦禁止臆造一个
 * 网络端点把用户数据外发。因此 `/feedback` **只在本地落一份反馈草稿**(交由薄壳写
 * getDataDir('feedback')),并**如实指向上游** issues 页(URL 由 package.json 的 bugs.url
 * 提供,非臆造),由用户自行决定是否上报——**绝不假装已提交、绝不静默外发**。
 *
 * 本叶子只负责纯逻辑:门控、参数解析、类别标签、反馈文档(标题/正文 markdown)构造、
 * 文件名构造。所有随环境变化的输入(版本、平台、时间戳)由薄壳注入,保证确定性可单测。
 *
 * 门控 KHY_FEEDBACK(默认开;{0,false,off,no} 关)。
 */

const _OFF = ['0', 'false', 'off', 'no'];

/**
 * 是否启用 `/feedback` 命令。默认开(unset → 开)。
 * @param {object} [env]
 * @returns {boolean}
 */
function feedbackEnabled(env = process.env) {
  const raw = env && env.KHY_FEEDBACK;
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return !_OFF.includes(v);
}

/** 已知反馈类别 → 中文标签(未知/缺省 → 其他)。 */
const _CATEGORY_LABELS = {
  bug: '缺陷',
  idea: '建议',
  feature: '建议',
  praise: '好评',
  other: '其他',
};

/** 归一类别键(小写去空白;未知归 'other')。 */
function _normalizeCategory(cat) {
  const key = String(cat == null ? '' : cat).trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(_CATEGORY_LABELS, key) ? key : 'other';
}

/** 类别中文标签。 */
function categoryLabel(cat) {
  return _CATEGORY_LABELS[_normalizeCategory(cat)];
}

/**
 * 解析 `/feedback` 参数:可选 `--category|-c <bug|idea|praise|other>`,其余为自由反馈文本。
 * 与 `/issue` 一样,router 的通用 `--key value` 解析不吞这些 token(它们留在 args 里),
 * 故本叶子自行扫描。
 * @param {string[]} args
 * @returns {{ valid: boolean, category: string, text: string }}
 */
function parseFeedbackArgs(args) {
  const list = Array.isArray(args) ? args.map((a) => String(a == null ? '' : a)) : [];
  let category = 'other';
  const rest = [];
  for (let i = 0; i < list.length; i += 1) {
    const tok = list[i];
    if ((tok === '--category' || tok === '-c') && i + 1 < list.length) {
      category = _normalizeCategory(list[i + 1]);
      i += 1;
      continue;
    }
    const m = /^--category=(.*)$/.exec(tok);
    if (m) {
      category = _normalizeCategory(m[1]);
      continue;
    }
    if (tok.length > 0) rest.push(tok);
  }
  const text = rest.join(' ').trim();
  return { valid: text.length > 0, category, text };
}

/** 从反馈文本取一行简短标题(单行、压空白、限长 72)。 */
function _deriveTitle(text) {
  const firstLine = String(text == null ? '' : text).split('\n')[0].replace(/\s+/g, ' ').trim();
  if (firstLine.length <= 72) return firstLine;
  return `${firstLine.slice(0, 71)}…`;
}

/**
 * 构造反馈文档(纯 markdown)。所有随环境变化的输入由调用方注入。
 * @param {object} p
 * @param {string} p.text      反馈正文(必填;空 → 仍构造但正文占位)
 * @param {string} [p.category]
 * @param {string} [p.version] khy 版本(薄壳注入)
 * @param {string} [p.platform] 平台串(薄壳注入,如 'linux 5.15.0')
 * @param {string} [p.stamp]   ISO 时间戳(薄壳注入)
 * @returns {{ title: string, body: string }}
 */
function buildFeedbackDoc(p) {
  const o = p || {};
  const text = String(o.text == null ? '' : o.text).trim();
  const catKey = _normalizeCategory(o.category);
  const label = _CATEGORY_LABELS[catKey];
  const title = `[feedback][${catKey}] ${_deriveTitle(text)}`.trim();

  const meta = [];
  const version = String(o.version == null ? '' : o.version).trim();
  const platform = String(o.platform == null ? '' : o.platform).trim();
  const stamp = String(o.stamp == null ? '' : o.stamp).trim();
  if (version) meta.push(`- khy 版本: ${version}`);
  if (platform) meta.push(`- 平台: ${platform}`);
  if (stamp) meta.push(`- 时间: ${stamp}`);

  const bodyLines = [`# 反馈（${label}）`, ''];
  bodyLines.push(text || '（未填写反馈内容）', '');
  if (meta.length) {
    bodyLines.push('## 环境', '', ...meta, '');
  }
  return { title, body: bodyLines.join('\n') };
}

/** 反馈草稿文件名(纯:stamp 由调用方注入)。stamp 里不安全的字符替换为 '-'。 */
function buildFeedbackFilename(stamp) {
  const safe = String(stamp == null ? '' : stamp).replace(/[:.]/g, '-').replace(/[^\w\-]/g, '-');
  return `feedback-${safe || 'draft'}.md`;
}

module.exports = {
  feedbackEnabled,
  categoryLabel,
  parseFeedbackArgs,
  buildFeedbackDoc,
  buildFeedbackFilename,
};
