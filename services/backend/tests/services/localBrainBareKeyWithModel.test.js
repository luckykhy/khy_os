'use strict';

/**
 * localBrainBareKeyWithModel — 回归:模型在线时,用户在对话里随口粘一把裸 API Key,仍必须被
 * 确定性入池(→ apiKeyPool.addKey 落盘),而不是被「有模型 → 跳过 cooperative handler」的规则
 * 短路、只能寄望弱模型自觉调用 configureModelProvider 工具。
 *
 * 缺陷背景:detectDeterministic 里 `if (modelAvail && handler.cooperative) continue;` 会在任一
 * adapter available 时跳过所有 cooperative handler,连高精度的 key_update(裸 key)也被跳过。
 * 修复:key_update 标 alwaysDeterministic:true → 即便有模型也介入。
 *
 * 隔离:KHY_DATA_HOME 指向临时领地;通过在 aiGateway 单例上装一个「可用 adapter」把
 * isModelAvailable() 置真,真实还原「有模型」场景。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-barekey-'));
process.env.KHY_DATA_HOME = TMP;
process.env.KHY_ENV_FILE = path.join(TMP, '.env');
process.env.KHY_ENV_SYNC_ROOT = 'false';
delete process.env.KHY_KEY_UPDATE_FLOW; // 默认开
delete process.env.KHY_NL_PROVIDER;     // 默认开

const test = require('node:test');
const assert = require('node:assert/strict');

const lb = require('../../src/services/localBrainService');
const gateway = require('../../src/services/gateway/aiGateway');
const pool = require('../../src/services/apiKeyPool');

// 让 isModelAvailable() 返回 true:模拟一个已初始化、含可用 adapter 的 gateway。
function withModelOnline(fn) {
  const savedInit = gateway._initialized;
  const savedAdapters = gateway._adapters;
  gateway._initialized = true;
  gateway._adapters = [{ enabled: true, available: true, name: 'fake' }];
  try { return fn(); }
  finally { gateway._initialized = savedInit; gateway._adapters = savedAdapters; }
}

test('sanity: fake adapter makes isModelAvailable() true', () => {
  withModelOnline(() => {
    assert.equal(lb.isModelAvailable(), true, 'model must appear online for this regression');
  });
});

test('模型在线时,裸 sk- key 仍确定性入池(不被 cooperative-skip 吞掉)', () => {
  withModelOnline(() => {
    const bareKey = 'sk-baremodelonline123456';
    // 带厂商提示词的裸 key(无动词/无完整配置句):走 key_update 分支。
    const plan = lb.detectDeterministic('glm ' + bareKey, { cwd: TMP });
    assert.ok(plan, '有模型时裸 key 也应产出确定性计划(alwaysDeterministic)');
    assert.equal(plan.type, 'key_update', '应命中 key_update handler');

    const result = lb.executeDeterministic(plan, { cwd: TMP });
    assert.ok(result && result.success, '写入应成功: ' + JSON.stringify(result));

    // 落库实证:key 进了统一密钥池(glm pool)。
    const status = pool.getPoolStatus('glm') || [];
    assert.ok(status.length > 0, 'glm 池应至少有一把 key');
    assert.ok(pool.hasAvailableKeys('glm'), '真 key 入池 → glm 可用');
  });
});

test('模型在线时,非 key 的普通配置意图仍让路给模型(未被本改扩大拦截面)', () => {
  withModelOnline(() => {
    // 一句普通闲聊,不含裸 key,也不该被任何 cooperative handler 拦截。
    const plan = lb.detectDeterministic('你好,今天怎么样', { cwd: TMP });
    assert.equal(plan, null, '闲聊不应被确定性拦截(有模型 → 让路)');
  });
});
