"use strict";
/**
 * lint_docs_widgets.js 的行为契约测试（node:test）。
 *
 * 跑法：node --test scripts/docs/lint_docs_widgets.test.js
 * （勿用 jest 前缀——本仓约定 node:test 文件用 node --test 直跑。）
 *
 * 每类互动件都有：① 一个"坏样本"断言能被抓到对应 code；
 * ② 一个"好样本"断言零命中。改互动件语法或体检规则时，
 * 同步更新这里的断言（见 lint_docs_widgets.js 顶部 HOW-TO-EXTEND）。
 */
const { test } = require("node:test");
const assert = require("node:assert");
const os = require("os");
const fs = require("fs");
const path = require("path");
const {
  lintFile, looksLikeTypo, CALLOUT_KINDS,
} = require("./lint_docs_widgets.js");

// 把一段 markdown 写进临时文件，跑 lintFile，返回 findings。
function lintSource(src) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "widget-lint-"));
  const file = path.join(dir, "sample.md");
  fs.writeFileSync(file, src, "utf8");
  try { return lintFile(file); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const codes = (findings) => findings.map((f) => f.code);

// ── callout ──────────────────────────────────────────────────────────────
test("callout: 未知 kind 报 callout-bad-kind", () => {
  const f = lintSource("```callout wat|标题\n正文\n```\n");
  assert.ok(codes(f).includes("callout-bad-kind"));
});
test("callout: 空正文报 callout-empty-body（warning）", () => {
  const f = lintSource("```callout tip|标题\n\n```\n");
  assert.ok(codes(f).includes("callout-empty-body"));
});
test("callout: 合法 callout 零命中", () => {
  for (const k of CALLOUT_KINDS) {
    const f = lintSource("```callout " + k + "|标题\n有正文\n```\n");
    assert.deepStrictEqual(codes(f), [], "kind=" + k + " 应干净");
  }
});

// ── quiz ─────────────────────────────────────────────────────────────────
test("quiz: 没有正确答案报 quiz-no-correct", () => {
  const f = lintSource("```quiz\nQ: 题?\n- [ ] A\n- [ ] B\n> 解释\n```\n");
  assert.ok(codes(f).includes("quiz-no-correct"));
});
test("quiz: 没有题干报 quiz-no-question", () => {
  const f = lintSource("```quiz\n- [x] A\n- [ ] B\n> 解释\n```\n");
  assert.ok(codes(f).includes("quiz-no-question"));
});
test("quiz: 零选项报 quiz-no-options", () => {
  const f = lintSource("```quiz\nQ: 只有题干没有选项\n```\n");
  assert.ok(codes(f).includes("quiz-no-options"));
});
test("quiz: 空选项文字报 quiz-blank-option", () => {
  const f = lintSource("```quiz\nQ: 题?\n- [x] \n- [ ] B\n> 解释\n```\n");
  assert.ok(codes(f).includes("quiz-blank-option"));
});
test("quiz: 无解释报 quiz-no-explain（warning）", () => {
  const f = lintSource("```quiz\nQ: 题?\n- [x] A\n- [ ] B\n```\n");
  assert.ok(codes(f).includes("quiz-no-explain"));
});
test("quiz: 合法单选零命中", () => {
  const f = lintSource("```quiz\nQ: 题?\n- [x] A\n- [ ] B\n> 因为 A\n```\n");
  assert.deepStrictEqual(codes(f), []);
});
test("quiz: 合法多选（用 问：全角冒号）零命中", () => {
  const f = lintSource("```quiz\n问：多选题?\n- [x] A\n- [x] B\n- [ ] C\n> 都对\n```\n");
  assert.deepStrictEqual(codes(f), []);
});

// ── flip ─────────────────────────────────────────────────────────────────
test("flip: 缺分隔符报 flip-no-separator", () => {
  const f = lintSource("```flip\n只有正面没有背面\n```\n");
  assert.ok(codes(f).includes("flip-no-separator"));
});
test("flip: 空背面报 flip-empty-back", () => {
  const f = lintSource("```flip\n正面\n---\n```\n");
  assert.ok(codes(f).includes("flip-empty-back"));
});
test("flip: 空正面报 flip-empty-front", () => {
  const f = lintSource("```flip\n---\n背面\n```\n");
  assert.ok(codes(f).includes("flip-empty-front"));
});
test("flip: 合法翻卡零命中", () => {
  const f = lintSource("```flip\n正面提问\n---\n背面答案\n```\n");
  assert.deepStrictEqual(codes(f), []);
});

// ── popover（行内）───────────────────────────────────────────────────────
test("popover: 空提示报 popover-empty-tip", () => {
  const f = lintSource("这是 +[术语]() 的说明。\n");
  assert.ok(codes(f).includes("popover-empty-tip"));
});
test("popover: 空显示文字报 popover-empty-label", () => {
  const f = lintSource("这是 +[](解释) 的说明。\n");
  assert.ok(codes(f).includes("popover-empty-label"));
});
test("popover: 合法悬浮弹窗零命中", () => {
  const f = lintSource("这是 +[术语](白话解释) 的说明。\n");
  assert.deepStrictEqual(codes(f), []);
});
test("popover: 报的是真实行号", () => {
  const f = lintSource("第一行\n第二行\n第三行 +[词]() 结尾\n");
  const hit = f.find((x) => x.code === "popover-empty-tip");
  assert.strictEqual(hit.line, 3);
});

// ── 未闭合围栏 ─────────────────────────────────────────────────────────────
test("fence: 未闭合围栏报 fence-unclosed", () => {
  const f = lintSource("```\n没有结束围栏的代码\n后面全被吞\n");
  assert.ok(codes(f).includes("fence-unclosed"));
});

// ── 拼错围栏名启发式 ───────────────────────────────────────────────────────
test("typo: quizz / calout / flp 疑似拼错互动件", () => {
  assert.strictEqual(looksLikeTypo("quizz"), true);
  assert.strictEqual(looksLikeTypo("calout"), true);
});
test("typo: 正经短语言名 c/go/js 不误报", () => {
  for (const lang of ["c", "go", "js", "sh", "py", "ts"]) {
    assert.strictEqual(looksLikeTypo(lang), false, lang + " 不应误报");
  }
});
test("typo: 无关长语言名 jsonc/python 不误报", () => {
  assert.strictEqual(looksLikeTypo("jsonc"), false);
  assert.strictEqual(looksLikeTypo("python"), false);
});

// ── 干净综合样本 ───────────────────────────────────────────────────────────
test("综合: 一篇全对的文档零命中", () => {
  const src = [
    "# 标题",
    "",
    "```callout ask|小白发问",
    "这里有 +[术语](白话) 解释。",
    "```",
    "",
    "```quiz",
    "Q: 这题?",
    "- [x] 对的",
    "- [ ] 错的",
    "> 因为对的对。",
    "```",
    "",
    "```flip",
    "正面",
    "---",
    "背面",
    "```",
    "",
    "```js",
    "const x = 1;",
    "```",
    "",
  ].join("\n");
  assert.deepStrictEqual(codes(lintSource(src)), []);
});
