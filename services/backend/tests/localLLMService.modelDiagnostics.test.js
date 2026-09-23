'use strict';

/**
 * localLLMService.modelDiagnostics.test.js — locks the pure diagnosis logic of
 * the local-LLM service (no spawned processes, no network):
 *   - classifyModelLoadError: the GGUF/engine architecture-incompatibility
 *     family is recognized (hyperparameters / rope dimension_sections /
 *     unknown architecture / failed-to-load-model), everything else → null
 *   - diagnoseOllamaModel: offline / exact-tag / same-family / no-match verdicts
 *     (mirrors isOllamaAvailable's prefix rule + the exact-tag refinement)
 *   - getStatus(): stable key/shape contract
 *   - canListenLoopback(): honest boolean probe result (cached + force refresh)
 * Runs with node:test (zero framework deps); whoever changes the diagnosis
 * contract goes red first.
 */
const test = require('node:test');
const assert = require('node:assert');

const {
  classifyModelLoadError,
  diagnoseOllamaModel,
  getStatus,
  canListenLoopback,
} = require('../src/services/localLLMService');

const INCOMPAT_CODE = 'LOCAL_MODEL_INCOMPATIBLE';

test('classifyModelLoadError: 空输入（null/undefined/空串）→ null（不认领无关错误）', () => {
  assert.strictEqual(classifyModelLoadError(null), null);
  assert.strictEqual(classifyModelLoadError(undefined), null);
  assert.strictEqual(classifyModelLoadError(''), null);
});

for (const msg of [
  'qwen35.rope.dimension_sections has wrong array length; expected 4, got 3',
  'error loading model hyperparameters',
  'unknown model architecture: qwen35',
  'Unsupported model architecture "qwen35"',
  'llama_model_load: ... error loading gguf',
  'Failed to load model from file',
]) {
  test(`classifyModelLoadError: 架构不兼容特征 → LOCAL_MODEL_INCOMPATIBLE（${msg.slice(0, 28)}…）`, () => {
    const diag = classifyModelLoadError(msg);
    assert.ok(diag, '应识别为不兼容');
    assert.strictEqual(diag.code, INCOMPAT_CODE);
    assert.ok(diag.cause.length > 0, 'cause 必须可解释');
    assert.strictEqual(diag.solutions.length, 3, '必须给 3 条可执行方案');
  });
}

test('classifyModelLoadError: 无关错误（ECONNREFUSED / 超时 / 普通 IO 错误）→ null', () => {
  assert.strictEqual(classifyModelLoadError('ECONNREFUSED 127.0.0.1:8767'), null);
  assert.strictEqual(classifyModelLoadError('request timeout after 300s'), null);
  assert.strictEqual(classifyModelLoadError('ENOENT: no such file'), null);
});

test('diagnoseOllamaModel: Ollama 离线 → warn + 启动/pull 建议（无 matchedTag）', () => {
  const v = diagnoseOllamaModel({ online: false, tags: [], configuredModel: 'qwen3:4b' });
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.level, 'warn');
  assert.strictEqual(v.matchedTag, null);
  assert.strictEqual(v.suggestion, null);
  assert.match(v.detail, /ollama serve/i, '应提示启动 Ollama 服务');
  assert.match(v.detail, /ollama pull qwen3:4b/i, '应提示拉取目标模型');
});

test('diagnoseOllamaModel: 精确 tag 已安装 → ok + info + matchedTag', () => {
  const v = diagnoseOllamaModel({
    online: true,
    tags: ['qwen3:latest', 'qwen3:4b'],
    configuredModel: 'qwen3:4b',
  });
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.level, 'info');
  assert.strictEqual(v.matchedTag, 'qwen3:4b');
  assert.strictEqual(v.suggestion, null);
});

test('diagnoseOllamaModel: 仅同系 tag → warn + OLLAMA_MODEL=<已装tag> 自动纠正建议', () => {
  const v = diagnoseOllamaModel({
    online: true,
    tags: ['qwen3:latest', 'llama3:8b'],
    configuredModel: 'qwen3:4b',
  });
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.level, 'warn');
  assert.strictEqual(v.matchedTag, 'qwen3:latest');
  assert.strictEqual(v.suggestion, 'OLLAMA_MODEL=qwen3:latest');
  assert.match(v.detail, /OLLAMA_MODEL=qwen3:latest/);
});

test('diagnoseOllamaModel: 在线但无匹配模型 → warn + 展示已装列表（截断到 8 条）', () => {
  const tags = ['a:1', 'b:2', 'c:3', 'd:4', 'e:5', 'f:6', 'g:7', 'h:8', 'i:9', 'j:10'];
  const v = diagnoseOllamaModel({ online: true, tags, configuredModel: 'qwen3:4b' });
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.matchedTag, null);
  assert.strictEqual(v.suggestion, 'OLLAMA_MODEL=<已安装的tag>');
  assert.match(v.detail, /a:1.*h:8/s, '应展示前 8 条已装模型');
  assert.doesNotMatch(v.detail, /i:9/, '超过 8 条应被截断');
});

test('diagnoseOllamaModel: 在线但无任何模型 → suggestion 为 null + 明确空目录提示', () => {
  const v = diagnoseOllamaModel({ online: true, tags: [], configuredModel: 'qwen3:4b' });
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.suggestion, null);
  assert.match(v.detail, /当前无已安装模型/);
});

test('getStatus(): 契约键与类型稳定（不锁机器状态值，只锁结构）', () => {
  const s = getStatus();
  assert.strictEqual(typeof s.modelPath, 'string');
  assert.strictEqual(typeof s.available, 'boolean');
  assert.strictEqual(typeof s.loaded, 'boolean');
  assert.strictEqual(typeof s.inferenceServerPort, 'number');
  assert.strictEqual(typeof s.runnerPort, 'number');
  assert.strictEqual(typeof s.runnerReady, 'boolean');
  assert.strictEqual(typeof s.modelIncompatible, 'boolean');
  for (const key of [
    'backend',
    'lastError',
    'modelLoadDiagnosis',
    'loopbackListenAvailable',
    'loopbackListenError',
    'modelDiscoveryReason',
    'modelArtifactKind',
    'modelArtifactPath',
    'modelImportHint',
    'modelImportCommand',
    'discoveryError',
    'runtimeArtifact',
    'importableArtifact',
    'nonRuntimeArtifact',
  ]) {
    assert.ok(key in s, `缺少契约键 ${key}`);
  }
  assert.ok(Array.isArray(s.modelScanRoots));
});

test('canListenLoopback(): 返回布尔；forceRefresh 重新探测且结果一致（标准开发机 loopback 可监听）', async () => {
  const first = await canListenLoopback();
  assert.strictEqual(typeof first, 'boolean');
  assert.strictEqual(first, true, '标准开发机 127.0.0.1 临时端口监听应可用');
  const refreshed = await canListenLoopback(true);
  assert.strictEqual(refreshed, true, '强制重探结果应与首次一致');
  const cached = await canListenLoopback();
  assert.strictEqual(cached, true, 'TTL 内应命中缓存而非再探测');
});
