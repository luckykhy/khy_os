'use strict';

/**
 * videoIngestionFuzz.test.js — regression for the VIDEO ingestion surface.
 *
 * Video input reaches khyos via three always-run layers that must NEVER throw on
 * hostile/garbled/unknown bytes or malformed MIME strings (their contract is
 * "fail with a structured result, never crash the request"):
 *   1. mediaUnderstanding.mimeToCapability / mediaRegistry.{findByMimeType,
 *      getBestProvider,buildFallbackChain} — pure classification of the MIME label.
 *   2. multimodalInputService.detectInlineMediaPaths — parses a user message for a
 *      video path (never throws on odd paths / nonexistent files).
 *   3. mediaTranscriptionService.transcribeMediaFile(/Async) — top-level file &
 *      engine guards return {success:false,error} before any subprocess.
 *
 * The adversarial video byte corpus + real ffmpeg/whisper spawn path are exercised
 * by scripts/diagnostics/fuzz-video-io.js (247 calls, 0 throw/0 hang, including a
 * stubbed pathological whisper/ffmpeg/whisper-cpp chain and a hanging-tool timeout
 * proof). This suite locks the pure/guard behavior that runs on every machine.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

const understanding = require('../src/services/mediaUnderstanding.js');
const multimodal = require('../src/services/multimodalInputService.js');
const transcription = require('../src/services/mediaTranscriptionService.js');
const { buildVideoMimeCorpus, buildVideoCorpus } = require('../../../scripts/diagnostics/fuzzVideoCorpus.js');

const CAP_VIDEO = 0b0100;

// ── 1. mimeToCapability: correct on valid, 0 on malformed, never throws ──

test('mimeToCapability maps valid video MIME to the VIDEO capability', () => {
  assert.equal(understanding.mimeToCapability('video/mp4'), CAP_VIDEO);
  assert.equal(understanding.mimeToCapability('video/webm'), CAP_VIDEO);
  // exact 'video/' key + prefix path both resolve to VIDEO
  assert.equal(understanding.mimeToCapability('video/'), CAP_VIDEO);
  assert.equal(understanding.mimeToCapability('VIDEO/MP4'), CAP_VIDEO); // case-insensitive
});

test('mimeToCapability returns 0 for non-string / prefix-collision / non-video', () => {
  assert.equal(understanding.mimeToCapability(null), 0);
  assert.equal(understanding.mimeToCapability(undefined), 0);
  assert.equal(understanding.mimeToCapability(42), 0);
  assert.equal(understanding.mimeToCapability({}), 0);
  assert.equal(understanding.mimeToCapability('video'), 0); // no slash → not a MIME
  assert.equal(understanding.mimeToCapability('application/octet-stream'), 0);
});

test('mimeToCapability never throws across the full malformed-MIME corpus', () => {
  for (const mc of buildVideoMimeCorpus()) {
    assert.doesNotThrow(() => understanding.mimeToCapability(mc.mime), `case ${mc.id}`);
  }
});

// ── 2. registry classification never throws on malformed MIME ──

test('mediaRegistry.{findByMimeType,getBestProvider,buildFallbackChain} never throw', () => {
  const reg = understanding.mediaRegistry;
  for (const mc of buildVideoMimeCorpus()) {
    assert.doesNotThrow(() => {
      const list = reg.findByMimeType(mc.mime);
      assert.ok(Array.isArray(list), `findByMimeType(${mc.id}) returns array`);
      reg.getBestProvider(mc.mime, 5); // null-or-provider, must not throw
      const chain = reg.buildFallbackChain(mc.mime, 0);
      assert.ok(Array.isArray(chain), `buildFallbackChain(${mc.id}) returns array`);
    }, `case ${mc.id}`);
  }
});

// ── 3. detectInlineMediaPaths never throws on video paths ──

test('detectInlineMediaPaths returns an array (never throws) for a video-path message', () => {
  let out;
  assert.doesNotThrow(() => {
    out = multimodal.detectInlineMediaPaths('请分析这个视频 /tmp/does-not-exist-clip.mp4');
  });
  assert.ok(Array.isArray(out));
  // nonexistent file → filtered out by the internal stat guard
  assert.equal(out.length, 0);
});

// ── 4. transcribeMediaFile top-level guards: structured error, no subprocess ──

test('transcribeMediaFile returns structured error for a missing file', () => {
  const r = transcription.transcribeMediaFile('/tmp/khy-no-such-video.mp4', 'video/mp4', {});
  assert.equal(r.success, false);
  assert.match(String(r.error), /file not found/i);
});

test('transcribeMediaFile returns structured error for an empty file', () => {
  const f = path.join(os.tmpdir(), `khy-empty-${process.pid}.mp4`);
  fs.writeFileSync(f, Buffer.alloc(0));
  try {
    const r = transcription.transcribeMediaFile(f, 'video/mp4', {});
    assert.equal(r.success, false);
    assert.match(String(r.error), /empty file/i);
  } finally {
    try { fs.unlinkSync(f); } catch { /* ignore */ }
  }
});

test('transcribeMediaFile returns structured error for an over-size file (size guard)', () => {
  // MAX_BYTES is a module-load-frozen constant read from process.env at require
  // time, with a 5MB floor (Math.max(5MB, env)). The size-guard branch must be
  // exercised in a child process with the env set to the floor BEFORE load, and a
  // file just over it.
  const { execFileSync } = require('node:child_process');
  const FLOOR = 5 * 1024 * 1024;
  const f = path.join(os.tmpdir(), `khy-big-${process.pid}.mp4`);
  fs.writeFileSync(f, Buffer.alloc(FLOOR + 64 * 1024, 0)); // just over the 5MB floor
  const svcPath = path.resolve(__dirname, '../src/services/mediaTranscriptionService.js');
  const child = [
    `const svc=require(${JSON.stringify(svcPath)});`,
    `const r=svc.transcribeMediaFile(${JSON.stringify(f)},'video/mp4',{});`,
    `process.stdout.write(JSON.stringify(r));`,
  ].join('');
  try {
    const out = execFileSync(process.execPath, ['-e', child], {
      env: { ...process.env, KHY_MULTIMODAL_TRANSCRIBE_MAX_BYTES: String(FLOOR) },
      encoding: 'utf-8',
    });
    const r = JSON.parse(out);
    assert.equal(r.success, false);
    assert.match(String(r.error), /too large/i);
  } finally {
    try { fs.unlinkSync(f); } catch { /* ignore */ }
  }
});

test('transcribeMediaFile returns structured error for an unsupported media kind', () => {
  const f = path.join(os.tmpdir(), `khy-notmedia-${process.pid}.txt`);
  fs.writeFileSync(f, Buffer.from('just text, not a video'));
  try {
    const r = transcription.transcribeMediaFile(f, '', {}); // no mime, .txt ext → unknown kind
    assert.equal(r.success, false);
    assert.match(String(r.error), /unsupported media kind/i);
  } finally {
    try { fs.unlinkSync(f); } catch { /* ignore */ }
  }
});

// ── 5. corpus generators are deterministic & well-formed ──

test('buildVideoCorpus yields deterministic, non-empty, extension-tagged buffers', () => {
  const a = buildVideoCorpus();
  const b = buildVideoCorpus();
  assert.ok(a.length >= 30, 'corpus has a meaningful number of cases');
  assert.equal(a.length, b.length);
  for (let i = 0; i < a.length; i++) {
    assert.ok(Buffer.isBuffer(a[i].buffer), `case ${a[i].id} has a Buffer`);
    assert.ok(a[i].buffer.equals(b[i].buffer), `case ${a[i].id} is deterministic`);
    assert.ok(a[i].name, `case ${a[i].id} has a filename`);
  }
});
