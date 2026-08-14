#!/usr/bin/env node
/**
 * Khy-OS 文档站校验器（B2 验证门）
 * ------------------------------------------------------------------
 * 断言三件事，任一不满足即以非零退出（红灯）：
 *   1) 每个参与生成的 .md 都有一份同名 .html（旁边）。
 *   2) 每个生成的 .html 里指向本地文件的链接（href/src）都能落到真实存在的文件。
 *   3) 离线资源齐全：docs/_assets 下 mermaid.min.js / docs-site.css / docs-site.js /
 *      hljs 主题 css / nav-data.js 都在。
 *
 * 用法：node scripts/docs/verify_docs_site.js
 * 依赖：先跑过 node scripts/docs/build_docs_site.js。
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const SKIP_DIRS = new Set([
  ".git", "node_modules", "build", "dist", ".venv", "venv", "coverage",
  "__pycache__", ".pytest_cache", ".tox", "muya-embed", "national-exam-site",
  "_archive_已删除孤儿引擎", ".claude", ".khy",
]);
const SKIP_PATH_PARTS = ["/bundled/", "/_assets/"];

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

const errors = [];
const warnings = [];

// ---- 1) 每个 md 有对应 html ----
const mds = walkMarkdown(ROOT, []).sort();
const htmlRels = [];
for (const rel of mds) {
  const htmlRel = rel.replace(/\.md$/i, ".html");
  if (!fs.existsSync(path.join(ROOT, htmlRel))) {
    errors.push(`缺少 HTML：${htmlRel}（源：${rel}）`);
  } else {
    htmlRels.push(htmlRel);
  }
}

// ---- 2) 每个 html 的本地链接都能解析 ----
// 注意：docs/index.html 是站点首页，没有对应的 .md 兄弟文件，若不显式纳入
// 就会漏检其资源/卡片链接。这里把它并入待检 html 列表。
const INDEX_HTML = "docs/index.html";
if (fs.existsSync(path.join(ROOT, INDEX_HTML)) && !htmlRels.includes(INDEX_HTML)) {
  htmlRels.push(INDEX_HTML);
}
const LINK_RE = /(?:href|src)\s*=\s*"([^"]+)"/g;
let checkedLinks = 0;
for (const htmlRel of htmlRels) {
  const abs = path.join(ROOT, htmlRel);
  const html = fs.readFileSync(abs, "utf8");
  const dir = path.dirname(abs);
  let m;
  while ((m = LINK_RE.exec(html)) !== null) {
    let href = m[1];
    if (/^(https?:|mailto:|data:|#|\/\/|javascript:)/i.test(href)) continue;
    // 去掉锚点和查询
    href = href.split("#")[0].split("?")[0];
    if (!href) continue;
    checkedLinks += 1;
    // 解码 %20 等，落到真实文件路径
    let target;
    try { target = path.resolve(dir, decodeURIComponent(href)); } catch (_) { target = path.resolve(dir, href); }
    if (!fs.existsSync(target)) {
      errors.push(`断链：${htmlRel}\n        -> ${m[1]}\n        (解析为 ${path.relative(ROOT, target)})`);
    }
  }
}

// ---- 3) 资源齐全 ----
const REQUIRED_ASSETS = [
  "docs/_assets/mermaid.min.js",
  "docs/_assets/docs-site.css",
  "docs/_assets/docs-site.js",
  "docs/_assets/hljs-github-dark.min.css",
  "docs/_assets/nav-data.js",
  "docs/index.html",
];
for (const a of REQUIRED_ASSETS) {
  if (!fs.existsSync(path.join(ROOT, a))) errors.push(`缺少资源：${a}`);
}

// ---- 报告 ----
console.log(`[verify] 源 Markdown：${mds.length} · 生成 HTML：${htmlRels.length} · 校验本地链接：${checkedLinks}`);
if (warnings.length) {
  console.log(`[verify] 警告 ${warnings.length}：`);
  warnings.slice(0, 20).forEach((w) => console.log("  - " + w));
}
if (errors.length) {
  console.error(`\n[verify] ❌ 失败：${errors.length} 个问题`);
  errors.slice(0, 40).forEach((e) => console.error("  ✗ " + e));
  if (errors.length > 40) console.error(`  …还有 ${errors.length - 40} 个`);
  process.exit(1);
}
console.log("[verify] ✅ 全部通过：每个 md 都有 html，所有本地链接可达，资源齐全。");
