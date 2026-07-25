'use strict';

/**
 * ensureProxyCoreEnv.test.js — 「装完即用」KHY_PROXY_CORE 自动播种的行为契约。
 *
 * 覆盖的真实缺口(用户诉求 2026-07-11「pip/npm 安装后环境变量自动配置」):选中 raw 协议节点时
 * 撞「请设 KHY_PROXY_CORE=1」那道门 → 本模块首启把它一次性播种进升级安全 overlay(~/.khy/.env)。
 *
 * 全离线:所有 IO 经 _deps 注入(fake homedir/fs/writeEnvMap),不真读盘/写盘。核心不变量:
 *   - 尊重用户显式意图(真实 env / 规范 .env / overlay 已设过含 =0 → 绝不覆盖);
 *   - 幂等(播种一次后读到「已设」即跳过,不重复写);
 *   - 三处都没有 → 首次播种 =1;
 *   - meta 门 KHY_PROXY_CORE_AUTOSEED(default-on)关 → 不读盘不写盘,逐字节回退;
 *   - fail-soft:任何失败绝不抛。
 */

const test = require('node:test');
const assert = require('node:assert');

const mod = require('../../src/bootstrap/ensureProxyCoreEnv');
const { ensureProxyCoreEnv, isAutoseedEnabled, FLAG, META_FLAG, _setDeps } = mod;

// 构造一个内存 fs + 写记录器,喂给 _deps。files 是 { path: content } 映射。
function makeHarness(initialFiles = {}) {
  const files = { ...initialFiles };
  const writes = [];
  const fakeFs = {
    readFileSync(p) {
      if (Object.prototype.hasOwnProperty.call(files, p)) return files[p];
      const err = new Error(`ENOENT: no such file '${p}'`);
      err.code = 'ENOENT';
      throw err;
    },
  };
  const restore = _setDeps({
    fs: fakeFs,
    homedir: () => '/home/tester',
    writeEnvMap: (envMap, options) => {
      writes.push({ envMap, options });
      // 模拟真实 writeEnvMap:把内容合进 overlay 文件(幂等 KEY=VALUE 行)。
      const p = options && options.envPath;
      if (p) {
        let content = files[p] || '';
        for (const [k, v] of Object.entries(envMap)) {
          if (new RegExp(`^\\s*${k}\\s*=`, 'm').test(content)) {
            content = content.replace(new RegExp(`^\\s*${k}\\s*=.*$`, 'm'), `${k}=${v}`);
          } else {
            content += (content && !content.endsWith('\n') ? '\n' : '') + `${k}=${v}\n`;
          }
        }
        files[p] = content;
      }
    },
  });
  return { files, writes, restore };
}

const OVERLAY = '/home/tester/.khy/.env';

// ── meta 门控(CANON:0/false/off/no 关,其余开;default-on)────────────────────
test('isAutoseedEnabled: default-on when unset', () => {
  assert.strictEqual(isAutoseedEnabled({}), true);
});

test('isAutoseedEnabled: CANON off words disable', () => {
  for (const w of ['0', 'false', 'off', 'no', 'FALSE', ' Off ']) {
    assert.strictEqual(isAutoseedEnabled({ [META_FLAG]: w }), false, `should disable on '${w}'`);
  }
});

test('isAutoseedEnabled: truthy/other values keep enabled', () => {
  for (const w of ['1', 'true', 'on', 'yes', 'whatever']) {
    assert.strictEqual(isAutoseedEnabled({ [META_FLAG]: w }), true, `should stay on for '${w}'`);
  }
});

// ── meta 门关 → 逐字节回退(不读盘不写盘)────────────────────────────────────
test('gate off: skips without any IO (byte-revert)', () => {
  const h = makeHarness();
  try {
    const r = ensureProxyCoreEnv({ env: { [META_FLAG]: '0' } });
    assert.strictEqual(r.action, 'skipped');
    assert.strictEqual(r.reason, 'autoseed-disabled');
    assert.strictEqual(h.writes.length, 0, 'must not write when gate off');
  } finally {
    h.restore();
  }
});

// ── 首次播种:三处都没有 → 写 =1 到 overlay ─────────────────────────────────
test('first-time: seeds =1 into upgrade-safe overlay', () => {
  const h = makeHarness();
  try {
    const env = {};
    const r = ensureProxyCoreEnv({ env });
    assert.strictEqual(r.action, 'seeded');
    assert.strictEqual(r.reason, 'first-time');
    assert.strictEqual(r.path, OVERLAY);
    assert.strictEqual(h.writes.length, 1, 'exactly one write');
    assert.deepStrictEqual(h.writes[0].envMap, { [FLAG]: '1' });
    assert.strictEqual(h.writes[0].options.envPath, OVERLAY);
    // 本进程立即生效:注入 env 被补设。
    assert.strictEqual(env[FLAG], '1');
    // overlay 文件确实含该行。
    assert.match(h.files[OVERLAY], new RegExp(`^${FLAG}=1$`, 'm'));
  } finally {
    h.restore();
  }
});

// ── 幂等:第二次调用读到 overlay 已设 → 不重复写 ────────────────────────────
test('idempotent: second run skips (already-seeded)', () => {
  const h = makeHarness();
  try {
    ensureProxyCoreEnv({ env: {} });         // 首次播种
    const before = h.writes.length;
    const r = ensureProxyCoreEnv({ env: {} }); // 第二次(overlay 已有)
    assert.strictEqual(r.action, 'skipped');
    assert.strictEqual(r.reason, 'already-seeded');
    assert.strictEqual(h.writes.length, before, 'no additional write on second run');
  } finally {
    h.restore();
  }
});

// ── 尊重用户:真实 shell env 显式设过(含 =0)→ 不动 ─────────────────────────
test('respects explicit process-env value (=0 kept off)', () => {
  const h = makeHarness();
  try {
    const r = ensureProxyCoreEnv({ env: { [FLAG]: '0' } });
    assert.strictEqual(r.action, 'skipped');
    assert.strictEqual(r.reason, 'explicit-in-process-env');
    assert.strictEqual(h.writes.length, 0, 'must not seed when user set it explicitly');
  } finally {
    h.restore();
  }
});

test('respects explicit process-env value (=1 not re-seeded)', () => {
  const h = makeHarness();
  try {
    const r = ensureProxyCoreEnv({ env: { [FLAG]: '1' } });
    assert.strictEqual(r.action, 'skipped');
    assert.strictEqual(r.reason, 'explicit-in-process-env');
    assert.strictEqual(h.writes.length, 0);
  } finally {
    h.restore();
  }
});

// 空串视为未显式(不算用户设置),仍应播种。
test('empty-string process-env value is not treated as explicit', () => {
  const h = makeHarness();
  try {
    const r = ensureProxyCoreEnv({ env: { [FLAG]: '' } });
    assert.strictEqual(r.action, 'seeded');
    assert.strictEqual(r.reason, 'first-time');
  } finally {
    h.restore();
  }
});

// ── 尊重用户:规范 .env 显式设过 → 不动 ─────────────────────────────────────
test('respects explicit value in canonical .env', () => {
  const CANON = '/etc/khy/.env';
  const h = makeHarness({ [CANON]: 'FOO=bar\nKHY_PROXY_CORE=0\n' });
  try {
    const r = ensureProxyCoreEnv({ env: { KHY_ENV_FILE: CANON }, canonicalEnvPath: CANON });
    assert.strictEqual(r.action, 'skipped');
    assert.strictEqual(r.reason, 'explicit-in-canonical-env');
    assert.strictEqual(h.writes.length, 0);
  } finally {
    h.restore();
  }
});

// ── 尊重用户:overlay 里手写过(含 =0)→ 幂等不动 ────────────────────────────
test('respects pre-existing overlay value (already-seeded, =0 kept)', () => {
  const h = makeHarness({ [OVERLAY]: 'KHY_PROXY_CORE=0\n' });
  try {
    const r = ensureProxyCoreEnv({ env: {} });
    assert.strictEqual(r.action, 'skipped');
    assert.strictEqual(r.reason, 'already-seeded');
    assert.strictEqual(h.writes.length, 0, 'user disabled it in overlay → never re-seed');
    // 值保持 =0。
    assert.match(h.files[OVERLAY], /^KHY_PROXY_CORE=0$/m);
  } finally {
    h.restore();
  }
});

// ── fail-soft:writeEnvMap 抛也绝不抛出 ─────────────────────────────────────
test('fail-soft: writer throwing does not propagate', () => {
  const restore = _setDeps({
    fs: { readFileSync() { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } },
    homedir: () => '/home/tester',
    writeEnvMap: () => { throw new Error('disk full'); },
  });
  try {
    let r;
    assert.doesNotThrow(() => { r = ensureProxyCoreEnv({ env: {} }); });
    assert.strictEqual(r.action, 'skipped');
    assert.strictEqual(r.reason, 'error');
  } finally {
    restore();
  }
});

// ── log 回调在播种时被调用一次(透明可观测)──────────────────────────────────
test('log callback fires exactly once on seed', () => {
  const h = makeHarness();
  const msgs = [];
  try {
    ensureProxyCoreEnv({ env: {}, log: (m) => msgs.push(m) });
    assert.strictEqual(msgs.length, 1);
    assert.match(msgs[0], new RegExp(FLAG));
  } finally {
    h.restore();
  }
});
