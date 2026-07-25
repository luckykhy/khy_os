#!/usr/bin/env node
'use strict';
/**
 * 文件摄入「IO 编排层」对抗式模糊测试(诊断工具,非发布门禁)。
 *
 * 与 fuzz-file-input.js(纯分类器,无 IO)互补:本仪器把 fuzzFileCorpus 的对抗字节
 * **真正落盘成临时文件**,再喂给 khyos 真实的文件摄入 IO 编排器——它们会调用真实的
 * 第三方库(node-stream-zip / tar / pdftotext / tesseract)去打开这些畸形文件:
 *   - archiveInspectService.inspectArchive        (畸形 zip/tar、伪装 docx、zip-bomb 名)
 *   - documentSnippetService.extractDocumentSnippet(+ Async)(截断/伪装 PDF)
 *   - ocrSnippetService.extractImageOcrSnippet     (截断/非常见图片 BMP/TIFF/HEIC)
 *   - multimodalInputService.prepareMultimodalInput(+ Async)(把落盘文件当附件走全流程)
 *   - atMentionInject.resolveAtMentions            (@ 提及畸形文件)
 *
 * 这些编排器的**书面契约都是「绝不抛,失败以结构化 {success:false,error} 诚实上报」**。
 * 任何 throw / hang 都是真缺陷:上游把用户附件(压缩包/word/图片)喂进来时会崩。
 *
 * 所有临时文件写入 os.tmpdir() 下的一次性目录,结束时清理。退出码:0=无硬失败;1=有。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildBufferCorpus } = require('./fuzzFileCorpus');

const BACKEND = path.resolve(__dirname, '..', '..', 'services', 'backend', 'src');
function be(rel) { return require(path.join(BACKEND, rel)); }

const CALL_BUDGET_MS = 8000; // IO + 子进程,预算比纯函数宽松

// 每个 corpus 用例映射到「按其真实扩展名落盘 → 喂给哪些编排器」。
// 归档类 → inspectArchive;PDF → extractDocumentSnippet;图片 → ocr;全部 → multimodal + atMention。
function archiveMimeFor(name) {
  const n = String(name || '').toLowerCase();
  if (n.endsWith('.zip') || n.endsWith('.docx') || n.endsWith('.xlsx') || n.endsWith('.pptx')) return 'application/zip';
  if (n.endsWith('.tar')) return 'application/x-tar';
  if (n.endsWith('.gz')) return 'application/gzip';
  return '';
}

async function withTimeout(promise, ms, label) {
  let timer = null;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`__HANG__ ${label} exceeded ${ms}ms`)), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([Promise.resolve(promise), guard]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function detectBadOutput(value) {
  const probe = (v) => {
    if (typeof v === 'number' && Number.isNaN(v)) return 'NaN';
    if (typeof v === 'string') {
      if (v.includes('[object Object]')) return '[object Object]';
      if (/\bundefined\b/.test(v)) return 'contains "undefined"';
    }
    return null;
  };
  if (value == null) return null;
  if (typeof value === 'object') {
    for (const k of Object.keys(value)) {
      const r = probe(value[k]);
      if (r) return `field ${k}: ${r}`;
    }
    return null;
  }
  return probe(value);
}

async function runOne(label, thunk) {
  const start = Number(process.hrtime.bigint() / 1000000n);
  try {
    const out = await withTimeout(thunk(), CALL_BUDGET_MS, label);
    const ms = Number(process.hrtime.bigint() / 1000000n) - start;
    const bad = detectBadOutput(out);
    if (bad) return { status: 'bad-output', ms, detail: bad };
    return { status: 'ok', ms, detail: '' };
  } catch (err) {
    const ms = Number(process.hrtime.bigint() / 1000000n) - start;
    const msg = (err && err.message) ? err.message : String(err);
    if (msg.startsWith('__HANG__')) return { status: 'hang', ms, detail: msg.replace('__HANG__ ', '') };
    return { status: 'throw', ms, detail: msg };
  }
}

async function main() {
  const json = process.argv.slice(2).includes('--json');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-fuzz-io-'));

  const archive = be('services/archiveInspectService.js');
  const docSnippet = be('services/documentSnippetService.js');
  const ocr = be('services/ocrSnippetService.js');
  const multimodal = be('services/multimodalInputService.js');
  const atMention = be('cli/atMentionInject.js');

  const corpus = buildBufferCorpus();
  const findings = [];
  const counts = { ok: 0, throw: 0, hang: 0, 'bad-output': 0 };
  let total = 0;

  const record = async (target, caseId, category, note, filePath, thunk) => {
    total += 1;
    const r = await runOne(`${target}:${caseId}`, thunk);
    counts[r.status] = (counts[r.status] || 0) + 1;
    if (r.status !== 'ok') {
      findings.push({
        target, caseId, category, note,
        status: r.status, ms: r.ms, detail: r.detail,
        file: path.basename(filePath || '-'),
      });
    }
  };

  for (const c of corpus) {
    // 落盘为带真实扩展名的临时文件(名字唯一,避免碰撞)。
    const safeName = `${c.id}__${(c.name || 'blob').replace(/[^\w.\-]/g, '_')}`;
    const filePath = path.join(tmpRoot, safeName);
    try { fs.writeFileSync(filePath, c.buffer); } catch { continue; }

    // 1) 归档编排(仅归档类扩展名)。
    const amime = archiveMimeFor(c.name);
    if (amime) {
      await record('inspectArchive', c.id, c.category, c.note, filePath,
        () => archive.inspectArchive(filePath, amime, { env: { ...process.env, KHY_ARCHIVE_INSPECT: '1' } }));
      await record('inspectArchiveToManifest', c.id, c.category, c.note, filePath,
        () => archive.inspectArchiveToManifest(filePath, amime, { env: { ...process.env, KHY_ARCHIVE_INSPECT: '1' } }));
    }

    // 2) PDF 抽取编排(.pdf 或 PDF magic)。
    const isPdf = /\.pdf$/i.test(c.name || '') || c.buffer.subarray(0, 5).toString('latin1') === '%PDF-';
    if (isPdf) {
      await record('extractDocumentSnippet', c.id, c.category, c.note, filePath,
        () => docSnippet.extractDocumentSnippet(filePath, 'application/pdf', { timeoutMs: 2000 }));
      await record('extractDocumentSnippetAsync', c.id, c.category, c.note, filePath,
        () => docSnippet.extractDocumentSnippetAsync(filePath, 'application/pdf', { timeoutMs: 2000, totalBudgetMs: 3000 }));
    }

    // 3) 图片 OCR 编排(图片类扩展名/magic)。
    const isImg = /\.(png|jpg|jpeg|gif|webp|bmp|tiff?|heic|avif|svg|ico)$/i.test(c.name || '')
      || c.category === 'image' || c.category === 'uncommon-image';
    if (isImg) {
      await record('extractImageOcrSnippet', c.id, c.category, c.note, filePath,
        () => ocr.extractImageOcrSnippet(filePath, '', { timeoutMs: 2000 }));
      await record('extractImageOcrSnippetAsync', c.id, c.category, c.note, filePath,
        () => ocr.extractImageOcrSnippetAsync(filePath, '', { timeoutMs: 2000, totalBudgetMs: 3000 }));
    }

    // 4) 多模态全流程(把落盘文件路径写进用户消息里,走内联媒体检测全流程)。
    const mmMsg = `请分析这个文件 ${filePath}`;
    await record('prepareMultimodalInput', c.id, c.category, c.note, filePath,
      () => multimodal.prepareMultimodalInput(mmMsg, { env: process.env }));
    await record('prepareMultimodalInputAsync', c.id, c.category, c.note, filePath,
      () => multimodal.prepareMultimodalInputAsync(mmMsg, { env: process.env }));

    // 5) @ 提及畸形文件(相对当前 tmpRoot)。
    await record('resolveAtMentions', c.id, c.category, c.note, filePath,
      () => atMention.resolveAtMentions(`看看 @${safeName} 这个文件`, {
        cwd: tmpRoot, env: { ...process.env, KHY_AT_MENTION: '1' },
      }));
  }

  // 清理临时目录(fail-soft)。
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }

  const hard = findings.filter((f) => f.status === 'throw' || f.status === 'hang');

  if (json) {
    process.stdout.write(JSON.stringify({
      schema: 'khy.fuzz-file-io/v1',
      total, counts, corpusSize: corpus.length,
      hardFailures: hard.length, findings,
    }, null, 2) + '\n');
  } else {
    process.stdout.write(`文件摄入 IO 编排模糊测试 —— ${corpus.length} 个落盘用例\n`);
    process.stdout.write('='.repeat(64) + '\n');
    process.stdout.write(`共 ${total} 次编排调用\n`);
    process.stdout.write(`ok=${counts.ok}  throw=${counts.throw}  hang=${counts.hang}  bad-output=${counts['bad-output']}\n\n`);
    if (findings.length === 0) {
      process.stdout.write('未发现 throw / hang / bad-output。\n');
    } else {
      for (const f of findings) {
        process.stdout.write(`[${f.status.toUpperCase()}] ${f.target}  ←  ${f.caseId} (${f.category}: ${f.note})\n`);
        process.stdout.write(`        文件: ${f.file}\n`);
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

main().catch((err) => {
  process.stderr.write(`harness 自身异常: ${(err && err.stack) || err}\n`);
  process.exit(2);
});
