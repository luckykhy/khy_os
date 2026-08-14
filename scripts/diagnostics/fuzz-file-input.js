#!/usr/bin/env node
'use strict';
/**
 * 文件/图片摄入模糊测试仪器(诊断工具,非发布门禁)。
 *
 * 把 fuzzFileCorpus.js 的对抗载荷喂给 khyos 真实的**文件摄入分类器**:
 *   - Buffer 分类器:detectByMagic / detectBuffer / looksBinary(fileFormatDetector)、
 *     detectFormat(imageService)、parseELF / parsePE(binaryAnalyzer)、
 *     decodeBuffer(fileEncoding)。
 *   - 路径串解析器:detectInlineMediaPaths(multimodalInputService)、
 *     archiveStrategyForPath / mimeForArchive / isArchivePath(archiveManifestPolicy)。
 *   - item 规范化:normalizeImageItem / normalizeDocItem / canonicalMime(_imageCompat)。
 *
 * 每个 (target, case) 独立执行,捕获 throw / hang / bad-output,逐条定位。仅报告,不修。
 * 这些分类器全是「显示/预检」纯函数——面对畸形文件绝不应抛,应回退(null / UNKNOWN /
 * 原样)。任何 throw 都是真缺陷:上游文件摄入路径把用户附件喂进来时会崩。
 *
 * 退出码:0 = 无 throw/hang;1 = 存在 throw 或 hang。
 */

const path = require('path');
const {
  buildBufferCorpus,
  buildPathCorpus,
  buildItemCorpus,
} = require('./fuzzFileCorpus');

const BACKEND = path.resolve(__dirname, '..', '..', 'services', 'backend', 'src');
function be(rel) { return require(path.join(BACKEND, rel)); }

const CALL_BUDGET_MS = 2000;

// 三类目标:kind 决定喂什么载荷。
//   'buffer' → 用 bufferCorpus 的 .buffer/.name
//   'path'   → 用 pathCorpus 的 .input
//   'item'   → 用 itemCorpus 的 .item
function buildTargets() {
  const targets = [];
  const add = (name, kind, invoke) => targets.push({ name, kind, invoke });

  // ── Buffer 分类器 ─────────────────────────────────────────────────────────
  try {
    const ff = be('services/formatInspect/fileFormatDetector.js');
    add('fileFormat.detectByMagic', 'buffer', (c) => ff.detectByMagic(c.buffer));
    add('fileFormat.looksBinary', 'buffer', (c) => ff.looksBinary(c.buffer));
    add('fileFormat.detectBuffer', 'buffer', (c) => ff.detectBuffer(c.buffer, c.name));
  } catch (e) { add('fileFormat.LOAD', 'buffer', () => { throw e; }); }

  try {
    const img = be('services/imageService.js');
    add('imageService.detectFormat', 'buffer', (c) => img.detectFormat(c.buffer));
  } catch (e) { add('imageService.LOAD', 'buffer', () => { throw e; }); }

  try {
    const ba = be('services/binaryAnalyzer.js');
    add('binaryAnalyzer.parseELF', 'buffer', (c) => ba.parseELF(c.buffer));
    add('binaryAnalyzer.parsePE', 'buffer', (c) => ba.parsePE(c.buffer));
  } catch (e) { add('binaryAnalyzer.LOAD', 'buffer', () => { throw e; }); }

  try {
    const fe = be('utils/fileEncoding.js');
    // 用 auto / utf-8 / latin1 / 一个不存在的编码 分别解码,探边界。
    add('fileEncoding.decodeBuffer.utf8', 'buffer', (c) => fe.decodeBuffer(c.buffer, 'utf-8'));
    add('fileEncoding.decodeBuffer.bogus', 'buffer', (c) => fe.decodeBuffer(c.buffer, 'x-not-a-real-encoding'));
  } catch (e) { add('fileEncoding.LOAD', 'buffer', () => { throw e; }); }

  // ── 路径串解析器 ──────────────────────────────────────────────────────────
  try {
    const mm = be('services/multimodalInputService.js');
    add('multimodal.detectInlineMediaPaths', 'path', (s) => mm.detectInlineMediaPaths(s));
  } catch (e) { add('multimodal.LOAD', 'path', () => { throw e; }); }

  try {
    const amp = be('services/archiveManifestPolicy.js');
    add('archivePolicy.archiveStrategyForPath', 'path', (s) => amp.archiveStrategyForPath(s));
    add('archivePolicy.isArchivePath', 'path', (s) => amp.isArchivePath(s));
    add('archivePolicy.mimeForArchive', 'path', (s) => amp.mimeForArchive(s));
    add('archivePolicy.isTextLikeEntry', 'path', (s) => amp.isTextLikeEntry(s));
  } catch (e) { add('archivePolicy.LOAD', 'path', () => { throw e; }); }

  // ── item 规范化 ───────────────────────────────────────────────────────────
  try {
    const ic = be('services/gateway/adapters/_imageCompat.js');
    add('imageCompat.normalizeImageItem', 'item', (it) => ic.normalizeImageItem(it));
    add('imageCompat.normalizeDocItem', 'item', (it) => ic.normalizeDocItem(it));
    add('imageCompat.canonicalMime', 'item', (it) => ic.canonicalMime(typeof it === 'string' ? it : (it && it.mimeType)));
  } catch (e) { add('imageCompat.LOAD', 'item', () => { throw e; }); }

  return targets;
}

function summarizeBuffer(c) {
  const b = c.buffer;
  const head = b.slice(0, 12).toString('hex');
  return `name=${c.name || '-'} len=${b.length} hex=${head}${b.length > 12 ? '…' : ''}`;
}
function summarizeStr(s) {
  const str = String(s);
  const head = str.slice(0, 40).replace(/[\x00-\x1f\x7f]/g, (ch) => '\\x' + ch.charCodeAt(0).toString(16).padStart(2, '0'));
  return `len=${str.length} "${head}${str.length > 40 ? '…' : ''}"`;
}
function summarizeItem(it) {
  if (it === null) return 'null';
  if (typeof it === 'string') return summarizeStr(it);
  try { return `type=${typeof it} keys=${Array.isArray(it) ? 'array' : Object.keys(it).join(',')}`; }
  catch { return `type=${typeof it}`; }
}

function detectBadOutput(value) {
  const probe = (v) => {
    if (typeof v === 'number' && Number.isNaN(v)) return 'NaN';
    if (typeof v === 'string') {
      if (/\bundefined\b/.test(v)) return 'contains "undefined"';
      if (v.includes('[object Object]')) return '[object Object]';
      if (v.includes('NaN')) return 'contains "NaN"';
    }
    return null;
  };
  if (value == null) return null;
  if (Array.isArray(value)) { for (const it of value) { const r = probe(it); if (r) return r; } return null; }
  if (typeof value === 'object') {
    for (const k of Object.keys(value)) {
      const r = probe(value[k]);
      if (r) return `field ${k}: ${r}`;
    }
    return null;
  }
  return probe(value);
}

function runOne(target, tc) {
  const payload = target.kind === 'buffer' ? tc : (target.kind === 'item' ? tc.item : tc.input);
  const start = Number(process.hrtime.bigint() / 1000000n);
  try {
    const out = target.invoke(payload);
    const ms = Number(process.hrtime.bigint() / 1000000n) - start;
    if (ms > CALL_BUDGET_MS) return { status: 'hang', ms, detail: `exceeded ${CALL_BUDGET_MS}ms budget` };
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

  const bufferCorpus = buildBufferCorpus();
  const pathCorpus = buildPathCorpus();
  const itemCorpus = buildItemCorpus();
  const corpusFor = { buffer: bufferCorpus, path: pathCorpus, item: itemCorpus };

  const targets = buildTargets();
  const findings = [];
  let total = 0;
  const counts = { ok: 0, throw: 0, hang: 0, 'bad-output': 0 };

  for (const target of targets) {
    const corpus = corpusFor[target.kind];
    for (const tc of corpus) {
      total += 1;
      const r = runOne(target, tc);
      counts[r.status] = (counts[r.status] || 0) + 1;
      if (r.status !== 'ok') {
        const summary = target.kind === 'buffer' ? summarizeBuffer(tc)
          : target.kind === 'item' ? summarizeItem(tc.item) : summarizeStr(tc.input);
        findings.push({
          target: target.name, kind: target.kind,
          caseId: tc.id, category: tc.category, note: tc.note,
          status: r.status, ms: r.ms, detail: r.detail, inputSummary: summary,
        });
      }
    }
  }

  const hard = findings.filter((f) => f.status === 'throw' || f.status === 'hang');

  if (json) {
    process.stdout.write(JSON.stringify({
      schema: 'khy.fuzz-file/v1',
      total, counts,
      targets: targets.map((t) => t.name),
      corpusSizes: { buffer: bufferCorpus.length, path: pathCorpus.length, item: itemCorpus.length },
      hardFailures: hard.length, findings,
    }, null, 2) + '\n');
  } else {
    process.stdout.write(`文件/图片摄入模糊测试 —— ${targets.length} 个分类器\n`);
    process.stdout.write(`语料:buffer=${bufferCorpus.length} path=${pathCorpus.length} item=${itemCorpus.length}  共 ${total} 次调用\n`);
    process.stdout.write('='.repeat(64) + '\n');
    process.stdout.write(`ok=${counts.ok}  throw=${counts.throw}  hang=${counts.hang}  bad-output=${counts['bad-output']}\n\n`);
    if (findings.length === 0) {
      process.stdout.write('未发现 throw / hang / bad-output。\n');
    } else {
      for (const f of findings) {
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
