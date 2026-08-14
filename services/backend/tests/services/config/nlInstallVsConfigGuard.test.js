'use strict';

/**
 * nlInstallVsConfigGuard — 「配置 khy vs 安装第三方工具」歧义护栏(单一真源)的确定性测试。
 *
 * 锁定:① 门控默认开 / 关即字节回退(resolve 恒 null);② 旗舰歧义场景正确识别
 * (粘贴含 `npm install -g opencode-ai` 的配置文档 + 「参照这个方法配置」);③ 零假阳性
 * (纯安装请求、纯配置无安装命令、寒暄一律不误触);④ 指令含「别装第三方 / 映射到 khy /
 * 歧义先澄清」三要点;⑤ 任意坏输入绝不抛。
 */

const test = require('node:test');
const assert = require('node:assert');

const r = require('../../../src/services/config/nlInstallVsConfigGuard');

const ON = { KHY_INSTALL_CONFIG_GUARD: 'true' };
const OFF = { KHY_INSTALL_CONFIG_GUARD: 'off' };

// 旗舰场景:用户粘贴的 OpenCode 安装+配置文档节选 + 配置意图。
const OPENCODE_DOC = [
  '参照这个配置方法配置 key:',
  'npm install -g opencode-ai',
  'opencode -v',
  '在 opencode.json 写入 baseURL https://token.sensenova.cn/v1 与 apiKey $SENSENOVA_API_KEY',
  '模型 sensenova-6.7-flash-lite',
].join('\n');

// ── 门控 ─────────────────────────────────────────────────────────────────────
test('isEnabled: 默认开;仅 {0,false,off,no} 关', () => {
  assert.strictEqual(r.isEnabled({}), true);
  assert.strictEqual(r.isEnabled({ KHY_INSTALL_CONFIG_GUARD: undefined }), true);
  assert.strictEqual(r.isEnabled({ KHY_INSTALL_CONFIG_GUARD: 'true' }), true);
  assert.strictEqual(r.isEnabled({ KHY_INSTALL_CONFIG_GUARD: '1' }), true);
  for (const v of ['0', 'false', 'off', 'no', 'OFF', 'No']) {
    assert.strictEqual(r.isEnabled({ KHY_INSTALL_CONFIG_GUARD: v }), false, `应为关:${v}`);
  }
});

test('门控关 → resolve 恒 null(字节回退到不注入)', () => {
  assert.strictEqual(r.resolve(OPENCODE_DOC, OFF), null);
});

// ── 旗舰歧义场景命中 ──────────────────────────────────────────────────────────
test('粘贴含 npm install 的配置文档 + 「参照…配置」→ 命中,返回 directive', () => {
  const out = r.resolve(OPENCODE_DOC, ON);
  assert.ok(out && typeof out.directive === 'string', '应命中并返回 directive');
  assert.ok(out.directive.length > 0);
});

test('directive 含三要点:别装第三方 / 映射到 khy / 歧义先澄清', () => {
  const out = r.resolve(OPENCODE_DOC, ON);
  const d = out.directive;
  assert.ok(/不要执行.*安装命令|绝不执行.*安装/.test(d), '应含「别执行安装命令」');
  assert.ok(/SENSENOVA_API_KEY/.test(d), '应指向 khy 环境变量映射');
  assert.ok(/khy gateway model/.test(d), '应指向 khy 交互配置命令');
  assert.ok(/澄清/.test(d), '应含「歧义先澄清」');
});

test('英文安装命令 + follow this + config 也命中', () => {
  const en = 'Follow this to configure the provider:\npip install opencode-ai\nset apiKey and baseURL';
  const out = r.resolve(en, ON);
  assert.ok(out && out.directive, '英文场景应命中');
});

test('curl | sh 一键装 + 配置语言也命中', () => {
  const s = '参照这个配置方法:\ncurl -fsSL https://example.com/install.sh | sh\n然后设置 apikey';
  const out = r.resolve(s, ON);
  assert.ok(out && out.directive, 'curl|sh 场景应命中');
});

// ── 零假阳性 ─────────────────────────────────────────────────────────────────
test('纯安装请求(无配置/参照语言)→ 不误触', () => {
  assert.strictEqual(r.resolve('帮我安装 opencode,npm install -g opencode-ai', ON), null);
  assert.strictEqual(r.resolve('npm install -g opencode-ai', ON), null);
});

test('纯配置无安装命令 → 不误触(无歧义)', () => {
  assert.strictEqual(r.resolve('配置一下日日新的 api key', ON), null);
  assert.strictEqual(r.resolve('参照官方文档设置 baseURL 和模型', ON), null);
});

test('寒暄 / 无关请求 → 不误触', () => {
  assert.strictEqual(r.resolve('你好,今天天气不错', ON), null);
  assert.strictEqual(r.resolve('帮我写个快速排序', ON), null);
  assert.strictEqual(r.resolve('', ON), null);
});

// ── fail-soft / 边界 ─────────────────────────────────────────────────────────
test('坏输入(null/number/object/超长)绝不抛,返回 null 或不抛', () => {
  assert.strictEqual(r.resolve(null, ON), null);
  assert.strictEqual(r.resolve(undefined, ON), null);
  assert.strictEqual(r.resolve(12345, ON), null);
  assert.strictEqual(r.resolve({}, ON), null);
  // 超长(>4000)→ null,不抛。
  const huge = 'npm install -g x 参照配置 '.repeat(400);
  assert.strictEqual(r.resolve(huge, ON), null);
});

test('判据正交:安装命令信号 与 配置/参照语言 各自单独不足以成立', () => {
  // 只有安装信号
  assert.ok(r._INSTALL_CMD_RE.test('npm install -g opencode-ai'));
  assert.ok(!r._CONFIG_REF_RE.test('npm install -g opencode-ai'));
  // 只有配置语言
  assert.ok(r._CONFIG_REF_RE.test('参照这个方法配置'));
  assert.ok(!r._INSTALL_CMD_RE.test('参照这个方法配置'));
});
