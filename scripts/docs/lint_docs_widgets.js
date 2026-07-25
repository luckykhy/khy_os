#!/usr/bin/env node
/**
 * Khy-OS 文档互动件体检器（面向"一个人也能维护"的作者防呆门）
 *
 * 背景：build_docs_site.js 的 renderMarkdown 对畸形互动件是「静默容错」的——
 * 一道没有正确答案的 quiz、一张缺 `---` 的 flip、一个空提示的 popover，都会
 * 悄悄渲染成坏页面，作者得不到任何反馈。verify_docs_site.js 只校验
 * md→html 存在性/链接/资源，管不到互动件内容本身。本脚本补上这一层：
 * 扫所有「参与生成」的 .md，逐个检查 callout / quiz / flip / popover 是否
 * 写对，命中即报「文件:行 + 人话修复建议」。
 *
 * 用法：
 *   node scripts/docs/lint_docs_widgets.js            # 只有 error 才失败退出 1
 *   node scripts/docs/lint_docs_widgets.js --strict   # warning 也算失败
 *   node scripts/docs/lint_docs_widgets.js --quiet     # 少打印
 *
 * 设计原则：
 *   - 与 build_docs_site.js「同一套」跳过目录/围栏识别规则，避免扫到不生成的文件。
 *   - error = 一定坏页（渲染出永远答不对/空白/空气泡等）；warning = 能渲染但作者
 *     多半忘了东西（如 quiz 无解释、callout 无正文）。默认只有 error 失败。
 *   - 纯静态字符串检查，零 IO 副作用、可重复；不改任何源文。
 *
 * ── HOW-TO-EXTEND（抄写式）───────────────────────────────────────────────
 * 想新增一条互动件规则（比如给未来的 ```tabs 加检查；```timeline / ```scene 已内置）：
 *   1) 在下面 WIDGET_KINDS 里登记围栏名，避免被当成"拼错的围栏"误报。
 *   2) 写一个 lintXxx(lines, fenceStartLine, body) 函数，往 findings 里
 *      push {file, line, level:'error'|'warning', code, msg}（msg 用人话给修复建议）。
 *   3) 在 lintFile 的围栏分发 switch 里挂上它，并在 lint_docs_widgets.test.js
 *      补一个坏样本 + 一个好样本断言。
 * ─────────────────────────────────────────────────────────────────────────
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const QUIET = process.argv.includes("--quiet");
const STRICT = process.argv.includes("--strict");

// —— 与 build_docs_site.js 保持一致：不参与生成的目录 / 路径片段 ——
const SKIP_DIRS = new Set([
  ".git", "node_modules", "build", "dist", ".venv", "venv", "coverage",
  "__pycache__", ".pytest_cache", ".tox", "muya-embed", "national-exam-site",
  "_archive_已删除孤儿引擎", ".claude", ".khy",
]);
const SKIP_PATH_PARTS = ["/bundled/", "/_assets/"];

// 已知的互动/图表围栏名（其余非语言标记的围栏若长得像这些则疑似拼错）。
const WIDGET_KINDS = new Set(["callout", "quiz", "flip", "timeline", "scene"]);
// build_docs_site.js 支持的 callout 种类（未知种类会静默回退 tip）。
const CALLOUT_KINDS = new Set(["tip", "note", "warn", "star", "ask"]);

// —— 收集所有参与生成的 .md（镜像 walkMarkdown）——
function walkMarkdown(dir, acc) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (_) { return acc; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    const rel = path.relative(ROOT, full).split(path.sep).join("/");
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      if (SKIP_PATH_PARTS.some((p) => ("/" + rel + "/").includes(p))) continue;
      walkMarkdown(full, acc);
    } else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) {
      if (SKIP_PATH_PARTS.some((p) => ("/" + rel).includes(p))) continue;
      acc.push(full);
    }
  }
  return acc;
}

// —— 单个 callout 围栏体检 ——
// info 形如 `callout star|标题`；body 是围栏内正文。
function lintCallout(findings, file, startLine, info, body) {
  const rest = String(info).replace(/^callout\b/i, "").trim();
  const parts = rest.split("|").map((s) => s.trim());
  const kind = (parts[0] || "tip").toLowerCase();
  if (parts[0] && !CALLOUT_KINDS.has(kind)) {
    findings.push({
      file, line: startLine, level: "error", code: "callout-bad-kind",
      msg: `callout 种类 "${parts[0]}" 不认识，会被静默当成 tip。可选：${[...CALLOUT_KINDS].join(" / ")}（写法：\`\`\`callout star|你的标题）`,
    });
  }
  if (body.trim() === "") {
    findings.push({
      file, line: startLine, level: "warning", code: "callout-empty-body",
      msg: `callout 正文是空的，吉祥物会插一句"没头没尾"的话。在围栏里写点正文。`,
    });
  }
}

// —— 单个 quiz 围栏体检 ——
function lintQuiz(findings, file, startLine, body) {
  const rows = body.split("\n");
  let question = "";
  const options = [];
  let explainCount = 0;
  for (const raw of rows) {
    const line = raw.replace(/\s+$/, "");
    let m;
    if ((m = line.match(/^\s*(?:Q[:：]|问[:：])\s*(.*)$/i))) { question = m[1]; }
    else if ((m = line.match(/^\s*[-*]\s*\[([ xX])\]\s*(.*)$/))) {
      options.push({ correct: m[1].toLowerCase() === "x", text: m[2].trim() });
    } else if (/^\s*>\s?/.test(line)) { explainCount += 1; }
    else if (line.trim() && !question) { question = line.trim(); }
  }
  if (!question.trim()) {
    findings.push({
      file, line: startLine, level: "error", code: "quiz-no-question",
      msg: `quiz 没有题干。加一行 "Q: 你的问题"（或 "问：…"）。`,
    });
  }
  if (options.length === 0) {
    findings.push({
      file, line: startLine, level: "error", code: "quiz-no-options",
      msg: `quiz 一个选项都没有。每个选项写成 "- [ ] 选项文字"，正确的写 "- [x] …"。`,
    });
  } else if (options.filter((o) => o.correct).length === 0) {
    findings.push({
      file, line: startLine, level: "error", code: "quiz-no-correct",
      msg: `quiz 没有任何正确答案（没有 "- [x]"），这题永远答不对。至少把一个选项标成 [x]。`,
    });
  }
  const blankOpt = options.find((o) => o.text === "");
  if (blankOpt) {
    findings.push({
      file, line: startLine, level: "error", code: "quiz-blank-option",
      msg: `quiz 有一个选项文字是空的（"- [ ]" 后面没写字），会渲染出一个空按钮。`,
    });
  }
  if (options.length > 0 && explainCount === 0) {
    findings.push({
      file, line: startLine, level: "warning", code: "quiz-no-explain",
      msg: `quiz 没有解释（"> …" 行）。加一句解释，答完能学到为什么。`,
    });
  }
}

// —— 单个 flip 围栏体检 ——
function lintFlip(findings, file, startLine, body) {
  const rows = body.split("\n");
  const sepIdx = rows.findIndex((l) => /^\s*---\s*$/.test(l));
  if (sepIdx < 0) {
    findings.push({
      file, line: startLine, level: "error", code: "flip-no-separator",
      msg: `flip 缺少 "---" 分隔行，背面会是空白。用单独一行 "---" 把正面/背面分开。`,
    });
    return;
  }
  const front = rows.slice(0, sepIdx).join("\n").trim();
  const back = rows.slice(sepIdx + 1).join("\n").trim();
  if (front === "") {
    findings.push({
      file, line: startLine, level: "error", code: "flip-empty-front",
      msg: `flip 正面（"---" 之前）是空的。在上半部分写提问/正面内容。`,
    });
  }
  if (back === "") {
    findings.push({
      file, line: startLine, level: "error", code: "flip-empty-back",
      msg: `flip 背面（"---" 之后）是空的，翻过去看不到答案。在下半部分写答案。`,
    });
  }
}

// —— 单个 timeline 围栏体检 ——
// 每行 `标签 | 描述`（第一个 | 分割）。空 fence / 缺分隔 / 空标签 报错，空描述报警。
function lintTimeline(findings, file, startLine, body) {
  const rows = body.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  if (rows.length === 0) {
    findings.push({
      file, line: startLine, level: "error", code: "timeline-empty",
      msg: `timeline 里一条时间点都没有。每行写 "标签 | 描述"（如 "2020 | 发布 GPT-3"）。`,
    });
    return;
  }
  rows.forEach((raw, k) => {
    const bar = raw.indexOf("|");
    if (bar < 0) {
      findings.push({
        file, line: startLine + 1 + k, level: "error", code: "timeline-no-separator",
        msg: `timeline 第 ${k + 1} 行缺少 "|" 分隔（"${raw}"）。写成 "标签 | 描述"。`,
      });
      return;
    }
    const label = raw.slice(0, bar).trim();
    const desc = raw.slice(bar + 1).trim();
    if (label === "") {
      findings.push({
        file, line: startLine + 1 + k, level: "error", code: "timeline-empty-label",
        msg: `timeline 第 ${k + 1} 行 "|" 左边的标签是空的。补上年份/阶段等标签。`,
      });
    }
    if (desc === "") {
      findings.push({
        file, line: startLine + 1 + k, level: "warning", code: "timeline-empty-desc",
        msg: `timeline 第 ${k + 1} 行 "|" 右边的描述是空的。补上这个时间点发生了什么。`,
      });
    }
  });
}

// —— 单个 scene（画面场景/漫画分镜）围栏体检 ——
// 对话行 `表情 角色 | 台词`（第一个 | 分割）；旁白行 `> 画外音`；无 | 非 > 的行当纯旁白兜底。
// 空 fence / 空说话人报错，空台词 / 空旁白报警（与渲染的 fail-soft 对齐，不报兜底旁白）。
function lintScene(findings, file, startLine, body) {
  const raws = body.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  if (raws.length === 0) {
    findings.push({
      file, line: startLine, level: "error", code: "scene-empty",
      msg: `scene 里一格都没有。每行写 "表情 角色 | 台词"（如 "🤖 Khy | 交给我"），或以 "> " 开头写一句旁白。`,
    });
    return;
  }
  raws.forEach((raw, k) => {
    if (raw.startsWith(">")) {
      const cap = raw.replace(/^>\s?/, "").trim();
      if (cap === "") {
        findings.push({
          file, line: startLine + 1 + k, level: "warning", code: "scene-empty-caption",
          msg: `scene 第 ${k + 1} 行是一条空旁白（">" 后面没写字）。补上画外音，或删掉这一行。`,
        });
      }
      return;
    }
    const bar = raw.indexOf("|");
    if (bar < 0) return; // 无 | 非 > 的行渲染时当纯旁白兜底，不报错
    const who = raw.slice(0, bar).trim();
    const say = raw.slice(bar + 1).trim();
    if (who === "") {
      findings.push({
        file, line: startLine + 1 + k, level: "error", code: "scene-empty-who",
        msg: `scene 第 ${k + 1} 行 "|" 左边没有说话人。写成 "表情 角色 | 台词"（如 "👦 小明 | …"）。`,
      });
    }
    if (say === "") {
      findings.push({
        file, line: startLine + 1 + k, level: "warning", code: "scene-empty-line",
        msg: `scene 第 ${k + 1} 行 "|" 右边的台词是空的，气泡里没话。补上这一格要说的话。`,
      });
    }
  });
}

// —— 行内 popover 体检：+[文字](提示) ——
// 逐行扫，命中空文字/空提示才报（真实行号）。
function lintPopovers(findings, file, lineIdx, lineText) {
  const re = /\+\[([^\]]*)\]\(([^)]*)\)/g;
  let m;
  while ((m = re.exec(lineText)) !== null) {
    const label = m[1].trim();
    const tip = m[2].trim();
    if (label === "") {
      findings.push({
        file, line: lineIdx + 1, level: "error", code: "popover-empty-label",
        msg: `popover 显示文字是空的（"+[](…)"），页面上看不到可悬浮的词。写成 +[要显示的词](悬浮解释)。`,
      });
    }
    if (tip === "") {
      findings.push({
        file, line: lineIdx + 1, level: "error", code: "popover-empty-tip",
        msg: `popover 悬浮解释是空的（"+[词]()"），悬浮上去是个空气泡。补上括号里的解释。`,
      });
    }
  }
}

// —— 单文件体检：镜像 build_docs_site 的围栏扫描，只做静态检查 ——
function lintFile(file) {
  const findings = [];
  let src;
  try { src = fs.readFileSync(file, "utf8"); }
  catch (_) { return findings; }
  const rel = path.relative(ROOT, file).split(path.sep).join("/");
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // 围栏：``` / ~~~（镜像 build_docs_site 的正则）
    const fence = line.match(/^(\s*)(```+|~~~+)\s*([\w-]*)(.*)$/);
    if (fence) {
      const marker = fence[2][0];
      const lang = (fence[3] || "").toLowerCase();
      const info = ((fence[3] || "") + (fence[4] || "")).trim();
      const startLine = i + 1;
      const buf = [];
      i += 1;
      const closeRe = new RegExp("^\\s*" + marker + "{3,}\\s*$");
      while (i < lines.length && !closeRe.test(lines[i])) { buf.push(lines[i]); i += 1; }
      const closed = i < lines.length;
      i += 1; // 跳过结束围栏
      const body = buf.join("\n");
      if (!closed) {
        findings.push({
          file: rel, line: startLine, level: "error", code: "fence-unclosed",
          msg: `围栏 "${marker.repeat(3)}" 没有对应的结束围栏，之后的内容会全被吞进代码块。补一行 "${marker.repeat(3)}"。`,
        });
      }
      if (lang === "callout") lintCallout(findings, rel, startLine, info, body);
      else if (lang === "quiz") lintQuiz(findings, rel, startLine, body);
      else if (lang === "flip") lintFlip(findings, rel, startLine, body);
      else if (lang === "timeline") lintTimeline(findings, rel, startLine, body);
      else if (lang === "scene") lintScene(findings, rel, startLine, body);
      else if (lang && !WIDGET_KINDS.has(lang) && looksLikeTypo(lang)) {
        findings.push({
          file: rel, line: startLine, level: "warning", code: "fence-suspected-typo",
          msg: `围栏语言 "${lang}" 很像拼错的互动件（callout/quiz/flip/timeline/scene）。若确是代码块可忽略；否则改成正确的围栏名。`,
        });
      }
      continue;
    }
    // 非围栏行：扫行内 popover
    lintPopovers(findings, rel, i, line);
    i += 1;
  }
  return findings;
}

// 判断某围栏语言是否疑似把互动件名拼错。
// 保守策略：只认「与某互动件名恰好差 1 个编辑操作」且长度 ≥3 的候选，
// 避免把 c / r / go / js 等正经短语言名误报成 callout/quiz/flip 的拼写错误。
function looksLikeTypo(lang) {
  if (lang.length < 3) return false;
  for (const w of WIDGET_KINDS) {
    if (lang === w) return false;
    if (editDistance1(lang, w)) return true; // quizz / calout / flp
  }
  return false;
}
// 仅判断"是否恰好差 1 个编辑操作"，够用即可（不求精确距离）。
function editDistance1(a, b) {
  if (a === b) return false;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  if (la === lb) { // 一次替换
    let diff = 0;
    for (let k = 0; k < la; k++) if (a[k] !== b[k]) diff++;
    return diff === 1;
  }
  // 一次增删：长的能通过删 1 个字符变成短的
  const [s, l] = la < lb ? [a, b] : [b, a];
  for (let k = 0; k < l.length; k++) {
    if (s === l.slice(0, k) + l.slice(k + 1)) return true;
  }
  return false;
}

// —— 主流程 ——
function main() {
  const files = walkMarkdown(path.join(ROOT, "docs"), []);
  const all = [];
  for (const f of files) all.push(...lintFile(f));

  const errors = all.filter((x) => x.level === "error");
  const warnings = all.filter((x) => x.level === "warning");

  if (!QUIET) {
    console.log(
      `[widget-lint] 扫描 ${files.length} 个 Markdown · error ${errors.length} · warning ${warnings.length}`
    );
  }
  const print = (arr, mark) => {
    for (const x of arr) console.log(`  ${mark} ${x.file}:${x.line} [${x.code}] ${x.msg}`);
  };
  if (warnings.length && !QUIET) print(warnings.slice(0, 40), "⚠");
  if (errors.length) {
    console.error(`\n[widget-lint] ❌ ${errors.length} 个必须修的问题：`);
    print(errors.slice(0, 60), "✗");
  }

  const fail = errors.length > 0 || (STRICT && warnings.length > 0);
  if (fail) {
    console.error(
      `\n[widget-lint] 失败${STRICT ? "（--strict：warning 也算）" : ""}。修好上面标 ✗ 的互动件再跑。`
    );
    process.exit(1);
  }
  if (!QUIET) console.log("[widget-lint] ✅ 所有互动件（callout/quiz/flip/popover）写法正确。");
}

if (require.main === module) main();

module.exports = {
  lintFile, lintCallout, lintQuiz, lintFlip, lintTimeline, lintScene, lintPopovers,
  walkMarkdown, looksLikeTypo, CALLOUT_KINDS, WIDGET_KINDS,
};
