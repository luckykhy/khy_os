#!/usr/bin/env node
'use strict';
/**
 * fuzz-input-round1.js — adversarial sweep of input-facing surfaces NOT covered by
 * the original fuzz-input.js (30 free-text parsers) / fuzz-file-io.js / fuzz-video-io.js.
 *
 * Focus: surfaces a recon pass flagged as parsing raw human input with unbounded
 * loops / nested-quantifier regexes / no top-level guard — the ReDoS + throw/hang
 * risk class. Each target is driven with a shared adversarial string corpus
 * (ultra-long, all-dots, all-pipes, unclosed fences, control chars, CJK, mojibake,
 * whitespace-only) and every call is wrapped in a wall-clock budget so a
 * catastrophic-backtracking hang is caught as a HANG finding rather than freezing
 * the run.
 *
 * The one real defect this instrument found — ai._extractFileReferences O(n²)
 * ReDoS — is fixed under KHY_FILEREF_REDOS_GUARD and locked by
 * tests/fileRefRedosGuard.test.js. This sweep guards against regressions and new
 * surfaces. Deterministic (zero Math.random). Exit 0 = no throw/hang.
 */

const path = require('path');

const BACKEND = path.resolve(__dirname, '..', '..', 'services', 'backend', 'src');
function cli(mod) { return require(path.join(BACKEND, 'cli', mod)); }

const CALL_BUDGET_MS = 3000; // any single call exceeding this is a HANG (ReDoS)

// ── adversarial string corpus (deterministic) ──
function buildStringCorpus() {
  const c = [];
  const S = (id, note, value) => c.push({ id, note, value });
  S('empty', '空串', '');
  S('ws-only', '仅空白', '   \t  \n\r  ');
  S('null', 'null 非字符串', null);
  S('undefined', 'undefined', undefined);
  S('number', '数字', 42);
  S('object', '对象', { toString() { return 'x'; } });
  S('long-a-100k', '100K 个 a', 'a'.repeat(100000));
  S('long-line-500k', '50 万单行', 'x'.repeat(500000));
  S('dots-100k', '100K 点(ReDoS 向量)', 'a.'.repeat(50000));
  S('pure-dots', '纯点', '.'.repeat(100000) + 'X');
  S('slashdots', '斜杠点', './'.repeat(50000));
  S('pipes-40k', '管道分隔(表格 ReDoS 向量)', '|' + '-|'.repeat(20000) + 'X');
  S('sep-ambiguous', '歧义分隔符', '|' + ' :-: '.repeat(10000) + 'X');
  S('eq-run', '等号串', '='.repeat(100000));
  S('unclosed-fence', '未闭合围栏', '```js\n' + 'x'.repeat(100000));
  S('backticks', '反引号串', '`'.repeat(100000));
  S('asterisks', '星号串', '*'.repeat(50000));
  S('control-chars', '控制字符', Array.from({ length: 50000 }, (_, i) => String.fromCharCode(i % 32)).join(''));
  S('nul-run', 'NUL 串', '\x00'.repeat(50000));
  S('cjk-200k', '20 万 CJK', '中'.repeat(200000));
  S('mojibake', '乱码字节序列', Buffer.from([0xff, 0xfe, 0xc3, 0x28, 0xa0, 0xa1, 0xe2, 0x82]).toString('latin1').repeat(10000));
  S('mixed-tease', '混合诱导', ('a/b.c-'.repeat(10000)) + '.js');
  S('finding-open', '未闭合 finding 标签', '<finding type="root_cause">' + 'x'.repeat(100000));
  S('json-open', '未闭合 JSON', '{ "name": ' + 'x'.repeat(100000));
  S('func-tag-open', '未闭合 function 标签', '<function' + 'x'.repeat(100000));
  S('bracket-paste', '括号粘贴转义', '\x1b[200~' + 'p'.repeat(20000) + '\x1b[201~');
  S('numbered-list', '编号列表诱导', '1) ' + 'a '.repeat(20000));
  S('huge-token-cmd', '巨型命令 token', '/' + 'a'.repeat(500000));
  S('many-tokens', '海量 token', 'x '.repeat(300000));
  return c;
}

// ── targets (only surfaces NOT already in fuzz-input.js) ──
function buildTargets() {
  const t = [];
  const add = (name, invoke) => t.push({ name, invoke });

  try {
    const ai = cli('ai');
    const ex = ai.__test__ && ai.__test__._extractFileReferences;
    if (ex) add('ai._extractFileReferences', (s) => ex(s));
  } catch (e) { add('ai.LOAD', () => { throw e; }); }

  try {
    const kf = cli('keyFindings');
    add('keyFindings.detectTestOutcome', (s) => kf.detectTestOutcome(s));
    add('keyFindings.parseModelFindings', (s) => kf.parseModelFindings(s));
    add('keyFindings.stripFindings', (s) => kf.stripFindings(s));
  } catch (e) { add('keyFindings.LOAD', () => { throw e; }); }

  try {
    const tcn = cli('toolCallNoise');
    add('toolCallNoise.stripInlineToolCallNoise', (s) => tcn.stripInlineToolCallNoise(s));
  } catch (e) { add('toolCallNoise.LOAD', () => { throw e; }); }

  try {
    const es = cli('errorSummary');
    add('errorSummary.compactAiErrorReply', (s) => es.compactAiErrorReply(s));
  } catch (e) { add('errorSummary.LOAD', () => { throw e; }); }

  try {
    const ks = cli('repl/khySettings');
    // deep-merge over an attacker-controlled object (prototype-pollution + throw probe)
    add('khySettings._deepMerge', (s) => ks._deepMerge({ a: 1 }, { '__proto__': { p: 1 }, k: String(s).slice(0, 100) }));
  } catch (e) { add('khySettings.LOAD', () => { throw e; }); }

  return t;
}

function withTimeout(thunk, ms) {
  // Synchronous ReDoS cannot be interrupted by a timer on the same thread, so we
  // measure wall-clock after the call returns and flag anything over budget as a
  // hang. (A truly infinite hang would freeze the process — acceptable for a
  // diagnostic; the budget catches the realistic O(n²) blowups.)
  const t0 = Date.now();
  let threw = null;
  try { thunk(); } catch (e) { threw = e; }
  return { ms: Date.now() - t0, threw };
}

function main() {
  const json = process.argv.slice(2).includes('--json');
  const corpus = buildStringCorpus();
  const targets = buildTargets();
  const findings = [];
  const counts = { ok: 0, throw: 0, hang: 0 };
  let total = 0;

  for (const tgt of targets) {
    for (const c of corpus) {
      total += 1;
      const { ms, threw } = withTimeout(() => tgt.invoke(c.value), CALL_BUDGET_MS);
      if (threw) {
        counts.throw += 1;
        findings.push({ target: tgt.name, caseId: c.id, note: c.note, status: 'throw', ms, detail: threw.message });
      } else if (ms > CALL_BUDGET_MS) {
        counts.hang += 1;
        findings.push({ target: tgt.name, caseId: c.id, note: c.note, status: 'hang', ms, detail: `exceeded ${CALL_BUDGET_MS}ms` });
      } else {
        counts.ok += 1;
      }
    }
  }

  const hard = findings.filter((f) => f.status === 'throw' || f.status === 'hang');

  if (json) {
    process.stdout.write(JSON.stringify({
      schema: 'khy.fuzz-input-round1/v1', total, counts,
      targets: targets.length, corpusSize: corpus.length, findings,
    }, null, 2) + '\n');
  } else {
    process.stdout.write(`输入面对抗式模糊 Round-1 —— ${targets.length} 目标 × ${corpus.length} 用例\n`);
    process.stdout.write('='.repeat(64) + '\n');
    process.stdout.write(`共 ${total} 次调用\n`);
    process.stdout.write(`ok=${counts.ok}  throw=${counts.throw}  hang=${counts.hang}\n\n`);
    if (findings.length === 0) {
      process.stdout.write('未发现 throw / hang。\n');
    } else {
      for (const f of findings) {
        process.stdout.write(`[${f.status.toUpperCase()}] ${f.target}  ←  ${f.caseId} (${f.note})\n`);
        process.stdout.write(`        ${f.detail}  (${f.ms}ms)\n`);
      }
    }
    process.stdout.write('\n' + '='.repeat(64) + '\n');
    process.stdout.write(hard.length ? `硬失败: ${hard.length} —— 需修复\n` : '无硬失败(throw/hang)。\n');
  }

  process.exit(hard.length > 0 ? 1 : 0);
}

main();
