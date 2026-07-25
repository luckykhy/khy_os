#!/usr/bin/env node
'use strict';
/**
 * 视频输入「IO 编排层」对抗式模糊测试(诊断工具,非发布门禁)。
 *
 * 承 fuzz-file-io.js(图片/压缩包/文档),本仪器专攻**视频摄入通道**。把
 * fuzzVideoCorpus 的对抗字节**真正落盘成带视频扩展名的临时文件**,再喂给 khyos 真实的
 * 视频摄入 IO 编排器:
 *   - mediaTranscriptionService.transcribeMediaFile(+ Async)(畸形容器 → 真实 ffmpeg/whisper)
 *   - multimodalInputService.detectInlineMediaPaths(把落盘视频路径写进消息里做内联检测)
 *   - multimodalInputService.prepareMultimodalInput(+ Async)(走全流程,含转写接缝)
 *   - atMentionInject.resolveAtMentions(@ 提及畸形视频)
 *
 * 另跑**纯分类面**(mediaUnderstanding):mimeToCapability / findByMimeType /
 * getBestProvider / buildFallbackChain,喂畸形 MIME 字符串(非字符串/超长/前缀碰撞)。
 *
 * 这些编排器/分类器的**书面契约都是「绝不抛,失败以结构化 {success:false,error} 上报」**。
 * 任何 throw / hang / bad-output 都是真缺陷:上游把用户视频喂进来时会崩。
 *
 * 注:本机若无 ffmpeg/whisper,transcribe 会在触碰字节前以「无本地转写引擎」结构化早退;
 * 有 ffmpeg 的机器上则真实以 ffmpeg 解码畸形容器(其非零退出同样以结构化 error 上报)。
 * 为廉价触发「文件过大」尺寸守卫分支,额外用极低 MAX_BYTES 环境变量跑一遍首个用例。
 *
 * 所有临时文件写入 os.tmpdir() 下的一次性目录,结束时清理。退出码:0=无硬失败;1=有。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildVideoCorpus, buildVideoMimeCorpus } = require('./fuzzVideoCorpus');

const BACKEND = path.resolve(__dirname, '..', '..', 'services', 'backend', 'src');
function be(rel) { return require(path.join(BACKEND, rel)); }

const CALL_BUDGET_MS = 8000; // IO + 子进程,预算比纯函数宽松

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
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-fuzz-video-'));

  const transcription = be('services/mediaTranscriptionService.js');
  const multimodal = be('services/multimodalInputService.js');
  const understanding = be('services/mediaUnderstanding.js');
  const atMention = be('cli/atMentionInject.js');

  const findings = [];
  const counts = { ok: 0, throw: 0, hang: 0, 'bad-output': 0 };
  let total = 0;

  const record = async (target, caseId, category, note, thunk) => {
    total += 1;
    const r = await runOne(`${target}:${caseId}`, thunk);
    counts[r.status] = (counts[r.status] || 0) + 1;
    if (r.status !== 'ok') {
      findings.push({ target, caseId, category, note, status: r.status, ms: r.ms, detail: r.detail });
    }
  };

  const mimeFor = (name) => {
    const n = String(name || '').toLowerCase();
    if (n.endsWith('.mp4')) return 'video/mp4';
    if (n.endsWith('.mov')) return 'video/quicktime';
    if (n.endsWith('.webm')) return 'video/webm';
    if (n.endsWith('.mkv')) return 'video/x-matroska';
    if (n.endsWith('.avi')) return 'video/x-msvideo';
    return 'video/mp4';
  };

  // ── A. 落盘视频字节 → 驱动真实 IO 编排 ───────────────────────────────────
  const corpus = buildVideoCorpus();
  for (const c of corpus) {
    const safeName = `${c.id}__${(c.name || 'blob').replace(/[^\w.\-]/g, '_')}`;
    const filePath = path.join(tmpRoot, safeName);
    try { fs.writeFileSync(filePath, c.buffer); } catch { continue; }
    const mime = mimeFor(c.name);

    // 1) 直接转写(视频容器 → ffmpeg 抽音轨 + whisper)。
    await record('transcribeMediaFile', c.id, c.category, c.note,
      () => transcription.transcribeMediaFile(filePath, mime, { timeoutMs: 5000 }));
    await record('transcribeMediaFileAsync', c.id, c.category, c.note,
      () => transcription.transcribeMediaFileAsync(filePath, mime, { timeoutMs: 5000, totalBudgetMs: 6000 }));

    // 2) 内联媒体路径检测(把落盘视频写进消息)。
    const mmMsg = `请帮我分析这个视频 ${filePath}`;
    await record('detectInlineMediaPaths', c.id, c.category, c.note,
      () => multimodal.detectInlineMediaPaths(mmMsg));

    // 3) 多模态全流程(sync + async,含转写接缝)。
    await record('prepareMultimodalInput', c.id, c.category, c.note,
      () => multimodal.prepareMultimodalInput(mmMsg, { env: process.env }));
    await record('prepareMultimodalInputAsync', c.id, c.category, c.note,
      () => multimodal.prepareMultimodalInputAsync(mmMsg, { env: process.env }));

    // 4) @ 提及畸形视频(相对 tmpRoot)。
    await record('resolveAtMentions', c.id, c.category, c.note,
      () => atMention.resolveAtMentions(`看看 @${safeName} 这个视频`, {
        cwd: tmpRoot, env: { ...process.env, KHY_AT_MENTION: '1' },
      }));
  }

  // ── B. 中等体积文件的 no-throw(尺寸守卫的「过大」分支因 MAX_BYTES 是 require 期
  //        冻结常量[5MB 下限],无法在本进程内触发;该分支由 videoIngestionFuzz.test.js
  //        的子进程用例覆盖。此处仅确认中等文件不抛)。──────────────────────────
  {
    const big = path.join(tmpRoot, 'sizeguard.mp4');
    try {
      fs.writeFileSync(big, Buffer.alloc(64 * 1024, 0)); // 64KB
      await record('transcribeMediaFile', 'size-mid', 'edge', '64KB 文件 no-throw',
        () => transcription.transcribeMediaFile(big, 'video/mp4', { timeoutMs: 5000 }));
    } catch { /* ignore write failure */ }
  }

  // ── C. 纯分类面:畸形 MIME 字符串喂 mediaUnderstanding ──────────────────
  const mimeCorpus = buildVideoMimeCorpus();
  for (const mc of mimeCorpus) {
    await record('mimeToCapability', mc.id, 'mime', mc.note,
      () => understanding.mimeToCapability(mc.mime));
    await record('findByMimeType', mc.id, 'mime', mc.note,
      () => understanding.mediaRegistry.findByMimeType(mc.mime));
    await record('getBestProvider', mc.id, 'mime', mc.note,
      () => understanding.mediaRegistry.getBestProvider(mc.mime, 5));
    await record('buildFallbackChain', mc.id, 'mime', mc.note,
      () => understanding.mediaRegistry.buildFallbackChain(mc.mime, 0));
  }

  // 清理临时目录(fail-soft)。
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }

  const hard = findings.filter((f) => f.status === 'throw' || f.status === 'hang');

  if (json) {
    process.stdout.write(JSON.stringify({
      schema: 'khy.fuzz-video-io/v1',
      total, counts, corpusSize: corpus.length, mimeCorpusSize: mimeCorpus.length,
      hardFailures: hard.length, findings,
    }, null, 2) + '\n');
  } else {
    process.stdout.write(`视频输入 IO 编排模糊测试 —— ${corpus.length} 落盘 + ${mimeCorpus.length} MIME 用例\n`);
    process.stdout.write('='.repeat(64) + '\n');
    process.stdout.write(`共 ${total} 次调用\n`);
    process.stdout.write(`ok=${counts.ok}  throw=${counts.throw}  hang=${counts.hang}  bad-output=${counts['bad-output']}\n\n`);
    if (findings.length === 0) {
      process.stdout.write('未发现 throw / hang / bad-output。\n');
    } else {
      for (const f of findings) {
        process.stdout.write(`[${f.status.toUpperCase()}] ${f.target}  ←  ${f.caseId} (${f.category}: ${f.note})\n`);
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
