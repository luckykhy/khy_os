'use strict';
/**
 * videoIngestionFuzz.test.js �?regression for the VIDEO ingestion surface.
 *
 * Video input reaches khyos via three always-run layers that must NEVER throw on
 * hostile/garbled/unknown bytes or malformed MIME strings (their contract is
 * "fail with a structured result, never crash the request"):
 *   1. mediaUnderstanding.mimeToCapability / mediaRegistry.{findByMimeType,
 *      getBestProvider,buildFallbackChain} �?pure classification of the MIME label.
 *   2. multimodalInputService.detectInlineMediaPaths �?parses a user message for a
 *      video path (never throws on odd paths / nonexistent files).
 *   3. mediaTranscriptionService.transcribeMediaFile(/Async) �?top-level file &
 *      engine guards return {success:false,error} before any subprocess.
 *
 * The adversarial video byte corpus + real ffmpeg/whisper spawn path are exercised
 * by extensions/scripts/khy-diagnostics/fuzz-video-io.js (247 calls, 0 throw/0 hang, including a
 * stubbed pathological whisper/ffmpeg/whisper-cpp chain and a hanging-tool timeout
 * proof). This suite locks the pure/guard behavior that runs on every machine.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const understanding = require('../src/services/mediaUnderstanding.js');
const multimodal = require('../src/services/multimodalInputService.js');
const transcription = require('../src/services/mediaTranscriptionService.js');
const { buildVideoMimeCorpus, buildVideoCorpus } = require('../../../extensions/scripts/khy-diagnostics/fuzzVideoCorpus.js');
const CAP_VIDEO = 0b0100;
// ── 1. mimeToCapability: correct on valid, 0 on malformed, never throws ──
// ── 2. registry classification never throws on malformed MIME ──
// ── 3. detectInlineMediaPaths never throws on video paths ──
// ── 4. transcribeMediaFile top-level guards: structured error, no subprocess ──
// ── 5. corpus generators are deterministic & well-formed ──

describe('Video Ingestion Fuzz', () => {
  test('mimeToCapability maps valid video MIME to the VIDEO capability', () => {
      expect(understanding.mimeToCapability('video/mp4')).toBe(CAP_VIDEO);
      expect(understanding.mimeToCapability('video/webm')).toBe(CAP_VIDEO);
      // exact 'video/' key + prefix path both resolve to VIDEO
      expect(understanding.mimeToCapability('video/')).toBe(CAP_VIDEO);
      expect(understanding.mimeToCapability('VIDEO/MP4')).toBe(CAP_VIDEO); // case-insensitive
  });

  test('mimeToCapability returns 0 for non-string / prefix-collision / non-video', () => {
      expect(understanding.mimeToCapability(null)).toBe(0);
      expect(understanding.mimeToCapability(undefined)).toBe(0);
      expect(understanding.mimeToCapability(42)).toBe(0);
      expect(understanding.mimeToCapability({})).toBe(0);
      expect(understanding.mimeToCapability('video')).toBe(0); // no slash �?not a MIME
      expect(understanding.mimeToCapability('application/octet-stream')).toBe(0);
  });

  test('mimeToCapability never throws across the full malformed-MIME corpus', () => {
      for (const mc of buildVideoMimeCorpus()) {
        expect(() => understanding.mimeToCapability(mc.mime).not.toThrow(), `case ${mc.id}`);
      }
  });

  test('mediaRegistry.{findByMimeType,getBestProvider,buildFallbackChain} never throw', () => {
      const reg = understanding.mediaRegistry;
      for (const mc of buildVideoMimeCorpus()) {
        assert.doesNotThrow(() => {
          const list = reg.findByMimeType(mc.mime);
          expect(Array.isArray(list)).toBeTruthy();
          reg.getBestProvider(mc.mime, 5); // null-or-provider, must not throw
          const chain = reg.buildFallbackChain(mc.mime, 0);
          expect(Array.isArray(chain)).toBeTruthy();
        }, `case ${mc.id}`);
      }
  });

  test('detectInlineMediaPaths returns an array (never throws) for a video-path message', () => {
      let out;
      assert.doesNotThrow(() => {
        out = multimodal.detectInlineMediaPaths('请分析这个视�?/tmp/does-not-exist-clip.mp4');
      });
      expect(Array.isArray(out).toBeTruthy());
      // nonexistent file �?filtered out by the internal stat guard
      expect(out.length).toBe(0);
  });

  test('transcribeMediaFile returns structured error for a missing file', () => {
      const r = transcription.transcribeMediaFile('/tmp/khy-no-such-video.mp4', 'video/mp4', {});
      expect(r.success).toBe(false);
      expect(String(r.error)).toMatch(/file not found/i);
  });

  test('transcribeMediaFile returns structured error for an empty file', () => {
      const f = path.join(os.tmpdir(), `khy-empty-${process.pid}.mp4`);
      fs.writeFileSync(f, Buffer.alloc(0));
      try {
        const r = transcription.transcribeMediaFile(f, 'video/mp4', {});
        expect(r.success).toBe(false);
        expect(String(r.error)).toMatch(/empty file/i);
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
        expect(r.success).toBe(false);
        expect(String(r.error)).toMatch(/too large/i);
      } finally {
        try { fs.unlinkSync(f); } catch { /* ignore */ }
      }
  });

  test('transcribeMediaFile returns structured error for an unsupported media kind', () => {
      const f = path.join(os.tmpdir(), `khy-notmedia-${process.pid}.txt`);
      fs.writeFileSync(f, Buffer.from('just text, not a video'));
      try {
        const r = transcription.transcribeMediaFile(f, '', {}); // no mime, .txt ext �?unknown kind
        expect(r.success).toBe(false);
        expect(String(r.error)).toMatch(/unsupported media kind/i);
      } finally {
        try { fs.unlinkSync(f); } catch { /* ignore */ }
      }
  });

  test('buildVideoCorpus yields deterministic, non-empty, extension-tagged buffers', () => {
      const a = buildVideoCorpus();
      const b = buildVideoCorpus();
      expect(a.length >= 30).toBeTruthy();
      expect(a.length).toBe(b.length);
      for (let i = 0; i < a.length; i++) {
        expect(Buffer.isBuffer(a[i].buffer)).toBeTruthy();
        expect(a[i].buffer.equals(b[i].buffer)).toBeTruthy();
        expect(a[i].name).toBeTruthy();
      }
  });

});

