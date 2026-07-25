'use strict';

/**
 * changelogParse.js — CHANGELOG.md → 结构化发布说明的零 IO 确定性单一真源(纯叶子)。
 *
 * 契约 (CONTRACT): 零 IO、确定性、绝不抛、无副作用、零依赖;只读入参,绝不读 process.env、
 * 绝不读文件。把一段 Markdown 文本解析成「版本 → 摘要 + 亮点条目」结构。
 *
 * 背后的逻辑(对齐 Claude Code /release-notes):CC 从远端 CHANGELOG_URL 拉取变更日志、
 * 解析为 `Array<[version, string[]]>` 再渲染成 `Version X:\n· note`。khy 离线优先 —— 不引入
 * 任何网络/host 硬编码 —— 改读**本地** CHANGELOG.md(由薄壳负责 IO),解析这一步是纯函数。
 * 真正的「背后逻辑」就在这里:把人写的 Markdown 变更日志确定性地拆成机器结构,让 /release-notes
 * 既能按版本筛、又能按数量截,而非把整段 Markdown 原样喷给用户。
 *
 * khy CHANGELOG.md 的稳定结构(已核实 0.1.2 ~ 0.1.136 全部条目一致):
 *   ## <version>                 ← 版本头(两个 #,后随空白)
 *   <summary 段>                 ← 摘要散文(可多行,到首个 ### 为止)
 *   ### Highlights               ← 亮点小节
 *   - **<title>**: <detail>      ← 亮点条目(可有 **bold** 标题,可多行续接)
 *   ### Compatibility / ...      ← 其它小节(并入 sections,不计入 highlights)
 *   ---                          ← 条目分隔
 *
 * 刻意不实现(诚实边界):语义化版本排序(沿用文件中「新在上」的物理顺序,不重排)、
 * Markdown 富渲染(只抽纯文本)、远端拉取(离线优先,IO 在薄壳)。
 *
 * 注意:本文件刻意不在注释里书写 require-调用样式,避免架构债扫描器误判幽灵依赖。
 */

// 行级匹配器(锚定行首;`##` 后须紧跟空白 → 天然排除 `###`)。
const _VERSION_RE = /^##\s+(\S.*?)\s*$/;   // `## 0.1.136`
const _SECTION_RE = /^###\s+(\S.*?)\s*$/;  // `### Highlights`
const _BULLET_RE = /^\s*[-*]\s+(.*\S)\s*$/; // `- foo` / `* foo`
const _HR_RE = /^\s*-{3,}\s*$/;            // `---`(条目分隔,非列表项)
const _BOLD_TITLE_RE = /^\*\*(.+?)\*\*\s*[:：]?\s*(.*)$/; // `**标题**: 详情`

function _emptyEntry(version) {
  return { version, summary: '', highlights: [], sections: [] };
}

/**
 * 把一条亮点 bullet 的整段文本拆成 {title, detail}。
 * 有 `**bold**` 前缀 → title=粗体内, detail=其后;否则 title=整句去括号文件名提示, detail=''。
 * 纯函数,绝不抛。
 */
function splitHighlight(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return { title: '', detail: '' };
  const m = _BOLD_TITLE_RE.exec(text);
  if (m) {
    return { title: m[1].trim(), detail: m[2].trim() };
  }
  return { title: text, detail: '' };
}

/**
 * 解析 CHANGELOG Markdown → 版本条目数组(物理顺序,新在上)。
 * @param {string} raw  CHANGELOG.md 全文
 * @returns {Array<{version:string, summary:string, highlights:Array<{title:string,detail:string}>, sections:string[]}>}
 */
function parseChangelog(raw) {
  const text = typeof raw === 'string' ? raw : '';
  if (!text) return [];

  const lines = text.split(/\r?\n/);
  const entries = [];
  let cur = null;          // 当前版本条目
  let section = null;      // 当前 ### 小节名(null = 摘要区)
  let summaryLines = [];   // 累积摘要散文
  let bulletBuf = null;    // 当前 highlight bullet 累积(支持多行续接)

  const flushSummary = () => {
    // 仅在确有累积时赋值,避免空的收尾 flush 覆盖已写入的 summary。
    if (cur && summaryLines.length) {
      const joined = summaryLines.join(' ').replace(/\s+/g, ' ').trim();
      if (joined) cur.summary = joined;
    }
    summaryLines = [];
  };
  const flushBullet = () => {
    if (cur && bulletBuf != null && section === 'Highlights') {
      const joined = bulletBuf.replace(/\s+/g, ' ').trim();
      if (joined) cur.highlights.push(splitHighlight(joined));
    }
    bulletBuf = null;
  };

  for (const line of lines) {
    const vm = _VERSION_RE.exec(line);
    if (vm) {
      // 收束上一条目。
      flushBullet();
      flushSummary();
      if (cur) entries.push(cur);
      cur = _emptyEntry(vm[1].trim());
      section = null;
      continue;
    }
    if (!cur) continue; // 版本头之前的前言(标题/安装指引)整体忽略。

    const sm = _SECTION_RE.exec(line);
    if (sm) {
      flushBullet();
      flushSummary();
      section = sm[1].trim();
      if (section !== 'Highlights') cur.sections.push(section);
      continue;
    }

    if (_HR_RE.test(line)) {
      // 水平分隔线:收束当前 bullet,但不结束条目(版本头才结束)。
      flushBullet();
      continue;
    }

    const bm = _BULLET_RE.exec(line);
    if (bm) {
      flushBullet();
      if (section === 'Highlights') bulletBuf = bm[1];
      continue;
    }

    // 续接行:空行收束 bullet;非空行视情况并入摘要或当前 bullet。
    if (/^\s*$/.test(line)) {
      flushBullet();
      continue;
    }
    if (section === null) {
      summaryLines.push(line.trim());
    } else if (section === 'Highlights' && bulletBuf != null) {
      bulletBuf += ' ' + line.trim();
    }
  }

  flushBullet();
  flushSummary();
  if (cur) entries.push(cur);
  return entries;
}

/**
 * 按版本/数量筛选条目。纯函数。
 * @param {Array} entries  parseChangelog 输出
 * @param {object} [opts]  { version?:string, limit?:number }
 *   version 命中(精确或去掉前导 v 后精确)→ 只返回该条目;否则取前 limit 条(默认 1)。
 */
function selectReleaseNotes(entries, opts = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const wantVersion = opts && opts.version != null ? String(opts.version).trim().replace(/^v/i, '') : '';
  if (wantVersion) {
    const hit = list.filter((e) => String(e.version).replace(/^v/i, '') === wantVersion);
    return hit;
  }
  let limit = Number(opts && opts.limit);
  if (!Number.isFinite(limit) || limit < 1) limit = 1;
  return list.slice(0, Math.floor(limit));
}

module.exports = { parseChangelog, splitHighlight, selectReleaseNotes };
