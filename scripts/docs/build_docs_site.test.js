"use strict";
/**
 * 文档站生成器 —— 交互组件与稳定性回归测试（node:test）。
 * 跑法：node --test scripts/docs/build_docs_site.test.js
 *
 * 断言两类事：
 *   1) 四个面向小白的交互组件（吉祥物插话 / 练习互动 / 翻卡 / 悬浮弹窗）
 *      渲染出预期的结构化 HTML（供 docs-site.js 挂行为、docs-site.css 上样式）。
 *   2) 既有 Markdown 渲染不被破坏（普通代码围栏 / mermaid / 链接改写 / 段落）。
 */
const { test } = require("node:test");
const assert = require("node:assert");
const { renderMarkdown } = require("./build_docs_site.js");

const R = (s) => renderMarkdown(s).html;

test("callout: 吉祥物插话渲染出 mascot + 标题 + 正文", () => {
  const html = R("```callout tip|试试看\n这是**重点**。\n```");
  assert.match(html, /class="callout callout-tip/);
  assert.match(html, /class="callout-mascot"/);
  assert.match(html, /试试看/);
  assert.match(html, /<strong>重点<\/strong>/); // 正文走 markdown
});

test("callout: 未知种类回退到 tip，且默认标题存在", () => {
  const html = R("```callout\n仅正文\n```");
  assert.match(html, /class="callout callout-tip/);
  assert.match(html, /callout-title/);
});

test("quiz: 单选渲染出选项与正确标记，含解释", () => {
  const html = R([
    "```quiz",
    "Q: Agent 的大脑是什么？",
    "- [x] 大语言模型",
    "- [ ] 数据库",
    "> LLM 负责推理决策。",
    "```",
  ].join("\n"));
  assert.match(html, /class="quiz reveal" data-multi="0"/);
  assert.match(html, /data-correct="1"[^>]*>[\s\S]*大语言模型/);
  assert.match(html, /data-correct="0"[^>]*>[\s\S]*数据库/);
  assert.match(html, /quiz-explain/);
  assert.match(html, /LLM 负责推理决策/);
});

test("quiz: 多选被识别为 data-multi=1", () => {
  const html = R([
    "```quiz",
    "Q: 哪些是刹车？",
    "- [x] 成功条件",
    "- [x] 步数上限",
    "- [ ] 无限循环",
    "```",
  ].join("\n"));
  assert.match(html, /data-multi="1"/);
});

test("flip: 翻卡用 --- 分正反两面", () => {
  const html = R("```flip\n正面问题\n---\n背面答案\n```");
  assert.match(html, /class="flip reveal"/);
  assert.match(html, /flip-front[^>]*>正面问题/);
  assert.match(html, /flip-back[^>]*>背面答案/);
});

test("timeline: 每行 标签|描述 渲染成有序时间轴 item", () => {
  const html = R([
    "```timeline",
    "2018 | Transformer 论文奠基",
    "2022 | ChatGPT 出圈",
    "2024 | Agent 元年",
    "```",
  ].join("\n"));
  assert.match(html, /<ol class="timeline">/);
  // 三个 item，各带 .reveal（复用 initReveal 滚动进入）
  assert.strictEqual((html.match(/class="timeline-item reveal"/g) || []).length, 3);
  assert.match(html, /class="timeline-label">2018<\/div>/);
  assert.match(html, /class="timeline-desc">Transformer 论文奠基<\/div>/);
  assert.match(html, /timeline-dot"[^>]*aria-hidden/);
});

test("timeline: 以第一个 | 分割，描述里的 | 完整保留", () => {
  const html = R("```timeline\n阶段A | 先 A | 再 B\n```");
  assert.match(html, /class="timeline-label">阶段A<\/div>/);
  assert.match(html, /class="timeline-desc">先 A \| 再 B<\/div>/);
});

test("timeline: 空围栏不抛异常，产出空 <ol>", () => {
  const html = R("```timeline\n```");
  assert.match(html, /<ol class="timeline"><\/ol>/);
});

test("timeline: 行内 popover 在标签/描述里正常渲染", () => {
  const html = R("```timeline\n2020 | 发布 +[GPT-3](1750亿参数)\n```");
  assert.match(html, /class="popover"/);
  assert.match(html, /class="popover-tip"[^>]*>1750亿参数/);
});

test("scene: 对话行渲染成左右交替的气泡（含头像、说话人、台词）", () => {
  const html = R([
    "```scene 一个 Agent 的一天",
    "👦 小明 | 帮我修好这个 bug",
    "🤖 Khy | 好，我先读日志",
    "```",
  ].join("\n"));
  assert.match(html, /<div class="scene">/);
  assert.match(html, /class="scene-title">一个 Agent 的一天<\/div>/);
  // 第一格左、第二格右（运行计数交替）
  assert.match(html, /class="scene-panel scene-left reveal"/);
  assert.match(html, /class="scene-panel scene-right reveal"/);
  assert.match(html, /class="scene-avatar" aria-hidden="true">👦<\/span>/);
  assert.match(html, /class="scene-who">小明<\/b>帮我修好这个 bug/);
});

test("scene: > 开头的行渲染成旁白条，不带气泡", () => {
  const html = R("```scene\n> 旁白：这就是 Agent 接到目标的第一步\n```");
  assert.match(html, /class="scene-caption reveal">旁白：这就是 Agent 接到目标的第一步<\/div>/);
  assert.doesNotMatch(html, /scene-bubble/);
});

test("scene: 以第一个 | 分割，台词里的 | 完整保留", () => {
  const html = R("```scene\n🤖 Khy | 先 A | 再 B\n```");
  assert.match(html, /class="scene-who">Khy<\/b>先 A \| 再 B/);
});

test("scene: 空围栏不抛异常，产出空 <div class=scene>", () => {
  const html = R("```scene\n```");
  assert.match(html, /<div class="scene"><\/div>/);
});

test("scene: 台词里的行内 popover 正常渲染", () => {
  const html = R("```scene\n👦 小明 | 什么是 +[MCP](模型上下文协议)？\n```");
  assert.match(html, /class="popover"/);
  assert.match(html, /class="popover-tip"[^>]*>模型上下文协议/);
});

test("popover: 行内 +[文字](提示) 变悬浮气泡，不被当成链接", () => {
  const html = R("看看 +[MCP](模型上下文协议，AI 的 USB) 是什么。");
  assert.match(html, /class="popover"/);
  assert.match(html, /class="popover-tip"[^>]*>模型上下文协议/);
  assert.doesNotMatch(html, /<a [^>]*模型上下文协议/); // 不能变成 <a>
});

// ---- 稳定性：既有能力不被交互组件改动破坏 ----
test("回归：普通代码围栏仍是 <pre><code>", () => {
  const html = R("```js\nconst a = 1;\n```");
  assert.match(html, /<pre><code class="language-js">/);
  assert.doesNotMatch(html, /class="callout|class="quiz|class="flip/);
});

test("回归：mermaid 仍渲染为 <pre class=mermaid>", () => {
  const html = R("```mermaid\nflowchart LR\n A-->B\n```");
  assert.match(html, /<pre class="mermaid">/);
});

test("回归：.md 链接改写成 .html，普通段落照常", () => {
  const html = R("见 [概念](./00_INDEX.md) 一节。");
  assert.match(html, /href="\.\/00_INDEX\.html"/);
  assert.match(html, /^<p>/);
});
