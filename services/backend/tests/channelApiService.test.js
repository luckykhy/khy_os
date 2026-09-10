'use strict';

// Force an isolated throwaway SQLite file BEFORE the shared models bind to the
// Sequelize singleton, so this test never touches the real khy-quant.db. A file
// (not ':memory:') is required because Sequelize pools connections and each
// in-memory connection would otherwise get its own empty database.
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const _dbFile = path.join(os.tmpdir(), `khy-channel-api-test-${process.pid}.sqlite`);
try {
  fs.unlinkSync(_dbFile);
} catch {
  /* fresh */
}
process.env.DB_TYPE = 'sqlite';
process.env.SQLITE_DB_PATH = _dbFile;
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const assert = require('node:assert');

// Spy BEFORE requiring the service: the service destructures
// { logToolExecution } from the module at import time, so the binding it keeps
// is whatever the export object points at at that moment.
const auditLogModule = require('../src/services/auditLog');
const auditSpy = jest.spyOn(auditLogModule, 'logToolExecution');

const { sequelize, ChannelApi } = require('@khy/shared/models');
const channelApiCrypto = require('../src/services/channelApiCrypto');
const channelApiService = require('../src/services/channelApiService');

const PLAINTEXT = 'sk-ant-api03-plaintext-key-1234567890';

beforeAll(async () => {
  await sequelize.sync();
});

afterAll(() => {
  auditSpy.mockRestore();
  try {
    fs.unlinkSync(_dbFile);
  } catch {
    /* ignore */
  }
});

it('crypto: v2 envelope roundtrip and wrong-secret failure', () => {
  const cipher = channelApiCrypto.encryptApiKey(PLAINTEXT, 'unit-secret');
  assert.notStrictEqual(cipher, PLAINTEXT, 'stored value must be ciphertext');
  // v2: v2:<wIv>:<wTag>:<wDek>:<iv>:<tag>:<ct>
  assert.strictEqual(
    channelApiCrypto.wrapVersion(cipher), 'v2',
    'new ciphertexts use the v2 envelope'
  );
  assert.strictEqual(cipher.split(':').length, 7, 'cipher is v2 + 6 base64 fields');
  assert.strictEqual(channelApiCrypto.decryptApiKey(cipher, 'unit-secret'), PLAINTEXT);
  assert.strictEqual(channelApiCrypto.decryptApiKey(cipher, 'other-secret'), '');
  assert.strictEqual(channelApiCrypto.decryptApiKey('not-a-cipher'), '');
  assert.strictEqual(channelApiCrypto.decryptApiKey(''), '');
  assert.strictEqual(channelApiCrypto.encryptApiKey(''), '');
  // 每条记录的 DEK 与 IV 独立：同明文同 KEK 两次加密必须产出不同密文。
  assert.notStrictEqual(
    channelApiCrypto.encryptApiKey(PLAINTEXT, 'unit-secret'),
    channelApiCrypto.encryptApiKey(PLAINTEXT, 'unit-secret')
  );
});

/** 手工构造 v1 密文：KEK 派生密钥直接加密，没有 DEK 包封层。 */
function makeV1(kek, plaintext) {
  const key = crypto.createHash('sha256').update(kek).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    ct.toString('base64'),
  ].join(':');
}

it('crypto: legacy v1 (iv:tag:ct) blobs still decrypt after the v2 switch', () => {
  // 历史数据是「KEK 派生密钥直接加密」的 3 段格式，切换 v2 后必须继续可读，
  // 否则升级即静默丢 Key。
  const legacy = makeV1('legacy-kek', PLAINTEXT);
  assert.strictEqual(channelApiCrypto.wrapVersion(legacy), 'v1');
  assert.strictEqual(channelApiCrypto.decryptApiKey(legacy, 'legacy-kek'), PLAINTEXT);
  assert.strictEqual(channelApiCrypto.decryptApiKey(legacy, 'wrong-kek'), '');
  // 退役 KEK 也能解开 v1 密文：轮换过渡期对老数据同样生效。
  assert.strictEqual(
    channelApiCrypto.decryptApiKey(legacy, undefined, {
      [channelApiCrypto.KEY_SECRET_ENV]: 'some-other-kek',
      [channelApiCrypto.KEY_SECRET_PREVIOUS_ENV]: 'legacy-kek',
    }),
    PLAINTEXT
  );
});

it('crypto: key ring lets an old KEK keep decrypting after env rotation', () => {
  const oldKek = 'rotating-key-old';
  const newKek = 'rotating-key-new';
  const cipher = channelApiCrypto.encryptApiKey(PLAINTEXT, oldKek);
  // 直接换 env：主 KEK 是新的，旧密文解不开——这就是没有密钥环时的丢 Key 路径。
  assert.strictEqual(
    channelApiCrypto.decryptApiKey(cipher, undefined, {
      [channelApiCrypto.KEY_SECRET_ENV]: newKek,
    }),
    ''
  );
  // 把旧 KEK 挂到退役位：同一条密文立刻恢复可读，无需迁移即可上线。
  assert.strictEqual(
    channelApiCrypto.decryptApiKey(cipher, undefined, {
      [channelApiCrypto.KEY_SECRET_ENV]: newKek,
      [channelApiCrypto.KEY_SECRET_PREVIOUS_ENV]: oldKek,
    }),
    PLAINTEXT
  );
  assert.strictEqual(
    channelApiCrypto.needsRewrap(cipher, {
      [channelApiCrypto.KEY_SECRET_ENV]: newKek,
      [channelApiCrypto.KEY_SECRET_PREVIOUS_ENV]: oldKek,
    }),
    true,
    'cipher sitting on a retired KEK is flagged for re-wrap'
  );
});

it('crypto: reEncryptApiKey migrates a cipher onto the primary KEK', () => {
  const oldKek = 'rotating-key-old';
  const newKek = 'rotating-key-new';
  const rotated = {
    [channelApiCrypto.KEY_SECRET_ENV]: newKek,
    [channelApiCrypto.KEY_SECRET_PREVIOUS_ENV]: oldKek,
  };
  const cipher = channelApiCrypto.encryptApiKey(PLAINTEXT, oldKek);
  const migrated = channelApiCrypto.reEncryptApiKey(cipher, undefined, rotated);
  assert.notStrictEqual(migrated, cipher, 're-wrap produces a fresh ciphertext');
  // 迁完之后单靠主 KEK 就能解——退役 KEK 可以安全从 env 里删掉。
  assert.strictEqual(
    channelApiCrypto.decryptApiKey(migrated, undefined, {
      [channelApiCrypto.KEY_SECRET_ENV]: newKek,
    }),
    PLAINTEXT
  );
  assert.strictEqual(
    channelApiCrypto.needsRewrap(migrated, { [channelApiCrypto.KEY_SECRET_ENV]: newKek }),
    false
  );
  // 环里无解的输入不产生任何输出（fail-soft，不抛）。
  assert.strictEqual(channelApiCrypto.reEncryptApiKey('not-a-cipher', undefined, rotated), '');
  assert.strictEqual(channelApiCrypto.reEncryptApiKey('', undefined, rotated), '');
  assert.strictEqual(
    channelApiCrypto.unwrapKeyIndex('not-a-cipher', rotated), -1
  );
});

it('crypto: maskApiKey keeps only first 4 + **** + last 4', () => {
  assert.strictEqual(channelApiCrypto.maskApiKey(PLAINTEXT), 'sk-a****7890');
  assert.strictEqual(channelApiCrypto.maskApiKey('sk-123'), '****');
  assert.strictEqual(channelApiCrypto.maskApiKey('sk-12345678'), 'sk-1****');
  assert.strictEqual(channelApiCrypto.maskApiKey(''), '');
  assert.strictEqual(channelApiCrypto.maskApiKey(undefined), '');
});

it('CRUD: create → list → get → update → delete, key stays masked in views', async () => {
  const created = await channelApiService.createChannel({
    channel_name: 'ZCode',
    provider: '自定义',
    endpoint_url: '',
    api_key: PLAINTEXT,
    key_env_var: 'ZCODE_API_KEY',
    config_method: 'env_var',
  });

  assert.ok(created.id, 'created row has an id');
  assert.strictEqual(created.has_key, true);
  assert.strictEqual(created.masked_key, 'sk-a****7890', 'list/detail view carries the masked key');
  assert.ok(!JSON.stringify(created).includes(PLAINTEXT), 'view never leaks the plaintext');

  const found = await channelApiService.getChannel(created.id);
  assert.strictEqual(found.channel_name, 'ZCode');

  const listed = await channelApiService.listChannels({ q: 'zcode' });
  assert.strictEqual(listed.length, 1);
  assert.strictEqual(listed[0].id, created.id);

  const filtered = await channelApiService.listChannels({ q: '不存在的渠道' });
  assert.strictEqual(filtered.length, 0);

  const updated = await channelApiService.updateChannel(created.id, { notes: '改过备注' });
  assert.strictEqual(updated.notes, '改过备注');
  assert.strictEqual(updated.has_key, true, 'omitting api_key keeps the existing key');

  const cleared = await channelApiService.updateChannel(created.id, { api_key: '' });
  assert.strictEqual(cleared.has_key, false);
  assert.strictEqual(cleared.masked_key, '');

  assert.deepStrictEqual(await channelApiService.deleteChannel(created.id), {
    deleted: true,
    existed: true,
    channel_name: 'ZCode',
  });
  assert.strictEqual(await channelApiService.getChannel(created.id), null);
  assert.deepStrictEqual(await channelApiService.deleteChannel(created.id), {
    deleted: false,
    existed: false,
  });
});

it('validation: required fields, bad enum, bad env var name, bad docs url', async () => {
  const cases = [
    [{ channel_name: '', provider: 'x' }, 'channel_name 为必填项'],
    [{ channel_name: 'a', provider: '' }, 'provider 为必填项'],
    [
      { channel_name: 'a', provider: 'x', config_method: 'cli' },
      'config_method 必须是 env_var / config_file / both 之一',
    ],
    [
      { channel_name: 'a', provider: 'x', key_env_var: 'bad-name' },
      'key_env_var 不是合法的环境变量名（形如 ANTHROPIC_API_KEY）',
    ],
    [{ channel_name: 'a', provider: 'x', docs_url: 'ftp://example' }, 'docs_url 必须是 http(s) 链接'],
    [
      { channel_name: 'a'.repeat(121), provider: 'x' },
      'channel_name 长度不能超过 120 个字符',
    ],
  ];
  for (const [body, message] of cases) {
    try {
      await channelApiService.createChannel(body);
      assert.fail(`expected rejection for ${JSON.stringify(body)}`);
    } catch (e) {
      assert.strictEqual(e.name, 'ChannelApiValidationError');
      assert.strictEqual(e.message, message);
    }
  }
});

it('reveal: returns plaintext once and writes an audit entry without the key', async () => {
  auditSpy.mockClear();
  const created = await channelApiService.createChannel({
    channel_name: 'Cline',
    provider: 'Anthropic',
    endpoint_url: 'https://api.anthropic.com/v1/messages',
    api_key: PLAINTEXT,
    key_env_var: 'ANTHROPIC_API_KEY',
    config_method: 'both',
  });

  const revealed = await channelApiService.revealChannelKey(created.id, { username: 'tester' });

  assert.strictEqual(revealed.api_key, PLAINTEXT);
  assert.strictEqual(revealed.has_key, true);

  assert.strictEqual(auditSpy.mock.calls.length, 1, 'exactly one audit record per reveal');
  const [entry] = auditSpy.mock.calls[0];
  assert.strictEqual(entry.tool, 'channel-api:reveal');
  assert.strictEqual(entry.permission, 'allow');
  assert.strictEqual(entry.params.channel_name, 'Cline');
  assert.strictEqual(entry.params.actor, 'tester');
  assert.strictEqual(entry.result.success, true);
  assert.ok(!JSON.stringify(entry).includes(PLAINTEXT), 'audit entry must not contain the plaintext key');

  await channelApiService.deleteChannel(created.id);
});

it('config guide: file block for config_file, placeholder key when not revealed', async () => {
  const created = await channelApiService.createChannel({
    channel_name: 'Continue.dev',
    provider: '多供应商',
    endpoint_url: 'https://llm-gateway.example.test/v1',
    api_key: PLAINTEXT,
    key_env_var: 'ANTHROPIC_API_KEY',
    config_method: 'config_file',
  });

  const masked = await channelApiService.getConfigGuide(created.id);
  assert.strictEqual(masked.blocks.length, 1, 'config_file method yields a single file block');
  assert.strictEqual(masked.blocks[0].lang, 'yaml');
  assert.ok(masked.blocks[0].code.includes('${ANTHROPIC_API_KEY}'));
  assert.ok(!JSON.stringify(masked).includes(PLAINTEXT), 'masked guide never leaks the key');
  assert.strictEqual(masked.agent.agent, 'Continue.dev');
  assert.ok(Array.isArray(masked.agent.steps) && masked.agent.steps.length > 0);

  const revealed = await channelApiService.revealChannelKey(created.id);
  assert.ok(revealed.config.blocks[0].code.includes(PLAINTEXT), 'revealed guide substitutes the real key');

  await channelApiService.deleteChannel(created.id);
});

it('agent guides: all seven seeded agents documented', () => {
  const guides = channelApiService.listAgentGuides();
  assert.strictEqual(guides.length, 7);
  const names = guides.map((g) => g.agent);
  for (const expected of ['Claude Code', 'CommandCode', 'ZCode', 'Codex', 'Cursor', 'Cline', 'Continue.dev']) {
    assert.ok(names.includes(expected), `missing agent guide: ${expected}`);
  }
  for (const guide of guides) {
    assert.ok(guide.steps.length > 0, `${guide.agent} needs at least one config step`);
  }
});

it('seed: creates the seven channels and is idempotent across a second run', async () => {
  await ChannelApi.destroy({ where: {} });

  const first = await channelApiService.seedChannelApis();
  assert.strictEqual(first.total, 7);
  assert.strictEqual(first.created, 7);
  assert.strictEqual(first.kept, 0);

  let seeded = await channelApiService.listChannels();
  const claude = seeded.find((c) => c.channel_name === 'Claude Code');
  await channelApiService.updateChannel(claude.id, { notes: '用户改过，种子不得覆盖' });

  const second = await channelApiService.seedChannelApis();
  assert.strictEqual(second.created, 0);
  assert.strictEqual(second.kept, 7);

  seeded = await channelApiService.listChannels();
  assert.strictEqual(seeded.length, 7);
  const edited = seeded.find((c) => c.channel_name === 'Claude Code');
  assert.strictEqual(edited.notes, '用户改过，种子不得覆盖', 'seed must not overwrite user edits');
  assert.strictEqual(edited.provider, 'Anthropic');
  assert.strictEqual(edited.endpoint_url, 'https://api.anthropic.com/v1/messages');
  assert.strictEqual(edited.key_env_var, 'ANTHROPIC_API_KEY');
  assert.strictEqual(edited.has_key, false, 'seeded channels ship without a key');
  const zcode = seeded.find((c) => c.channel_name === 'ZCode');
  assert.strictEqual(zcode.endpoint_url, '', 'ZCode endpoint is left for the user to fill');
});
