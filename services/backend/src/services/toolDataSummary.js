'use strict';

/**
 * toolDataSummary.js — 模型无关的「工具结果总结」器。
 *
 * 用户痛点（/goal）：在本地/无模型或弱模型场景下，执行了取数工具（如 `dir C:\`、
 * `ls -l`）后只把原始输出贴出来，"不说『做个总结』就不会主动给结论"。本模块让 khy
 * 自己对工具结果做一次确定性归纳——尤其是目录清单——这样即便模型没产出总结，收尾
 * 兜底也能给出"几个目录 / 几个文件 / 可用空间 / 主要条目"的结论，而非原文回贴。
 *
 * 纯函数、零外部依赖（仅可选复用 localNlp 做散文摘要），便于独立单测。
 * 总开关 KHY_TOOL_DATA_SUMMARY（默认开）；关掉则回退原始呈现。
 */

function isEnabled() {
  const v = String(process.env.KHY_TOOL_DATA_SUMMARY || '').trim().toLowerCase();
  return !(v === '0' || v === 'off' || v === 'false' || v === 'no');
}

function _humanSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 10 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

function _toInt(s) {
  const n = parseInt(String(s).replace(/[,，\s]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * 解析 Windows `dir` 或 Unix `ls -l` 目录清单。
 * @returns {{path:string, dirs:string[], files:Array<{name:string,size:number|null}>, freeBytes:number|null}|null}
 */
function parseDirectoryListing(text) {
  const body = String(text || '');
  if (!body.trim()) return null;
  const lines = body.split(/\r?\n/);

  const dirs = [];
  const files = [];
  let dirPath = '';
  let freeBytes = null;
  let signals = 0; // 命中条目/标志数——用于零误报：散文绝不会触发

  // Windows: "C:\ 的目录" / "Directory of C:\"
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) continue;

    let m;
    // 路径头
    if (!dirPath) {
      m = line.match(/^\s*(.+?)\s*的目录\s*$/) || line.match(/^\s*Directory of\s+(.+?)\s*$/i);
      if (m) { dirPath = m[1].trim(); continue; }
    }
    // 可用空间页脚（Windows）
    m = line.match(/个目录[^0-9]*([\d,，]+)\s*(?:可用字节|bytes free)/i)
      || line.match(/Dir\(s\)\s*([\d,]+)\s*bytes free/i);
    if (m) { freeBytes = _toInt(m[1]); signals++; continue; }
    // 文件计数页脚——只作信号，不计入条目
    if (/个文件|File\(s\)/i.test(line) && /字节|bytes/i.test(line)) { signals++; continue; }
    if (/^\s*total\s+\d+\s*$/i.test(line)) { signals++; continue; } // ls 头

    // Windows 目录行：含 <DIR>/<JUNCTION>
    m = line.match(/<(?:DIR|JUNCTION|SYMLINKD)>\s+(.+?)\s*$/i);
    if (m) {
      const name = m[1].trim();
      if (name && name !== '.' && name !== '..') { dirs.push(name); signals++; }
      continue;
    }
    // Windows 文件行：日期 时间 大小(带千分位) 文件名
    m = line.match(/^\s*\d{2,4}[/.-]\d{1,2}[/.-]\d{1,4}\s+\d{1,2}:\d{2}(?:\s*[APMapm]{2})?\s+([\d,，]+)\s+(\S.*?)\s*$/);
    if (m) {
      files.push({ name: m[2].trim(), size: _toInt(m[1]) });
      signals++;
      continue;
    }
    // Unix ls -l：权限位开头
    m = line.match(/^([dl-])([rwxsStTl-]{9})[.+@]?\s+\d+\s+\S+\s+\S+\s+(\d+)\s+\S+\s+\d{1,2}(?:\s+[\d:]+)?\s+(.+?)\s*$/);
    if (m) {
      const type = m[1];
      const name = m[4].replace(/\s*->\s*.*$/, '').trim(); // 去掉软链目标
      if (name && name !== '.' && name !== '..') {
        if (type === 'd') dirs.push(name);
        else files.push({ name, size: _toInt(m[3]) });
        signals++;
      }
      continue;
    }
  }

  // 零误报闸门：必须有足够清单信号，且至少有一个条目或可用空间页脚。
  if (signals < 2 || (dirs.length + files.length === 0 && freeBytes == null)) return null;
  return { path: dirPath, dirs, files, freeBytes };
}

function looksLikeDirectoryListing(text) {
  return parseDirectoryListing(text) != null;
}

function _joinCapped(items, cap) {
  const head = items.slice(0, cap);
  const more = items.length > cap ? `…等 ${items.length} 项` : '';
  return head.join('、') + (more ? `（${more}）` : '');
}

/**
 * 把一段目录清单归纳为结论式总结（中文）。不是清单则返回 null。
 */
function summarizeDirectoryListing(text) {
  const p = parseDirectoryListing(text);
  if (!p) return null;
  const total = p.dirs.length + p.files.length;
  const where = p.path ? `${p.path} ` : '';
  const free = p.freeBytes != null ? `，可用空间约 ${_humanSize(p.freeBytes)}` : '';
  const lines = [`${where}共 ${total} 项：${p.dirs.length} 个目录、${p.files.length} 个文件${free}。`];
  if (p.dirs.length) lines.push(`目录：${_joinCapped(p.dirs, 12)}`);
  if (p.files.length) {
    const fileStrs = p.files.map((f) => (f.size != null ? `${f.name}（${_humanSize(f.size)}）` : f.name));
    lines.push(`文件：${_joinCapped(fileStrs, 12)}`);
  }
  return lines.join('\n');
}

/**
 * 对单段工具输出做模型无关总结：优先目录清单，其次散文摘要，否则行数/截断摘要。
 */
function summarizeToolOutput(text, opts = {}) {
  const body = String(text || '');
  if (!body.trim()) return '';
  const dir = summarizeDirectoryListing(body);
  if (dir) return dir;

  // 散文：交给 localNlp 抽取式摘要（失败则 fail-soft 走截断）。
  try {
    const nlp = require('./localNlp');
    const s = nlp.summarize(body, { query: opts.query || '', maxSentences: 3, maxChars: 400 });
    if (s && s.length < body.length) return s;
  } catch { /* fail-soft */ }

  // 结构化/非散文文本：给"共 N 行"+前几行作为摘要。
  const rows = body.split(/\r?\n/).filter((l) => l.trim());
  if (rows.length > 6) {
    return `共 ${rows.length} 行，前 5 行：\n${rows.slice(0, 5).join('\n')}\n…`;
  }
  return body.length > 400 ? `${body.slice(0, 400)}…` : body;
}

/**
 * 汇总整轮工具台账为一段总结。供收尾兜底（salvage）使用：成功结果各归纳一段。
 * @param {Array} toolCallLog
 * @param {object} [opts] { query }
 * @returns {string} 空串表示无可总结数据
 */
function summarizeToolData(toolCallLog, opts = {}) {
  if (!Array.isArray(toolCallLog)) return '';
  const blocks = [];
  for (const entry of toolCallLog) {
    const r = entry && entry.result;
    if (!r || r.success !== true) continue;
    let text = '';
    if (typeof r.output === 'string' && r.output.trim()) text = r.output.trim();
    else if (Array.isArray(r.results) && r.results.length) {
      text = r.results.map((it, i) => {
        if (it == null) return '';
        if (typeof it === 'string') return `${i + 1}. ${it}`;
        const title = it.title || it.name || it.headline || '';
        const snippet = it.snippet || it.summary || it.description || '';
        return `${i + 1}. ${title}${snippet ? ` — ${snippet}` : ''}`.trim();
      }).filter(Boolean).join('\n');
    } else if (typeof r.content === 'string' && r.content.trim()) text = r.content.trim();
    if (!text) continue;
    const label = entry && entry.tool ? `【${entry.tool}】` : '';
    const digest = summarizeToolOutput(text, opts);
    if (digest) blocks.push(label ? `${label}\n${digest}` : digest);
  }
  return blocks.join('\n\n');
}

module.exports = {
  isEnabled,
  parseDirectoryListing,
  looksLikeDirectoryListing,
  summarizeDirectoryListing,
  summarizeToolOutput,
  summarizeToolData,
};
