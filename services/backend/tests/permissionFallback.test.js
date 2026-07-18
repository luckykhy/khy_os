'use strict';

const test = require('node:test');
const assert = require('node:assert');

const SUT = '../src/services/permissionFallback';

function fresh() {
  delete require.cache[require.resolve(SUT)];
  return require(SUT);
}

function withEnv(overrides, fn) {
  const saved = {};
  for (const k of Object.keys(overrides)) { saved[k] = process.env[k]; }
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try { return fn(); } finally {
    for (const k of Object.keys(overrides)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
}

test('paramSignature: 确定性,键排序无关,跳过 _ 内部键,fail-soft', () => {
  const m = fresh();
  assert.equal(m.paramSignature({ b: 1, a: 2 }), m.paramSignature({ a: 2, b: 1 }));
  assert.equal(m.paramSignature({ a: 1, _internal: 9 }), m.paramSignature({ a: 1 }));
  assert.equal(m.paramSignature(null), '');
  assert.equal(m.paramSignature('x'), '');
});

test('denyKey: 工具名 + 参数签名稳定;不同参数不同 key', () => {
  const m = fresh();
  const k1 = m.denyKey('writeFile', { path: '/a' });
  const k2 = m.denyKey('writeFile', { path: '/a' });
  const k3 = m.denyKey('writeFile', { path: '/b' });
  assert.equal(k1, k2);
  assert.notEqual(k1, k3);
});

test('evaluateDeny: 首次拒绝 → 不停(尝试替代);第二个不同调用 → 停', () => {
  const m = fresh();
  const k1 = m.denyKey('bash', { command: 'rm x' });
  const first = m.evaluateDeny([], k1);
  assert.equal(first.stop, false);
  assert.equal(first.isRepeat, false);

  const k2 = m.denyKey('writeFile', { path: '/y' });
  const second = m.evaluateDeny([k1], k2);
  assert.equal(second.stop, true, '超出尝试上限 → 停止');
});

test('evaluateDeny: 重复同一被拒调用 → 立即停止', () => {
  const m = fresh();
  const k1 = m.denyKey('bash', { command: 'rm x' });
  const repeat = m.evaluateDeny([k1], k1);
  assert.equal(repeat.isRepeat, true);
  assert.equal(repeat.stop, true);
});

test('evaluateDeny: 门控关 → 总是 stop(字节回退既有「拒绝即停」)', () => {
  withEnv({ KHY_PERMISSION_FALLBACK: 'off' }, () => {
    const m = fresh();
    assert.equal(m.evaluateDeny([], 'k').stop, true);
  });
});

test('describeRequiredPermission: 按工具名归类到具体权限', () => {
  const m = fresh();
  assert.match(m.describeRequiredPermission('writeFile').permission, /文件写入/);
  assert.match(m.describeRequiredPermission('deleteFile').permission, /文件删除/);
  assert.match(m.describeRequiredPermission('shellCommand').permission, /命令执行/);
  assert.match(m.describeRequiredPermission('httpRequest').permission, /网络访问/);
  assert.match(m.describeRequiredPermission('desktopControl').permission, /桌面控制/);
  assert.match(m.describeRequiredPermission('databaseQuery').permission, /数据库/);
  assert.match(m.describeRequiredPermission('gitCommit').permission, /版本库/);
});

test('describeRequiredPermission: 网关/钩子/计划模式标记优先于工具名', () => {
  const m = fresh();
  assert.match(m.describeRequiredPermission('writeFile', { _gatewayBlocked: true }).permission, /高危系统调用/);
  assert.match(m.describeRequiredPermission('writeFile', { _hookBlocked: true }).permission, /钩子/);
  assert.match(m.describeRequiredPermission('writeFile', { _planModeBlocked: true }).permission, /计划模式/);
  assert.match(m.describeRequiredPermission('writeFile', { _capabilityFloorBlocked: true }).permission, /能力/);
});

test('describeRequiredPermission: 未知工具 → 泛化授权,绝不抛', () => {
  const m = fresh();
  const r = m.describeRequiredPermission('someUnknownTool42');
  assert.ok(r.permission && r.howToGrant);
  assert.match(r.permission, /someUnknownTool42|授权/);
});

test('buildDenyGuidance: 含「不要重复/换其它方式/诚实告知所需权限」三要点', () => {
  const m = fresh();
  const g = m.buildDenyGuidance('writeFile');
  assert.match(g, /不要重复/);
  assert.match(g, /其它方式/);
  assert.match(g, /文件写入权限/);
  assert.match(g, /如实告知/);
});

test('buildDenyGuidance: 门控关 → 空串', () => {
  withEnv({ KHY_PERMISSION_FALLBACK: 'off' }, () => {
    assert.equal(fresh().buildDenyGuidance('writeFile'), '');
  });
});

test('buildExhaustedMessage: 列出所需权限,按权限去重', () => {
  const m = fresh();
  const msg = m.buildExhaustedMessage([
    { tool: 'writeFile' },
    { tool: 'editFile' }, // 同属文件写入 → 去重
    { tool: 'httpRequest' },
  ]);
  assert.match(msg, /必须拥有/);
  assert.match(msg, /文件写入权限/);
  assert.match(msg, /网络访问权限/);
  // 文件写入只应出现一次(去重)
  const count = (msg.match(/文件写入权限/g) || []).length;
  assert.equal(count, 1);
});

test('buildExhaustedMessage: 空清单 → 仍给可读兜底,绝不抛', () => {
  const m = fresh();
  const msg = m.buildExhaustedMessage([]);
  assert.ok(typeof msg === 'string' && msg.length > 0);
  assert.equal(m.buildExhaustedMessage(null).length > 0, true);
});

test('_enabled: 默认开,仅 0/false/off/no 关', () => {
  withEnv({ KHY_PERMISSION_FALLBACK: undefined }, () => assert.equal(fresh()._enabled(), true));
  for (const v of ['0', 'false', 'off', 'no']) {
    withEnv({ KHY_PERMISSION_FALLBACK: v }, () => assert.equal(fresh()._enabled(), false));
  }
});

test('端到端两轮:首拒注入引导继续 → 替代再拒 → 诚实告知(模拟 _handleDenyFallback 用法)', () => {
  const m = fresh();
  const state = { keys: [], denied: [] };
  const handle = (tool, params, resultObj) => {
    if (!m._enabled()) return { stop: true, message: null };
    const key = m.denyKey(tool, params);
    const decision = m.evaluateDeny(state.keys, key);
    state.denied.push({ tool, denyResult: resultObj });
    if (decision.stop) return { stop: true, message: m.buildExhaustedMessage(state.denied) };
    state.keys.push(key);
    const g = m.buildDenyGuidance(tool, resultObj);
    if (g) resultObj.hint = g;
    return { stop: false, message: null };
  };

  const r1 = { denied: true };
  const o1 = handle('writeFile', { path: '/a' }, r1);
  assert.equal(o1.stop, false, '首次拒绝应尝试替代');
  assert.match(r1.hint, /其它方式/, '引导注入到 hint');

  const r2 = { denied: true };
  const o2 = handle('httpRequest', { url: 'http://x' }, r2);
  assert.equal(o2.stop, true, '替代又被拒 → 停止');
  assert.match(o2.message, /文件写入权限/);
  assert.match(o2.message, /网络访问权限/);
});
