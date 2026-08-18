'use strict';

/**
 * credentialGenerator.resolveDefaultAdminEmail — 默认管理员邮箱单一事实来源。
 *
 * 背景:四条播种路径(seed.js / adminAutoInit / manageDbBootstrap / create-admin)
 * 曾各自硬编码 `admin@khy-quant.com`。用户名按 OS 用户解析(如 qiqiaoban),邮箱却恒为
 * admin@ → 历史遗留的 id=1 `admin` 账号早已占用该邮箱 → INSERT 撞 users.email 的 UNIQUE
 * 约束 → seed 每次崩 → `.khy_quant_seeded` 标记写不出来 → 每次启动都重走「首次启动」。
 * 本用例锁住「邮箱随用户名派生」这一契约。
 */

const test = require('node:test');
const assert = require('node:assert');

const credGen = require('../../src/services/credentialGenerator');

test('邮箱由用户名派生,而非硬编码 admin@', () => {
  assert.strictEqual(credGen.resolveDefaultAdminEmail('qiqiaoban'), 'qiqiaoban@khy-quant.com');
  assert.strictEqual(credGen.resolveDefaultAdminEmail('admin'), 'admin@khy-quant.com');
});

test('本地部分按 sanitizeUsername 归一(大小写/非法字符)', () => {
  assert.strictEqual(credGen.resolveDefaultAdminEmail('Qi Qiao.Ban'), 'qiqiaoban@khy-quant.com');
  assert.strictEqual(credGen.resolveDefaultAdminEmail('user_01-x'), 'user_01-x@khy-quant.com');
});

test('用户名全为非法字符 → 回退到 admin@,不产出空本地部分', () => {
  assert.strictEqual(credGen.resolveDefaultAdminEmail('中文用户'), 'admin@khy-quant.com');
  assert.strictEqual(credGen.resolveDefaultAdminEmail('!!!'), 'admin@khy-quant.com');
});

test('缺省入参 → 自行解析用户名(KHY_ADMIN_USERNAME 优先)', () => {
  const prev = process.env.KHY_ADMIN_USERNAME;
  process.env.KHY_ADMIN_USERNAME = 'ops-bot';
  try {
    assert.strictEqual(credGen.resolveDefaultAdminEmail(), 'ops-bot@khy-quant.com');
    assert.strictEqual(credGen.resolveDefaultAdminEmail(''), 'ops-bot@khy-quant.com');
  } finally {
    if (prev === undefined) delete process.env.KHY_ADMIN_USERNAME;
    else process.env.KHY_ADMIN_USERNAME = prev;
  }
});

test('派生结果与 resolveDefaultAdminUsername 一致(两条路径同源)', () => {
  const prev = process.env.KHY_ADMIN_USERNAME;
  process.env.KHY_ADMIN_USERNAME = 'seedsync';
  try {
    const username = credGen.resolveDefaultAdminUsername();
    assert.strictEqual(credGen.resolveDefaultAdminEmail(username), `${username}@khy-quant.com`);
  } finally {
    if (prev === undefined) delete process.env.KHY_ADMIN_USERNAME;
    else process.env.KHY_ADMIN_USERNAME = prev;
  }
});
