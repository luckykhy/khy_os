#!/usr/bin/env node
'use strict';
/**
 * 输入模糊测试仪器(诊断工具,非发布门禁)。
 *
 * 把对抗语料(extensions/scripts/khy-diagnostics/fuzzInputCorpus.js)喂给 khyos 真实的输入解析器,
 * 每个 (parser, case) 组合独立执行,捕获:
 *   - throw        解析器抛异常(潜在崩溃)
 *   - hang         单次调用超过预算(潜在挂死/灾难回溯)
 *   - bad-output   返回 NaN / undefined 泄漏 / 非预期类型(潜在垃圾输出)
 *   - ok           正常返回
 *
 * 目的是「尽可能发现问题,不当鸵鸟」:任何 throw/hang/bad-output 都被逐条列出并定位到
 * (解析器, 用例 id, 输入摘要, 错误)。它不修任何东西——只报告。修复在单独步骤。
 *
 * 用法:
 *   node extensions/scripts/khy-diagnostics/fuzz-input.js            # 人类可读汇总
 *   node extensions/scripts/khy-diagnostics/fuzz-input.js --json      # 机器可消费
 *   node extensions/scripts/khy-diagnostics/fuzz-input.js --all        # 打印每条(含 ok)
 *
 * 退出码:0 = 无 throw/hang(bad-output 视为 warning);1 = 存在 throw 或 hang。
 */

const path = require('path');
const { buildCorpus } = require('./fuzzInputCorpus');

const BACKEND = path.resolve(__dirname, '..', '..', '..', 'services', 'backend');
function cli(mod) {
  return require(path.join(BACKEND, 'src', 'cli', mod));
}

// 单次调用软预算(ms)。超过即判 hang(灾难回溯/O(n^2) 放大)。
const CALL_BUDGET_MS = 2000;

/**
 * 待测目标。每个 target 提供一个 invoke(input) —— 用真实解析器处理裸输入字符串。
 * invoke 应尽量贴近解析器实际被喂裸用户输入的调用形态。
 */
function buildTargets() {
  const targets = [];
  const add = (name, mod, invoke) => targets.push({ name, mod, invoke });

  // 前门解析器:裸输入 -> 命令对象。只测纯解析面(parseInput / getCompletions)。
  // 刻意不测 router.route():它是「已解析对象 -> 真正执行命令」的派发器(会 spawn 进程、
  // 做 IO),对它喂裸字符串既是 API 误用,也会真的去执行命令——不属于输入解析模糊范围。
  try {
    const router = cli('router');
    add('router.parseInput', 'router', (s) => router.parseInput(s));
    add('router.getCompletions', 'router', (s) => router.getCompletions(s));
  } catch (e) { add('router.LOAD', 'router', () => { throw e; }); }

  // CJK / 全角规范化
  try {
    const cjk = cli('cjkInputNormalize');
    add('cjk.normalizeNumericInput', 'cjkInputNormalize', (s) => cjk.normalizeNumericInput(s));
    add('cjk.normalizeFullWidthDigits', 'cjkInputNormalize', (s) => cjk.normalizeFullWidthDigits(s));
    add('cjk.normalizeFullWidthSpace', 'cjkInputNormalize', (s) => cjk.normalizeFullWidthSpace(s));
  } catch (e) { add('cjk.LOAD', 'cjkInputNormalize', () => { throw e; }); }

  try {
    const fw = cli('fullWidthInput');
    add('fullWidth.foldDigits', 'fullWidthInput', (s) => fw.foldDigits(s));
    add('fullWidth.foldSpace', 'fullWidthInput', (s) => fw.foldSpace(s));
  } catch (e) { add('fullWidth.LOAD', 'fullWidthInput', () => { throw e; }); }

  // @提及解析
  try {
    const at = cli('atMentionInject');
    add('atMention.resolveAtMentions', 'atMentionInject', (s) => at.resolveAtMentions(s, { cwd: process.cwd() }));
  } catch (e) { add('atMention.LOAD', 'atMentionInject', () => { throw e; }); }

  // session tag 解析
  try {
    const st = cli('sessionTag');
    add('sessionTag.normalizeTag', 'sessionTag', (s) => st.normalizeTag(s));
    add('sessionTag.parseTagArgs', 'sessionTag', (s) => st.parseTagArgs(s));
  } catch (e) { add('sessionTag.LOAD', 'sessionTag', () => { throw e; }); }

  // break cache scope 解析
  try {
    const bc = cli('breakCache');
    add('breakCache.parseScope', 'breakCache', (s) => bc.parseScope(s));
  } catch (e) { add('breakCache.LOAD', 'breakCache', () => { throw e; }); }

  // print 输出格式 flag 解析
  try {
    const pf = cli('printOutputFormat');
    add('printFormat.parsePrintFlags', 'printOutputFormat', (s) => pf.parsePrintFlags(String(s).split(/\s+/)));
  } catch (e) { add('printFormat.LOAD', 'printOutputFormat', () => { throw e; }); }

  // word diff 分词(渲染前的裸文本处理)
  try {
    const wd = cli('wordDiff');
    add('wordDiff.tokenizeLine', 'wordDiff', (s) => wd.tokenizeLine(s));
    add('wordDiff.computeWordDiff', 'wordDiff', (s) => wd.computeWordDiff(s, s + 'x'));
  } catch (e) { add('wordDiff.LOAD', 'wordDiff', () => { throw e; }); }

  // 工具结果摘要(常喂入不可控字符串)
  try {
    const trs = cli('toolResultSummary');
    add('toolResult.summarize', 'toolResultSummary', (s) => trs.summarizeToolResult('Bash', s));
  } catch (e) { add('toolResult.LOAD', 'toolResultSummary', () => { throw e; }); }

  // mermaid 渲染(吃裸代码块内容)
  try {
    const mm = cli('mermaid');
    add('mermaid.renderMermaidBlock', 'mermaid', (s) => mm.renderMermaidBlock(s));
  } catch (e) { add('mermaid.LOAD', 'mermaid', () => { throw e; }); }

  // markdown 渲染(吃裸模型/用户文本)
  try {
    const md = cli('markdownRenderer');
    add('markdown.renderMarkdownLite', 'markdownRenderer', (s) => md.renderMarkdownLite(s));
  } catch (e) { add('markdown.LOAD', 'markdownRenderer', () => { throw e; }); }

  // markdown 表格单元格换行(宽字符/超长 token 易触发放大)
  try {
    const mtw = cli('markdownTableWrap');
    add('tableWrap.wrapCellLines', 'markdownTableWrap', (s) => mtw.wrapCellLines(s, 20));
  } catch (e) { add('tableWrap.LOAD', 'markdownTableWrap', () => { throw e; }); }

  // 行截断(吃任意长文本)
  try {
    const tl = cli('ccTruncateLines');
    add('truncate.truncateToLines', 'ccTruncateLines', (s) => tl.truncateToLines(s, 10));
    add('truncate.truncatePreview', 'ccTruncateLines', (s) => tl.truncatePreview(s));
    const cl = cli('ccCountLines');
    add('countLines.ccCountLines', 'ccCountLines', (s) => cl.ccCountLines(s));
  } catch (e) { add('truncate.LOAD', 'ccTruncateLines', () => { throw e; }); }

  // 结构化 diff 统计/渲染(吃裸 unified diff 文本)
  try {
    const dr = cli('diffRenderer');
    add('diff.computeStructuredDiffStats', 'diffRenderer', (s) => dr.computeStructuredDiffStats('a\nb\nc\n', s));
    add('diff.computeStructuredDiffHunks', 'diffRenderer', (s) => dr.computeStructuredDiffHunks('a\nb\nc\n', s));
  } catch (e) { add('diff.LOAD', 'diffRenderer', () => { throw e; }); }

  // 工具结果失败分类(吃裸工具输出)
  try {
    const tv = cli('toolResultVoice');
    add('toolVoice.toolResultLooksFailed', 'toolResultVoice', (s) => tv.toolResultLooksFailed(s));
    add('toolVoice.classifyToolFailureDetail', 'toolResultVoice', (s) => tv.classifyToolFailureDetail(s));
  } catch (e) { add('toolVoice.LOAD', 'toolResultVoice', () => { throw e; }); }

  // 关键发现解析(吃裸模型输出)
  try {
    const kf = cli('keyFindings');
    add('keyFindings.detectTestOutcome', 'keyFindings', (s) => kf.detectTestOutcome(s));
    add('keyFindings.stripFindings', 'keyFindings', (s) => kf.stripFindings(s));
  } catch (e) { add('keyFindings.LOAD', 'keyFindings', () => { throw e; }); }

  // 词级 diff 渲染(真实 DoS 面:两侧都富 token 时 O(m·n) 放大)。
  // 用一条 2000-token 基线对撞语料,long-word-tokens(20000 token)→ 4000 万格
  // 应命中 MAX_LCS_CELLS 守卫走整行回退而非 OOM/hang。
  try {
    const wd = cli('wordDiff');
    const baseline = Array.from({ length: 2000 }, (_, i) => 'w' + i).join(' ');
    const theme = {
      diffRemoved: '#400000', diffRemovedWord: '#800000',
      diffAdded: '#004000', diffAddedWord: '#008000',
    };
    add('wordDiff.renderWordDiffLine', 'wordDiff', (s) =>
      wd.renderWordDiffLine(baseline, s, theme));
    add('wordDiff.computeWordDiff', 'wordDiff', (s) =>
      wd.computeWordDiff(baseline.split(/(\s+)/), String(s).split(/(\s+)/)));
  } catch (e) { add('wordDiff.LOAD', 'wordDiff', () => { throw e; }); }

  // 流式 markdown 状态机(逐块喂入)。真实调用形态:new MarkdownStreamState(renderFn)
  // 再 feed(delta);renderFn 收到每个提交的块。用 no-op renderFn 驱动真实解析路径。
  try {
    const sm = cli('streamingMarkdown');
    add('streamingMarkdown.feed', 'streamingMarkdown', (s) => {
      const st = new sm.MarkdownStreamState(() => {});
      const out = st.feed(s);
      if (typeof st.flush === 'function') st.flush();
      return out;
    });
  } catch (e) { add('streamingMarkdown.LOAD', 'streamingMarkdown', () => { throw e; }); }

  return targets;
}

function summarizeInput(s) {
  const str = String(s);
  const head = str.slice(0, 40).replace(/[\x00-\x1f\x7f]/g, (c) => '\\x' + c.charCodeAt(0).toString(16).padStart(2, '0'));
  return `len=${str.length} "${head}${str.length > 40 ? '…' : ''}"`;
}

/** 判定返回值是否「垃圾输出」(泄漏 NaN / undefined 字面 / [object Object] 等)。 */
function detectBadOutput(value) {
  const probe = (v) => {
    if (typeof v === 'number' && Number.isNaN(v)) return 'NaN';
    if (typeof v === 'string') {
      if (v.includes('undefined') && /\bundefined\b/.test(v)) return 'contains "undefined"';
      if (v.includes('[object Object]')) return '[object Object]';
      if (v.includes('NaN')) return 'contains "NaN"';
    }
    return null;
  };
  if (value == null) return null; // null/undefined 返回本身是合法的(很多解析器如此)
  if (Array.isArray(value)) {
    for (const item of value) { const r = probe(item); if (r) return r; }
    return null;
  }
  if (typeof value === 'object') {
    // 浅扫字符串字段
    for (const k of Object.keys(value)) { const r = probe(value[k]); if (r) return `field ${k}: ${r}`; }
    return null;
  }
  return probe(value);
}

function runOne(target, testCase) {
  const start = Number(process.hrtime.bigint() / 1000000n);
  try {
    const out = target.invoke(testCase.input);
    const ms = Number(process.hrtime.bigint() / 1000000n) - start;
    if (ms > CALL_BUDGET_MS) {
      return { status: 'hang', ms, detail: `exceeded ${CALL_BUDGET_MS}ms budget` };
    }
    const bad = detectBadOutput(out);
    if (bad) return { status: 'bad-output', ms, detail: bad };
    return { status: 'ok', ms, detail: '' };
  } catch (err) {
    const ms = Number(process.hrtime.bigint() / 1000000n) - start;
    return { status: 'throw', ms, detail: (err && err.message) ? err.message : String(err) };
  }
}

function main() {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const showAll = args.includes('--all');

  const corpus = buildCorpus();
  const targets = buildTargets();
  const findings = [];
  let total = 0;
  const counts = { ok: 0, throw: 0, hang: 0, 'bad-output': 0 };

  for (const target of targets) {
    for (const tc of corpus) {
      total += 1;
      const r = runOne(target, tc);
      counts[r.status] = (counts[r.status] || 0) + 1;
      if (r.status !== 'ok') {
        findings.push({
          target: target.name,
          module: target.mod,
          caseId: tc.id,
          category: tc.category,
          note: tc.note,
          status: r.status,
          ms: r.ms,
          detail: r.detail,
          inputSummary: summarizeInput(tc.input),
        });
      }
    }
  }

  const hard = findings.filter((f) => f.status === 'throw' || f.status === 'hang');

  if (json) {
    process.stdout.write(JSON.stringify({
      schema: 'khy.fuzz-input/v1',
      total, counts,
      targets: targets.map((t) => t.name),
      cases: corpus.length,
      hardFailures: hard.length,
      findings,
    }, null, 2) + '\n');
  } else {
    process.stdout.write(`输入模糊测试 —— ${targets.length} 个解析器 × ${corpus.length} 用例 = ${total} 次调用\n`);
    process.stdout.write('='.repeat(64) + '\n');
    process.stdout.write(`ok=${counts.ok}  throw=${counts.throw}  hang=${counts.hang}  bad-output=${counts['bad-output']}\n\n`);
    const show = showAll ? findings : findings;
    if (show.length === 0) {
      process.stdout.write('未发现 throw / hang / bad-output。\n');
    } else {
      for (const f of show) {
        process.stdout.write(`[${f.status.toUpperCase()}] ${f.target}  ←  ${f.caseId} (${f.category}: ${f.note})\n`);
        process.stdout.write(`        输入: ${f.inputSummary}\n`);
        process.stdout.write(`        原因: ${f.detail}  (${f.ms}ms)\n`);
      }
    }
    process.stdout.write('\n' + '='.repeat(64) + '\n');
    process.stdout.write(hard.length
      ? `硬失败(throw/hang): ${hard.length} —— 需修复\n`
      : `无硬失败(throw/hang)。bad-output ${counts['bad-output']} 项(warning)。\n`);
  }

  process.exit(hard.length > 0 ? 1 : 0);
}

main();
