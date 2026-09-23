'use strict';

/**
 * modelImportService.modelFormat.test.js — locks the format-detection / URL /
 * discovery helpers of the model-import pipeline without running the full
 * import (which shells out to ollama / downloads):
 *   - resolveModelUrl: HuggingFace blob→resolve 直链、ModelScope 补 download=true
 *     （已有 ? 用 & 拼接、已带则原样）、其它 URL / 非 URL 原样返回
 *   - looksLikeModelUrl: 模型文件后缀 / 已知托管站点 + 关键词 判定
 *   - looksLikeModelPath: 扩展名 / Ollama blob 名 / 带关键词的压缩包 纯判定
 *   - detectModelFormat: 临时目录下的 .gguf / .safetensors / 目录聚合 /
 *     空目录报错 / 路径不存在报错
 *   - scanForModelFiles: 递归扫描 gguf/safetensors/config.json 归类
 * 纯逻辑 + os.tmpdir 临时文件隔离，零网络零 ollama。谁改格式判定先红。
 */
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  resolveModelUrl,
  looksLikeModelUrl,
  looksLikeModelPath,
  detectModelFormat,
  scanForModelFiles,
} = require('../src/services/modelImportService');

describe('modelImportService resolveModelUrl 直链归一', () => {
  test('HuggingFace /blob/ → /resolve/', () => {
    const hf = 'https://huggingface.co/org/repo/blob/main/model.gguf';
    assert.strictEqual(
      resolveModelUrl(hf),
      'https://huggingface.co/org/repo/resolve/main/model.gguf',
    );
    const mirror = 'https://hf-mirror.com/org/repo/blob/main/x.gguf';
    assert.strictEqual(resolveModelUrl(mirror), 'https://hf-mirror.com/org/repo/resolve/main/x.gguf');
  });

  test('ModelScope 补 download=true（无 ? 用 ?，已有 ? 用 &，已带则原样）', () => {
    assert.strictEqual(
      resolveModelUrl('https://modelscope.cn/models/a/b'),
      'https://modelscope.cn/models/a/b?download=true',
    );
    assert.strictEqual(
      resolveModelUrl('https://modelscope.cn/models/a/b?x=1'),
      'https://modelscope.cn/models/a/b?x=1&download=true',
    );
    assert.strictEqual(
      resolveModelUrl('https://modelscope.cn/models/a/b?download=true'),
      'https://modelscope.cn/models/a/b?download=true',
    );
  });

  test('其它 URL / 非 URL 原样返回', () => {
    assert.strictEqual(resolveModelUrl('https://example.com/a/model.gguf'), 'https://example.com/a/model.gguf');
    assert.strictEqual(resolveModelUrl('   '), '');
  });
});

describe('modelImportService looksLikeModelUrl 判定', () => {
  test('模型文件后缀 URL → true', () => {
    assert.strictEqual(looksLikeModelUrl('https://x.example/m.gguf'), true);
    assert.strictEqual(looksLikeModelUrl('https://x.example/m.safetensors'), true);
    assert.strictEqual(looksLikeModelUrl('https://x.example/m.zip'), true);
  });

  test('已知托管站点 + 关键词 → true', () => {
    assert.strictEqual(looksLikeModelUrl('https://huggingface.co/org/awesome-model'), true);
    assert.strictEqual(looksLikeModelUrl('https://github.com/x/gguf-release'), true);
  });

  test('普通 URL / 空 → false', () => {
    assert.strictEqual(looksLikeModelUrl('https://example.com/page'), false);
    assert.strictEqual(looksLikeModelUrl(''), false);
    assert.strictEqual(looksLikeModelUrl(null), false);
  });
});

describe('modelImportService looksLikeModelPath 判定（纯扩展名/名称分支）', () => {
  test('模型文件扩展名 → true', () => {
    assert.strictEqual(looksLikeModelPath('model.gguf'), true);
    assert.strictEqual(looksLikeModelPath('weights.safetensors'), true);
    assert.strictEqual(looksLikeModelPath('  "model.gguf"  '), true, '去首尾引号后判定');
  });

  test('Ollama blob 文件名（sha256- 32+ 位十六进制）→ true', () => {
    assert.strictEqual(looksLikeModelPath(`sha256-${'a'.repeat(40)}`), true);
    assert.strictEqual(looksLikeModelPath('blobs/sha256-' + 'f'.repeat(32)), true);
  });

  test('带模型关键词的压缩包 → true；无关键词普通 zip → false（无 fs 时）', () => {
    assert.strictEqual(looksLikeModelPath('qwen-model.zip'), true);
    assert.strictEqual(looksLikeModelPath('llama-weights.tar.gz'), true);
    assert.strictEqual(looksLikeModelPath('random-archive.zip'), false);
  });

  test('空串 / 无关文件 → false', () => {
    assert.strictEqual(looksLikeModelPath(''), false);
    assert.strictEqual(looksLikeModelPath('notes.txt'), false);
  });
});

describe('modelImportService detectModelFormat（临时目录）', () => {
  let tmp;
  test.before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'model-import-detect-'));
  });
  test.after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('路径不存在 → 抛 Path not found', () => {
    assert.throws(() => detectModelFormat(path.join(tmp, 'nope')), /Path not found/);
  });

  test('.gguf 文件 → kind gguf', () => {
    const f = path.join(tmp, 'a.gguf');
    fs.writeFileSync(f, 'GGUF');
    const r = detectModelFormat(f);
    assert.strictEqual(r.kind, 'gguf');
    assert.deepStrictEqual(r.files, [f]);
  });

  test('.safetensors 文件 → kind adapter', () => {
    const f = path.join(tmp, 'w.safetensors');
    fs.writeFileSync(f, 'x');
    assert.strictEqual(detectModelFormat(f).kind, 'adapter');
  });

  test('.zip 文件 → kind archive', () => {
    const f = path.join(tmp, 'm.zip');
    fs.writeFileSync(f, 'x');
    assert.strictEqual(detectModelFormat(f).kind, 'archive');
  });

  test('含 .gguf 的目录 → kind gguf，absPath 指向最大 gguf', () => {
    const dir = path.join(tmp, 'ggufdir');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'main.gguf'), 'G'.repeat(100));
    const r = detectModelFormat(dir);
    assert.strictEqual(r.kind, 'gguf');
    assert.strictEqual(path.basename(r.absPath), 'main.gguf');
  });

  test('空目录 → 抛「不含可识别模型文件」', () => {
    const dir = path.join(tmp, 'empty');
    fs.mkdirSync(dir, { recursive: true });
    assert.throws(() => detectModelFormat(dir), /does not contain recognized model files/i);
  });
});

describe('modelImportService scanForModelFiles 递归扫描', () => {
  let tmp;
  test.before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'model-import-scan-'));
  });
  test.after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('gguf/safetensors/config.json 归类 + 嵌套目录', () => {
    const dir = path.join(tmp, 'tree');
    fs.mkdirSync(path.join(dir, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'a.gguf'), 'G');
    fs.writeFileSync(path.join(dir, 'nested', 'b.gguf'), 'G');
    fs.writeFileSync(path.join(dir, 'w.safetensors'), 'S');
    fs.writeFileSync(path.join(dir, 'config.json'), '{}');

    const r = scanForModelFiles(dir, 3);
    assert.strictEqual(r.hasConfig, true);
    assert.strictEqual(r.ggufFiles.length, 2, '根 + 嵌套各 1 个 gguf');
    assert.strictEqual(r.safetensorsFiles.length, 1);
    assert.ok(r.ggufFiles.every((f) => f.toLowerCase().endsWith('.gguf')));
  });

  test('空目录 → 全空 + hasConfig false', () => {
    const dir = path.join(tmp, 'empty2');
    fs.mkdirSync(dir, { recursive: true });
    const r = scanForModelFiles(dir, 3);
    assert.deepStrictEqual(r, { ggufFiles: [], safetensorsFiles: [], hasConfig: false });
  });
});
