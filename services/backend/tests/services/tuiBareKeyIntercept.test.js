'use strict';

/**
 * tuiBareKeyIntercept — 回归:ink TUI 的普通轮此前**完全没有**确定性快速任务拦截,
 * 用户在对话里直接粘一把裸 API key 会径直进模型(模型只会「分析这是什么 token」)。
 *
 * useQueryBridge._runSubmit 的主 try 顶部现补齐了与经典 REPL 对齐的拦截:调
 * detectDeterministic → executeDeterministic → formatDeterministicResult,只在 key_update
 * 命中时确定性入池并直接提交回复(无需模型)。本测覆盖 TUI 拦截**所依赖的那条链**的契约:
 *
 *   1) 有模型在线时,裸 glm key(hex32.secret 形态)仍产出 key_update 计划(alwaysDeterministic);
 *   2) 执行写入 glm 池且**大小写保真**(GLM secret 段大小写敏感,曾被 _norm 小写化污染 → 404);
 *   3) 普通对话/图片描述提示词**不**被拦截(零误报,即便本轮带图也只有裸 key 会被拦);
 *   4) formatDeterministicResult 产出非空可读回复。
 *
 * 隔离:KHY_DATA_HOME 指向临时领地;在 aiGateway 单例上装一个可用 adapter → isModelAvailable() 真。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tui-barekey-'));
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

function withModelOnline(fn) {
  const savedInit = gateway._initialized;
  const savedAdapters = gateway._adapters;
  gateway._initialized = true;
  gateway._adapters = [{ enabled: true, available: true, name: 'fake' }];
  try { return fn(); }
  finally { gateway._initialized = savedInit; gateway._adapters = savedAdapters; }
}

// 假形态 key(绝不用真 key):hex32 + '.' + 混合大小写 secret 段。
const FAKE_GLM_KEY = '0123456789abcdef0123456789abcdef.FaKeSeCrEt123';

test('有模型在线:裸 glm key → key_update 计划(TUI 拦截的判定契约)', () => {
  withModelOnline(() => {
    const plan = lb.detectDeterministic(FAKE_GLM_KEY, { cwd: TMP });
    assert.ok(plan, '裸 key 应产出确定性计划');
    assert.equal(plan.type, 'key_update', '应命中 key_update(TUI 只在此 type 拦截)');
  });
});

test('执行入 glm 池且大小写保真(secret 段不被小写化)', () => {
  withModelOnline(() => {
    const plan = lb.detectDeterministic(FAKE_GLM_KEY, { cwd: TMP });
    const res = lb.executeDeterministic(plan, { cwd: TMP });
    assert.ok(res && res.success, '写入应成功: ' + JSON.stringify(res));
    assert.equal(res.poolKey, 'glm', '智谱 key 应落 glm 池');

    // 大小写保真实证:落库的 key 必须与原始逐字节一致(混合大小写不变)。
    // getPoolStatus 脱敏 → 用 listAvailableKeys 取完整 key 断言大小写。
    const avail = pool.listAvailableKeys('glm') || [];
    assert.ok(avail.length > 0, 'glm 池应至少一把可用 key');
    const stored = avail.map((e) => (e && e.key) || '').filter(Boolean);
    assert.ok(
      stored.some((k) => k === FAKE_GLM_KEY),
      '池中应存在与原始大小写完全一致的 key,而非被小写化的版本。实际: ' + JSON.stringify(stored),
    );
  });
});

test('formatDeterministicResult 产出非空可读回复', () => {
  withModelOnline(() => {
    const plan = lb.detectDeterministic(FAKE_GLM_KEY, { cwd: TMP });
    const res = lb.executeDeterministic(plan, { cwd: TMP });
    const reply = lb.formatDeterministicResult(res);
    assert.equal(typeof reply, 'string');
    assert.ok(reply.trim().length > 0, '回复不应为空');
  });
});

test('零误报:普通对话与图片描述提示词不被拦截', () => {
  withModelOnline(() => {
    const negatives = [
      '你好,帮我看看这张图片',
      '请先描述图片中的关键信息,再结合当前任务上下文推断我想完成的目标,并给出下一步可执行操作。',
      '什么是 token',
      '帮我写一个 Python 脚本',
    ];
    for (const txt of negatives) {
      const plan = lb.detectDeterministic(txt, { cwd: TMP });
      const isKeyUpdate = !!(plan && plan.type === 'key_update');
      assert.equal(isKeyUpdate, false, `不应被 key_update 拦截: "${txt}" → ${plan ? plan.type : 'null'}`);
    }
  });
});
