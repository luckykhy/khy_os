#!/usr/bin/env node
/**
 * Khy-OS 文档站生成器（离线、确定性、无新增依赖）
 * ------------------------------------------------------------------
 * 作用：把仓库里每一个 Markdown（*.md）渲染成一份同名的 HTML（*.html），
 *      放在 .md 旁边；套用统一模板（顶栏 + 侧边栏全站导航 + 面包屑 + 目录
 *      + 上/下一页 + mermaid 图 + 代码高亮 + 滚动动画），并把正文里指向
 *      其它 .md 的链接改写成指向对应的 .html，实现「HTML 跳转到相关 HTML」。
 *
 * 设计约束（对齐 CLAUDE.md）：
 *   - 确定性：同样输入 => 同样输出（不含时间戳/随机数），可重复运行。
 *   - 离线自包含：图表用 docs/_assets/mermaid.min.js，代码高亮在构建期完成。
 *   - 外科手术式：只新增 .html 与 docs/_assets/nav-data.js，不改任何 .md 源文。
 *
 * HOW-TO-EXTEND（给维护者/小模型）：
 *   - 想改样式/动画 => 编辑 docs/_assets/docs-site.css / docs-site.js，然后重跑本脚本。
 *   - 想改 Markdown 支持的语法 => 改 renderMarkdown() 里的块级/行内规则。
 *   - 想改哪些目录参与生成 => 改 SKIP_DIRS / SKIP_PATH_PARTS。
 *
 * 用法：node scripts/docs/build_docs_site.js [--quiet]
 * 校验：node scripts/docs/verify_docs_site.js
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const ASSETS_DIRNAME = path.join("docs", "_assets");
const QUIET = process.argv.includes("--quiet");

// 不参与生成的目录（node_modules、构建产物、供应商副本、归档、爬取样本）
const SKIP_DIRS = new Set([
  ".git", "node_modules", "build", "dist", ".venv", "venv", "coverage",
  "__pycache__", ".pytest_cache", ".tox", "muya-embed", "national-exam-site",
  "_archive_已删除孤儿引擎", ".claude", ".khy",
]);
// 路径片段命中即跳过（bundled 是打包时生成的副本，非源文）
const SKIP_PATH_PARTS = ["/bundled/", "/_assets/"];

// ---- 构建期代码高亮（可选，缺失则优雅降级为纯转义代码块）----
let hljs = null;
try {
  hljs = require(path.join(
    ROOT, "software/khyquant/frontend/node_modules/highlight.js"
  ));
} catch (_) {
  try { hljs = require("highlight.js"); } catch (_2) { hljs = null; }
}

// ============================================================
// 工具函数
// ============================================================
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function escapeAttr(s) { return escapeHtml(s).replace(/'/g, "&#39;"); }

// 标题 -> 锚点 id（保留中英文，其余转连字符），页面内去重
function makeSlugger() {
  const seen = Object.create(null);
  return function (text) {
    let base = String(text).trim().toLowerCase()
      .replace(/<[^>]+>/g, "")
      .replace(/[^\p{L}\p{N}一-鿿]+/gu, "-")
      .replace(/^-+|-+$/g, "") || "section";
    let slug = base, i = 1;
    while (seen[slug]) { i += 1; slug = base + "-" + i; }
    seen[slug] = true;
    return slug;
  };
}

// 相对路径前缀：从某个 html 文件所在目录，到仓库根的 "../" 串
function rootPrefixFor(relFilePath) {
  const depth = relFilePath.split("/").length - 1;
  return depth === 0 ? "./" : "../".repeat(depth);
}

// 把正文里的 .md 链接改写成 .html（仅本地相对链接，忽略 http/锚点/mailto）
function rewriteMdLink(href) {
  if (/^(https?:|mailto:|#|\/\/)/i.test(href)) return href;
  const hashIdx = href.indexOf("#");
  const anchor = hashIdx >= 0 ? href.slice(hashIdx) : "";
  let pathPart = hashIdx >= 0 ? href.slice(0, hashIdx) : href;
  if (/\.md$/i.test(pathPart)) pathPart = pathPart.replace(/\.md$/i, ".html");
  return pathPart + anchor;
}

// ============================================================
// Markdown 渲染（GFM 子集：够用、健壮、可预测）
// ============================================================
function renderInline(text) {
  // 先保护行内代码，避免其中的特殊字符被当作标记
  const codeStore = [];
  text = text.replace(/`([^`]+)`/g, (_m, c) => {
    codeStore.push("<code>" + escapeHtml(c) + "</code>");
    return " C" + (codeStore.length - 1) + " ";
  });

  text = escapeHtml(text);

  // 悬浮弹窗（纯 CSS 提示气泡）：+[显示文字](悬浮解释)。必须先于图片/链接规则，
  // 否则其括号内的解释会被误当成链接地址。解释内可含中文标点，用 [^)] 匹配。
  text = text.replace(/\+\[([^\]]+)\]\(([^)]+)\)/g,
    (_m, label, tip) =>
      `<span class="popover" tabindex="0"><span class="popover-anchor">${label}</span>` +
      `<span class="popover-tip" role="tooltip">${tip}</span></span>`);

  // 图片 ![alt](src "title")
  text = text.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/g,
    (_m, alt, src, title) =>
      `<img src="${escapeAttr(src)}" alt="${escapeAttr(alt)}"${title ? ` title="${escapeAttr(title)}"` : ""} loading="lazy">`);

  // 链接 [text](href "title")
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/g,
    (_m, label, href, title) => {
      const h = rewriteMdLink(href);
      const ext = /^https?:/i.test(h) ? ' target="_blank" rel="noopener"' : "";
      return `<a href="${escapeAttr(h)}"${title ? ` title="${escapeAttr(title)}"` : ""}${ext}>${label}</a>`;
    });

  // 自动链接 <http...>
  text = text.replace(/&lt;(https?:\/\/[^\s&]+)&gt;/g,
    (_m, url) => `<a href="${escapeAttr(url)}" target="_blank" rel="noopener">${url}</a>`);

  // 粗体 / 斜体 / 删除线
  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  text = text.replace(/(^|[^*])\*([^*\s][^*]*?)\*/g, "$1<em>$2</em>");
  text = text.replace(/~~([^~]+)~~/g, "<del>$1</del>");

  // 还原行内代码
  text = text.replace(/ C(\d+) /g, (_m, i) => codeStore[Number(i)]);
  return text;
}

function highlightCode(code, lang) {
  if (hljs && lang && hljs.getLanguage && hljs.getLanguage(lang)) {
    try { return hljs.highlight(code, { language: lang }).value; } catch (_) { /* fall */ }
  }
  return escapeHtml(code);
}

// ============================================================
// 交互组件（面向小白：吉祥物插话 / 练习互动 / 翻卡动画 / 悬浮弹窗）
// 全部离线、无外部依赖；交互逻辑在 docs/_assets/docs-site.js。
// ------------------------------------------------------------
// HOW-TO-EXTEND（作者抄写式用法，写在任意 .md 里）：
//   1) 吉祥物插话：  ```callout tip|小提示   （kind ∈ tip/note/warn/star/ask，
//                    竖线后可选自定义标题）正文支持 markdown。
//   2) 练习互动：    ```quiz  内含 `Q: 题干` + `- [ ]/-[x] 选项` + `> 解释`。
//   3) 翻卡动画：    ```flip  用一行 `---` 分隔正面/背面。
//   4) 悬浮弹窗：    行内写 +[显示文字](悬浮解释) —— 纯 CSS 弹出，无需点击。
//   5) 时间轴：      ```timeline  每行 `标签 | 描述`，展示演进/阶段流程。
// ============================================================
const CALLOUT_KINDS = {
  tip:  { icon: "💡", label: "小提示",   mascot: "🐣" },
  note: { icon: "📌", label: "小笔记",   mascot: "🐧" },
  warn: { icon: "⚠️", label: "要小心",   mascot: "🦉" },
  star: { icon: "⭐", label: "划重点",   mascot: "🦊" },
  ask:  { icon: "🙋", label: "小白发问", mascot: "🐥" },
};

// 吉祥物插话：一段带表情吉祥物的旁白，用来把话「插」在正文里。
function renderCallout(info, body) {
  const rest = String(info).replace(/^callout\b/i, "").trim();
  const parts = rest.split("|").map((s) => s.trim());
  const kind = (parts[0] || "tip").toLowerCase();
  const k = CALLOUT_KINDS[kind] || CALLOUT_KINDS.tip;
  const title = parts[1] || k.label;
  const inner = renderMarkdown(body).html;
  return `<aside class="callout callout-${escapeAttr(kind)} reveal">` +
    `<div class="callout-mascot" aria-hidden="true">${k.mascot}</div>` +
    `<div class="callout-body">` +
    `<div class="callout-title">${k.icon} ${escapeHtml(title)}</div>` +
    inner + `</div></aside>`;
}

// 练习互动：单选/多选小测；点选项后由 JS 判对错并揭示解释。
function renderQuiz(body) {
  const rows = body.split("\n");
  let question = "";
  const options = [];
  const explain = [];
  for (const raw of rows) {
    const line = raw.replace(/\s+$/, "");
    let m;
    if ((m = line.match(/^\s*(?:Q[:：]|问[:：])\s*(.*)$/i))) { question = m[1]; }
    else if ((m = line.match(/^\s*[-*]\s*\[([ xX])\]\s*(.*)$/))) {
      options.push({ correct: m[1].toLowerCase() === "x", text: m[2] });
    } else if ((m = line.match(/^\s*>\s?(.*)$/))) { explain.push(m[1]); }
    else if (line.trim() && !question) { question = line.trim(); }
  }
  const multi = options.filter((o) => o.correct).length > 1;
  const opts = options.map((o, idx) =>
    `<li class="quiz-opt"><button type="button" class="quiz-choice" data-correct="${o.correct ? "1" : "0"}">` +
    `<span class="quiz-key">${String.fromCharCode(65 + idx)}</span>` +
    `<span class="quiz-text">${renderInline(o.text)}</span></button></li>`
  ).join("");
  const expl = explain.length
    ? `<div class="quiz-explain" hidden>💬 ${renderInline(explain.join("\n")).replace(/\n/g, "<br>")}</div>`
    : "";
  return `<div class="quiz reveal" data-multi="${multi ? "1" : "0"}">` +
    `<div class="quiz-q">🧠 ${renderInline(question)}</div>` +
    `<ul class="quiz-opts">${opts}</ul>` +
    `<div class="quiz-feedback" aria-live="polite"></div>${expl}</div>`;
}

// 翻卡动画：正面提问、点一下 3D 翻转看背面答案。
function renderFlip(body) {
  const rows = body.split("\n");
  const sep = rows.findIndex((l) => /^\s*---\s*$/.test(l));
  let front, back;
  if (sep >= 0) {
    front = rows.slice(0, sep).join("\n").trim();
    back = rows.slice(sep + 1).join("\n").trim();
  } else { front = body.trim(); back = ""; }
  const ri = (s) => renderInline(s).replace(/\n/g, "<br>");
  return `<div class="flip reveal" tabindex="0" role="button" aria-label="点击翻转卡片">` +
    `<div class="flip-inner">` +
    `<div class="flip-face flip-front">${ri(front)}<div class="flip-hint">👆 点我翻面看答案</div></div>` +
    `<div class="flip-face flip-back">${ri(back)}</div>` +
    `</div></div>`;
}

// 时间轴：把「技术演进 / 阶段流程」摊成竖向时间线，逐条滚动进入。
// 每行 `标签 | 描述`，以第一个 | 分割（描述可含 |）；空行忽略；无 | 的行整行当描述。
// 进入动画复用 .reveal（由 docs-site.js 的 initReveal 自动接管），本函数零额外 JS。
function renderTimeline(body) {
  const ri = (s) => renderInline(s).replace(/\n/g, "<br>");
  const items = body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => {
      const bar = l.indexOf("|");
      const label = bar >= 0 ? l.slice(0, bar).trim() : "";
      const desc = bar >= 0 ? l.slice(bar + 1).trim() : l;
      return `<li class="timeline-item reveal">` +
        `<span class="timeline-dot" aria-hidden="true"></span>` +
        `<div class="timeline-label">${ri(label)}</div>` +
        `<div class="timeline-desc">${ri(desc)}</div>` +
        `</li>`;
    })
    .join("");
  return `<ol class="timeline">${items}</ol>`;
}

// 画面场景（漫画分镜）：把一段流程演成一幕小短剧，逐格滚动进入。
// 作者语法（每行一格）：
//   对话行 `表情 角色 | 台词`（以第一个 | 分割；台词可含 |）——渲染成左右交替的对话气泡；
//   旁白行 `> 画外音`（以 > 开头）——渲染成一格居中的旁白条，不带气泡；
//   无 | 且非 > 的行——整行当纯旁白台词兜底（fail-soft，不报错）。
// 标题放 fence info 段（```scene 我的标题），可省略。emoji 当画=离线自包含；
// 每格挂 .reveal（由 docs-site.js 的 initReveal 自动接管），本函数零额外 JS。
function renderScene(info, body) {
  const ri = (s) => renderInline(s).replace(/\n/g, "<br>");
  let sideFlip = 0; // 对话格左右交替计数（不靠 CSS nth，避免旁白格打乱节奏）
  const panels = body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => {
      if (l.startsWith(">")) {
        const cap = l.replace(/^>\s?/, "").trim();
        return `<div class="scene-caption reveal">${ri(cap)}</div>`;
      }
      const bar = l.indexOf("|");
      if (bar < 0) {
        // 没有 | 的普通行：当纯旁白台词兜底
        return `<div class="scene-caption reveal">${ri(l)}</div>`;
      }
      const who = l.slice(0, bar).trim();
      const say = l.slice(bar + 1).trim();
      // 角色头 = 首个「表情 + 名字」：拆出行首 emoji/符号当头像，其余当名字
      const m = who.match(/^(\S+)\s+([\s\S]+)$/);
      const avatar = m ? m[1] : who;
      const name = m ? m[2] : "";
      const side = sideFlip % 2 === 0 ? "scene-left" : "scene-right";
      sideFlip += 1;
      const nameHtml = name ? `<b class="scene-who">${ri(name)}</b>` : "";
      return `<div class="scene-panel ${side} reveal">` +
        `<span class="scene-avatar" aria-hidden="true">${escapeHtml(avatar)}</span>` +
        `<div class="scene-bubble">${nameHtml}${ri(say)}</div>` +
        `</div>`;
    })
    .join("");
  const title = String(info || "").replace(/^scene\b/i, "").trim();
  const titleHtml = title ? `<div class="scene-title">${ri(title)}</div>` : "";
  return `<div class="scene">${titleHtml}${panels}</div>`;
}

// 主渲染：返回 { html, headings: [{level, text, id}] }
function renderMarkdown(src) {
  const slug = makeSlugger();
  const headings = [];
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let i = 0;

  function renderListBlock(startIdx) {
    // 收集连续列表行（含缩进子项），产出嵌套 ul/ol
    const items = [];
    let idx = startIdx;
    const re = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
    while (idx < lines.length) {
      const m = lines[idx].match(re);
      if (!m) {
        // 空行后：仅当下一行仍是「同种」列表项（有序/无序一致）才续接，
        // 否则视为两个相邻但独立的列表，避免把 ul 和 ol 合并成一个。
        if (lines[idx].trim() === "" && idx + 1 < lines.length) {
          const nx = lines[idx + 1].match(re);
          if (nx && items.length && (/\d/.test(nx[2]) === items[items.length - 1].ordered)) {
            idx += 1; continue;
          }
        }
        break;
      }
      items.push({ indent: m[1].replace(/\t/g, "    ").length, ordered: /\d/.test(m[2]), text: m[3] });
      idx += 1;
    }
    // 递归按缩进构树
    function build(list, pos, minIndent) {
      let html = "";
      let ordered = list[pos] && list[pos].ordered;
      html += ordered ? "<ol>" : "<ul>";
      while (pos < list.length && list[pos].indent >= minIndent) {
        const cur = list[pos];
        let li = "<li>" + renderInline(cur.text);
        pos += 1;
        if (pos < list.length && list[pos].indent > cur.indent) {
          const sub = build(list, pos, list[pos].indent);
          li += sub.html;
          pos = sub.pos;
        }
        li += "</li>";
        html += li;
      }
      html += ordered ? "</ol>" : "</ul>";
      return { html, pos };
    }
    const built = build(items, 0, items[0].indent);
    return { html: built.html, nextIdx: idx };
  }

  while (i < lines.length) {
    let line = lines[i];

    // 空行
    if (line.trim() === "") { i += 1; continue; }

    // 围栏代码块 ``` / ~~~（含交互组件：callout / quiz / flip / mermaid）
    const fence = line.match(/^(\s*)(```+|~~~+)\s*([\w-]*)(.*)$/);
    if (fence) {
      const marker = fence[2][0];
      const info = ((fence[3] || "") + (fence[4] || "")).trim();
      const lang = (fence[3] || "").toLowerCase();
      const buf = [];
      i += 1;
      while (i < lines.length && !new RegExp("^\\s*" + marker + "{3,}\\s*$").test(lines[i])) {
        buf.push(lines[i]); i += 1;
      }
      i += 1; // 跳过结束围栏
      const code = buf.join("\n");
      if (lang === "mermaid") {
        out.push('<pre class="mermaid">' + escapeHtml(code) + "</pre>");
      } else if (lang === "callout") {
        out.push(renderCallout(info, code));
      } else if (lang === "quiz") {
        out.push(renderQuiz(code));
      } else if (lang === "flip") {
        out.push(renderFlip(code));
      } else if (lang === "timeline") {
        out.push(renderTimeline(code));
      } else if (lang === "scene") {
        out.push(renderScene(info, code));
      } else {
        const cls = lang ? ` class="language-${lang}"` : "";
        out.push(`<pre><code${cls}>` + highlightCode(code, lang) + "</code></pre>");
      }
      continue;
    }

    // 标题 # .. ######
    const h = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (h) {
      const level = h[1].length;
      const text = h[2];
      const id = slug(text);
      if (level <= 3) headings.push({ level, text: text.replace(/<[^>]+>/g, ""), id });
      out.push(
        `<h${level} id="${escapeAttr(id)}">${renderInline(text)}` +
        `<a class="anchor" href="#${escapeAttr(id)}" aria-label="锚点">#</a></h${level}>`
      );
      i += 1; continue;
    }

    // 水平线
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push("<hr>"); i += 1; continue; }

    // 引用块
    if (/^\s*>/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, "")); i += 1;
      }
      const inner = renderMarkdown(buf.join("\n"));
      out.push("<blockquote>" + inner.html + "</blockquote>");
      continue;
    }

    // 表格（GFM 管道表：表头 + 分隔行）
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length &&
        /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && lines[i + 1].includes("-")) {
      const splitRow = (r) => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const header = splitRow(line);
      const aligns = splitRow(lines[i + 1]).map((c) => {
        const l = c.startsWith(":"), r = c.endsWith(":");
        return l && r ? "center" : r ? "right" : l ? "left" : "";
      });
      i += 2;
      const body = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { body.push(splitRow(lines[i])); i += 1; }
      let t = "<table><thead><tr>";
      header.forEach((c, k) => { t += `<th${aligns[k] ? ` style="text-align:${aligns[k]}"` : ""}>${renderInline(c)}</th>`; });
      t += "</tr></thead><tbody>";
      body.forEach((row) => {
        t += "<tr>";
        header.forEach((_c, k) => { t += `<td${aligns[k] ? ` style="text-align:${aligns[k]}"` : ""}>${renderInline(row[k] || "")}</td>`; });
        t += "</tr>";
      });
      t += "</tbody></table>";
      out.push(t);
      continue;
    }

    // 列表
    if (/^(\s*)([-*+]|\d+[.)])\s+/.test(line)) {
      const lb = renderListBlock(i);
      out.push(lb.html);
      i = lb.nextIdx;
      continue;
    }

    // 原样透传的 HTML 块（以 < 开头的常见块级标签）
    if (/^\s*<(\/?)(div|details|summary|table|section|figure|iframe|video|img|br|hr|p|ul|ol|li|span|a|h[1-6])\b/i.test(line)) {
      out.push(line);
      i += 1; continue;
    }

    // 普通段落：吃到空行或下一个块的开始
    const para = [];
    while (i < lines.length && lines[i].trim() !== "" &&
      !/^(\s*)(#{1,6}\s|>|```|~~~|[-*+]\s|\d+[.)]\s)/.test(lines[i]) &&
      !/^\s*\|.*\|\s*$/.test(lines[i]) &&
      !/^\s*([-*_])(\s*\1){2,}\s*$/.test(lines[i])) {
      para.push(lines[i]); i += 1;
    }
    if (!para.length) {
      // 保证前进：某些行既没被上面的块级规则消费，又被段落起始条件排除
      // （典型：缺少分隔行的孤立表格行 `| a | b |`）。若不强制消费，i 不前进
      // 会造成死循环。这里把当前行当作独立段落输出并前进一行。
      para.push(lines[i]); i += 1;
    }
    out.push("<p>" + renderInline(para.join("\n").trim()).replace(/\n/g, "<br>") + "</p>");
  }

  return { html: out.join("\n"), headings };
}

// ============================================================
// 文件枚举 + 站点结构
// ============================================================
function walkMarkdown(dir, acc) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return acc; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    const rel = path.relative(ROOT, full).split(path.sep).join("/");
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      if (SKIP_PATH_PARTS.some((p) => ("/" + rel + "/").includes(p))) continue;
      walkMarkdown(full, acc);
    } else if (e.isFile() && /\.md$/i.test(e.name)) {
      if (SKIP_PATH_PARTS.some((p) => ("/" + rel).includes(p))) continue;
      acc.push(rel);
    }
  }
  return acc;
}

function firstHeading(src) {
  const m = src.match(/^\s*#{1,6}\s+(.+?)\s*#*\s*$/m);
  return m ? m[1].replace(/[`*_]/g, "").trim() : null;
}

// 顶层分组名（docs 下用二级目录，其它用一级目录）
function groupOf(rel) {
  const parts = rel.split("/");
  if (parts[0] === "docs") return parts.length > 1 ? "docs / " + parts[1] : "docs";
  return parts[0];
}

// ============================================================
// 模板
// ============================================================
function pageTemplate(opts) {
  const { rootPrefix, curHref, title, crumb, bodyHtml, toc, pager, headings } = opts;
  const assets = rootPrefix + ASSETS_DIRNAME.split(path.sep).join("/") + "/";
  const tocHtml = headings.length >= 3
    ? `<nav class="toc reveal"><div class="toc-title">本页目录</div><ul>` +
      headings.map((hd) => `<li class="lvl-${hd.level}"><a href="#${escapeAttr(hd.id)}">${escapeHtml(hd.text)}</a></li>`).join("") +
      `</ul></nav>`
    : "";
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · Khy-OS 文档</title>
<link rel="stylesheet" href="${assets}hljs-github-dark.min.css">
<link rel="stylesheet" href="${assets}docs-site.css">
</head>
<body>
<div class="topbar">
  <button class="menu-toggle" aria-label="菜单">☰</button>
  <a class="brand" href="${rootPrefix}docs/index.html">📘 Khy-OS 文档站</a>
  <span class="spacer"></span>
  <a href="${rootPrefix}docs/02_CONCEPTS_概念入门/00_INDEX_概念入门-总览.html">🧭 新手先读：核心概念</a>
</div>
<div class="layout">
  <aside class="sidebar" id="sidebar">
    <input class="search" type="search" placeholder="🔍 过滤文档标题…" aria-label="过滤文档">
    <div id="nav-root"></div>
  </aside>
  <main class="main">
    <div class="content">
      <div class="breadcrumb reveal">${crumb}</div>
      <header class="hero reveal"><h1>${escapeHtml(title)}</h1></header>
      ${tocHtml}
      <article class="doc-body">
${bodyHtml}
      </article>
      ${pager}
      <div class="footer reveal">本页由 <code>scripts/docs/build_docs_site.js</code> 从对应的 <code>.md</code> 自动生成 · 离线可用 · Khy-OS 文档站</div>
    </div>
  </main>
</div>
<script>window.__KHY_ROOT__=${JSON.stringify(rootPrefix)};window.__KHY_CUR__=${JSON.stringify(curHref)};</script>
<script src="${assets}nav-data.js"></script>
<script src="${assets}mermaid.min.js"></script>
<script src="${assets}docs-site.js"></script>
</body>
</html>`;
}

// 把指向「本地不存在目标」的链接降级为纯文本，保证站内不出现断链。
// 背景：部分源 .md 里存在陈旧引用（指向已归档文档、已移动的源码、/tmp 路径、
// 或畸形 href）。生成器已正确改写 .md→.html，但目标本就不存在——这些是
// pre-existing 的内容缺陷，且约束要求不改动源 .md。这里在产出 HTML 后统一
// 把「解析不到真实文件」的 <a>/<img> 降级：<a> 变纯文本 <span>，<img> 变占位。
// 命中项写入 docs/_assets/dead-links.json 供审计（数量大 => 提示系统性路径 bug）。
function neutralizeDeadLinks(html, htmlAbsPath, deadAcc, willExist) {
  const dir = path.dirname(htmlAbsPath);
  const fromRel = path.relative(ROOT, htmlAbsPath).split(path.sep).join("/");
  const isExternal = (h) => /^(https?:|mailto:|data:|#|\/\/|javascript:)/i.test(h);
  const resolvesLocally = (h) => {
    const p = h.split("#")[0].split("?")[0];
    if (!p) return true; // 纯锚点，页内跳转
    let target;
    try { target = path.resolve(dir, decodeURIComponent(p)); } catch (_) { target = path.resolve(dir, p); }
    // willExist 收录所有「本次会生成的 .html」，避免生成顺序造成的假断链
    // （例如首页 index.html 最后才写）；其余源码/资源用真实存在性判断。
    return (willExist && willExist.has(target)) || fs.existsSync(target);
  };
  html = html.replace(/<a\b([^>]*?)href="([^"]*)"([^>]*)>([\s\S]*?)<\/a>/g,
    (m, _pre, href, _post, inner) => {
      if (isExternal(href) || resolvesLocally(href)) return m;
      deadAcc.push({ from: fromRel, type: "a", href });
      return `<span class="deadlink" title="目标不存在：${escapeAttr(href)}">${inner}</span>`;
    });
  html = html.replace(/<img\b([^>]*?)src="([^"]*)"([^>]*)>/g,
    (m, _pre, src, _post) => {
      if (isExternal(src) || resolvesLocally(src)) return m;
      deadAcc.push({ from: fromRel, type: "img", href: src });
      const alt = (m.match(/alt="([^"]*)"/) || [, ""])[1];
      return `<span class="deadimg" title="图片不存在：${escapeAttr(src)}">🖼️ ${escapeHtml(alt || "图片缺失")}</span>`;
    });
  return html;
}

function buildCrumb(rel, rootPrefix, title) {
  const parts = rel.split("/");
  const bits = [`<a href="${rootPrefix}docs/index.html">首页</a>`];
  let acc = "";
  for (let k = 0; k < parts.length - 1; k += 1) {
    acc += (k ? "/" : "") + parts[k];
    bits.push(`<span class="sep">›</span>${escapeHtml(parts[k])}`);
  }
  bits.push(`<span class="sep">›</span>${escapeHtml(title)}`);
  return bits.join("");
}

// ============================================================
// 主流程
// ============================================================
function main() {
  const rels = walkMarkdown(ROOT, []).sort();
  const log = QUIET ? () => {} : (...a) => console.log(...a);

  // 读取标题 + 分组
  const docs = rels.map((rel) => {
    const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
    const title = firstHeading(src) || path.basename(rel, ".md");
    return { rel, src, title, htmlRel: rel.replace(/\.md$/i, ".html"), group: groupOf(rel) };
  });

  // 侧边栏导航数据（root-relative href）
  const groups = new Map();
  for (const d of docs) {
    if (!groups.has(d.group)) groups.set(d.group, []);
    groups.get(d.group).push({ title: d.title, href: d.htmlRel });
  }
  const navData = [...groups.entries()]
    .sort((a, b) => a[0].localeCompare(b[0], "zh"))
    .map(([group, items]) => ({ group, items: items.sort((x, y) => x.href.localeCompare(y.href, "zh")) }));
  fs.writeFileSync(
    path.join(ROOT, ASSETS_DIRNAME, "nav-data.js"),
    "/* 自动生成：勿手改。由 scripts/docs/build_docs_site.js 产出。 */\n" +
    "window.__KHY_NAV__=" + JSON.stringify(navData) + ";\n"
  );

  // 分组内排序用于 上一页/下一页
  const byGroup = new Map();
  for (const d of docs) {
    if (!byGroup.has(d.group)) byGroup.set(d.group, []);
    byGroup.get(d.group).push(d);
  }
  for (const arr of byGroup.values()) arr.sort((a, b) => a.htmlRel.localeCompare(b.htmlRel, "zh"));

  let count = 0;
  const deadLinks = [];
  // 本次会生成的全部 .html 绝对路径集合（含首页）：用于断链判定时把
  // 「尚未写盘但一定会生成」的目标视为存在，避免生成顺序造成假断链。
  const willExist = new Set(docs.map((d) => path.join(ROOT, d.htmlRel)));
  willExist.add(path.join(ROOT, "docs", "index.html"));
  for (const d of docs) {
    const rootPrefix = rootPrefixFor(d.htmlRel);
    const rendered = renderMarkdown(d.src);
    const crumb = buildCrumb(d.rel, rootPrefix, d.title);

    // pager
    const sib = byGroup.get(d.group);
    const pos = sib.indexOf(d);
    const prev = pos > 0 ? sib[pos - 1] : null;
    const next = pos < sib.length - 1 ? sib[pos + 1] : null;
    const relHref = (target) => rootPrefix + target.htmlRel;
    let pager = '<nav class="pager">';
    pager += prev
      ? `<a class="prev" href="${escapeAttr(relHref(prev))}"><div class="dir">← 上一篇</div><div class="ttl">${escapeHtml(prev.title)}</div></a>`
      : "<span></span>";
    pager += next
      ? `<a class="next" href="${escapeAttr(relHref(next))}"><div class="dir">下一篇 →</div><div class="ttl">${escapeHtml(next.title)}</div></a>`
      : "<span></span>";
    pager += "</nav>";

    const html = pageTemplate({
      rootPrefix, curHref: d.htmlRel, title: d.title, crumb,
      bodyHtml: rendered.html, headings: rendered.headings, pager,
    });
    const absPath = path.join(ROOT, d.htmlRel);
    fs.writeFileSync(absPath, neutralizeDeadLinks(html, absPath, deadLinks, willExist));
    count += 1;
  }

  // 首页 hub
  writeIndex(docs, navData, deadLinks, willExist);

  // 断链审计清单（可空）：数量应保持在「已知陈旧引用」的小尾巴内。
  fs.writeFileSync(
    path.join(ROOT, ASSETS_DIRNAME, "dead-links.json"),
    JSON.stringify({ total: deadLinks.length, items: deadLinks }, null, 2) + "\n"
  );
  log(`[docs-site] 生成 ${count} 个页面 + 首页 index.html + nav-data.js`);
  if (deadLinks.length) log(`[docs-site] 已降级 ${deadLinks.length} 个陈旧断链为纯文本（见 docs/_assets/dead-links.json）`);
  return count;
}

function writeIndex(docs, navData, deadLinks, willExist) {
  // 首页写在 docs/index.html（深度 1），因此 root 前缀是「../」，
  // 且卡片 href（nav-data 里是 root 相对，如 docs/xxx.html）要统一加上前缀，
  // 否则会从 docs/ 再拼一层 docs/ 造成双重目录断链。
  const rootPrefix = rootPrefixFor("docs/index.html");
  const cards = navData.map((g) => {
    const items = g.items.map((it) =>
      `<a class="card" href="${escapeAttr(rootPrefix + it.href)}"><span class="card-badge">${escapeHtml(g.group)}</span><div class="card-title">${escapeHtml(it.title)}</div></a>`
    );
    return { group: g.group, items };
  });
  const learnPath = [
    "flowchart LR",
    '  A["① 什么是 Agent<br/>智能体"] --> B["② Tool Calling<br/>工具调用"]',
    '  B --> C["③ Tool Loop<br/>工具循环"]',
    '  C --> D["④ MCP<br/>模型上下文协议"]',
    '  D --> E["⑤ Skill<br/>技能"]',
    '  E --> F["🚀 上手 Khy-OS"]',
  ].join("\n");

  const conceptGroup = cards.find((c) => c.group.includes("CONCEPTS") || c.group.includes("概念"));
  const rest = cards.filter((c) => c !== conceptGroup);

  const body =
    `<section class="reveal"><h2>🧭 新手学习路线</h2>` +
    `<p>如果你是第一次接触 AI 编程助手，按下面的顺序读五个核心概念，再上手 Khy-OS。每个方框都可点进对应文档。</p>` +
    `<pre class="mermaid">${escapeHtml(learnPath)}</pre></section>` +
    (conceptGroup ? `<section class="reveal"><h2>📖 核心概念（先读这个）</h2><div class="card-grid">${conceptGroup.items.join("")}</div></section>` : "") +
    rest.map((c) =>
      `<section class="reveal"><h2>${escapeHtml(c.group)}</h2><div class="card-grid">${c.items.join("")}</div></section>`
    ).join("\n");

  const html = pageTemplate({
    rootPrefix, curHref: "docs/index.html", title: "Khy-OS 文档站 · 首页",
    crumb: `<a href="${rootPrefix}docs/index.html">首页</a>`,
    bodyHtml: body, headings: [], pager: "",
  });
  fs.writeFileSync(path.join(ROOT, "docs", "index.html"),
    neutralizeDeadLinks(html, path.join(ROOT, "docs", "index.html"), deadLinks || [], willExist));
}

if (require.main === module) {
  try { main(); }
  catch (e) { console.error("[docs-site] 生成失败:", e && e.stack || e); process.exit(1); }
}

module.exports = { renderMarkdown, makeSlugger, rewriteMdLink, rootPrefixFor };
