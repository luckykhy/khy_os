'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const core = require('../../../src/services/messaging/ilinkCore');

// ── 门控与脱敏 ────────────────────────────────────────────────────────────────

test('isEnabled: 默认开;off-words 关', () => {
  assert.strictEqual(core.isEnabled({}), true);
  assert.strictEqual(core.isEnabled({ KHY_MSG: 'true' }), true);
  for (const off of ['0', 'false', 'off', 'no', ' OFF ', 'False']) {
    assert.strictEqual(core.isEnabled({ KHY_MSG: off }), false, `期望 ${off} 关`);
  }
});

test('maskToken: 绝不回显完整 token', () => {
  assert.strictEqual(core.maskToken(''), '(未配置)');
  assert.strictEqual(core.maskToken(null), '(未配置)');
  const long = 'abcdefghij0123456789wxyz';
  const masked = core.maskToken(long);
  assert.ok(!masked.includes('efghij'), '中段必须被遮蔽');
  assert.ok(masked.startsWith('abcd') && masked.includes('wxyz'));
  // 短 token 也不能整串回显。
  assert.ok(!core.maskToken('short12').includes('short12'));
});

test('平台键是 ilink,不是 wechat/weixin(否则会串到企业微信配置)', () => {
  assert.strictEqual(core.PLATFORM, 'ilink');
  const msgCore = require('../../../src/services/messaging/msgChannelCore');
  // 前提校验:wechat/weixin 确实已被别名到 wecom,所以我们不能用这两个名字。
  assert.strictEqual(msgCore.normalizePlatform('wechat'), 'wecom');
  assert.strictEqual(msgCore.normalizePlatform('ilink'), null, 'ilink 不应撞上既有平台键');
});

// ── baseUrl 白名单(服务端下发值不可盲信)────────────────────────────────────

test('isTrustedBaseUrl: 仅 https + 白名单域名', () => {
  const hosts = ['weixin.qq.com', 'wechat.com'];
  assert.strictEqual(core.isTrustedBaseUrl('https://ilinkai.weixin.qq.com', hosts), true);
  assert.strictEqual(core.isTrustedBaseUrl('https://wechat.com', hosts), true);
  // http 降级
  assert.strictEqual(core.isTrustedBaseUrl('http://ilinkai.weixin.qq.com', hosts), false);
  // 域名后缀伪造:evil-weixin.qq.com.attacker.com
  assert.strictEqual(core.isTrustedBaseUrl('https://weixin.qq.com.attacker.com', hosts), false);
  // 前缀伪造:notweixin.qq.com 不是 .weixin.qq.com 的子域
  assert.strictEqual(core.isTrustedBaseUrl('https://notweixin.qq.com', hosts), false);
  assert.strictEqual(core.isTrustedBaseUrl('garbage', hosts), false);
  assert.strictEqual(core.isTrustedBaseUrl('https://weixin.qq.com', []), false);
});

test('buildCdnUrl: encrypt_query_param 字符集白名单防注入', () => {
  const base = 'https://novac2c.cdn.weixin.qq.com/c2c';
  const ok = core.buildCdnUrl('a=1&b=2', base);
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.url, `${base}?a=1&b=2`);
  // 空 / 含路径穿越 / 含空格都应拒绝
  assert.strictEqual(core.buildCdnUrl('', base).ok, false);
  assert.strictEqual(core.buildCdnUrl('a=1/../x', base).ok, false);
  assert.strictEqual(core.buildCdnUrl('a=1 b', base).ok, false);
  assert.strictEqual(core.buildCdnUrl('a=1#frag', base).ok, false);
});

// ── item_list 解析 ───────────────────────────────────────────────────────────

test('extractText: 拼接全部文本项(一条消息可能被拆成多项)', () => {
  const items = [
    { type: 1, text_item: { text: 'hello' } },
    { type: 1, text_item: { text: 'world' } },
  ];
  assert.strictEqual(core.extractText(items), 'hello\nworld');
  assert.strictEqual(core.extractText([]), '');
  assert.strictEqual(core.extractText(null), '');
  // type 缺失也要认(见过这种报文),判据是 text 非空
  assert.strictEqual(core.extractText([{ text_item: { text: 'x' } }]), 'x');
  // 空串不入列,避免产出前导换行
  assert.strictEqual(core.extractText([{ text_item: { text: '' } }, { text_item: { text: 'y' } }]), 'y');
});

test('getImageCdnData: 新旧两种 CDN 字段形态都要认', () => {
  const oldForm = { cdn_media: { aes_key: 'K', encrypt_query_param: 'Q' } };
  assert.deepStrictEqual(core.getImageCdnData(oldForm), { aesKey: 'K', encryptQueryParam: 'Q' });
  const newForm = { aeskey: 'K2', media: { encrypt_query_param: 'Q2' } };
  assert.deepStrictEqual(core.getImageCdnData(newForm), { aesKey: 'K2', encryptQueryParam: 'Q2' });
  assert.strictEqual(core.getImageCdnData(null), null);
  assert.strictEqual(core.getImageCdnData({ cdn_media: { aes_key: 'K' } }), null, '缺 query param 应为 null');
});

test('extractImageRefs / describeUnsupportedItems: 5 种项类型', () => {
  const items = [
    { type: 1, text_item: { text: 't' } },
    { type: 2, image_item: { cdn_media: { aes_key: 'K', encrypt_query_param: 'Q' } } },
    { type: 3, voice_item: {} },
    { type: 4, file_item: {} },
    { type: 5, video_item: {} },
  ];
  assert.deepStrictEqual(core.extractImageRefs(items), [{ aesKey: 'K', encryptQueryParam: 'Q' }]);
  assert.deepStrictEqual(core.describeUnsupportedItems(items), ['语音', '文件', '视频']);
  // 去重:同类型多项只报一次
  assert.deepStrictEqual(core.describeUnsupportedItems([{ voice_item: {} }, { voice_item: {} }]), ['语音']);
});

test('parseInboundMessage: 归一 + 丢弃规则', () => {
  const msg = {
    message_type: core.MESSAGE_TYPE.USER,
    from_user_id: 'u1',
    context_token: 'ctx',
    message_id: 7,
    create_time_ms: 1700000000000,
    item_list: [{ type: 1, text_item: { text: '  hi  ' } }, { type: 3, voice_item: {} }],
  };
  const p = core.parseInboundMessage(msg);
  assert.strictEqual(p.userId, 'u1');
  assert.strictEqual(p.channelId, 'u1', '单聊:会话与用户同源');
  assert.strictEqual(p.text, 'hi');
  assert.strictEqual(p.threadId, 'ctx', 'threadId 必须是 context_token');
  assert.strictEqual(p.messageId, 7);
  assert.deepStrictEqual(p.unsupported, ['语音']);
  assert.strictEqual(p.raw, msg);

  // BOT 方向是自己的回声,必须丢
  assert.strictEqual(core.parseInboundMessage({ ...msg, message_type: core.MESSAGE_TYPE.BOT }), null);
  // 缺 from_user_id / item_list / 非对象
  assert.strictEqual(core.parseInboundMessage({ ...msg, from_user_id: '' }), null);
  assert.strictEqual(core.parseInboundMessage({ ...msg, item_list: [] }), null);
  assert.strictEqual(core.parseInboundMessage(null), null);
  // message_type 缺失时宽容按 USER 处理
  const noType = { ...msg }; delete noType.message_type;
  assert.ok(core.parseInboundMessage(noType));
});

// ── 出站构造 ─────────────────────────────────────────────────────────────────

test('buildOutboundMessage: BOT + FINISH,from_user_id 固定空串,带 base_info,原样带回 context_token', () => {
  const out = core.buildOutboundMessage({
    toUserId: 'u1',
    clientId: 'cid',
    contextToken: 'ctx',
    items: core.buildTextItems('hi'),
  });
  assert.strictEqual(out.msg.from_user_id, '', '机器人发送时真实协议固定空串');
  assert.strictEqual(out.msg.to_user_id, 'u1');
  assert.strictEqual(out.msg.message_type, core.MESSAGE_TYPE.BOT);
  assert.strictEqual(out.msg.message_state, core.MESSAGE_STATE.FINISH, '本通道不做流式');
  assert.strictEqual(out.msg.context_token, 'ctx');
  assert.deepStrictEqual(out.msg.item_list, [{ type: 1, text_item: { text: 'hi' } }]);
  assert.strictEqual(out.base_info.channel_version, core.CHANNEL_VERSION, '缺 base_info 发不出');
  // 缺字段时退化成空串而不是 undefined(JSON 里 undefined 会整键消失)
  const bare = core.buildOutboundMessage({});
  assert.strictEqual(bare.msg.to_user_id, '');
  assert.strictEqual(bare.msg.from_user_id, '');
  assert.deepStrictEqual(bare.msg.item_list, []);
});

test('buildImageItems: type=2 + image_item.media.encrypt_type=1 + mid_size(明文字节)', () => {
  const items = core.buildImageItems(
    { encrypt_query_param: 'Q', aes_key: 'K' },
    { rawsize: 123 },
  );
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].type, core.ITEM_TYPE.IMAGE);
  assert.strictEqual(items[0].type, 2);
  const m = items[0].image_item.media;
  assert.strictEqual(m.encrypt_query_param, 'Q');
  assert.strictEqual(m.aes_key, 'K');
  assert.strictEqual(m.encrypt_type, 1);
  assert.strictEqual(items[0].image_item.mid_size, 123);
  // 缺字段退化空串/0,绝不 undefined
  const bare = core.buildImageItems();
  assert.strictEqual(bare[0].image_item.media.encrypt_query_param, '');
  assert.strictEqual(bare[0].image_item.mid_size, 0);
});

test('buildFileItems: type=4 + file_item.media.encrypt_type=1 + file_name(不含 size/md5)', () => {
  const items = core.buildFileItems(
    { encrypt_query_param: 'Q', aes_key: 'K' },
    { fileName: 'doc.bin' },
  );
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].type, core.ITEM_TYPE.FILE);
  assert.strictEqual(items[0].type, 4);
  const m = items[0].file_item.media;
  assert.strictEqual(m.encrypt_query_param, 'Q');
  assert.strictEqual(m.aes_key, 'K');
  assert.strictEqual(m.encrypt_type, 1);
  assert.strictEqual(items[0].file_item.file_name, 'doc.bin');
  // 参考实现说 file 填 size/md5 反而发不出,故这两个字段不应出现
  assert.strictEqual(items[0].file_item.file_size, undefined);
  assert.strictEqual(items[0].file_item.md5, undefined);
});

test('buildClientId: 纯函数,随 seq/now 变化', () => {
  assert.strictEqual(core.buildClientId(1, 1700000000000), 'khy-1700000000000-1');
  assert.notStrictEqual(core.buildClientId(1, 1), core.buildClientId(2, 1));
});

// ── 分片 ─────────────────────────────────────────────────────────────────────

test('splitMessage: 按 UTF-16 码元切,优先换行,过早则硬切', () => {
  assert.deepStrictEqual(core.splitMessage('', 10), []);
  assert.deepStrictEqual(core.splitMessage('short', 10), ['short']);

  // 无换行 → 硬切,每片恰好 limit
  const flat = 'a'.repeat(25);
  const hard = core.splitMessage(flat, 10);
  assert.deepStrictEqual(hard.map((c) => c.length), [10, 10, 5]);
  assert.strictEqual(hard.join(''), flat, '硬切不得丢字符');

  // 换行落在 limit 的 80% 处 → 按行切,且下片不以换行开头
  const nl = `${'a'.repeat(8)}\n${'b'.repeat(15)}`;
  const soft = core.splitMessage(nl, 10);
  assert.strictEqual(soft[0], 'a'.repeat(8));
  assert.ok(!soft[1].startsWith('\n'), '切点换行须被吸收,不留空行');

  // 换行过早(< 30% limit) → 放弃按行切,改硬切,避免碎片
  const early = `ab\n${'c'.repeat(30)}`;
  assert.strictEqual(core.splitMessage(early, 10)[0].length, 10);

  // 全片拼回原文(去掉被吸收的换行后)
  assert.strictEqual(core.splitMessage(flat, 2048).length, 1);
});

// ── 轮询策略 ─────────────────────────────────────────────────────────────────

test('decideBackoffMs: 达阈值转长退避', () => {
  const cfg = { shortMs: 3000, longMs: 30000, threshold: 3 };
  assert.strictEqual(core.decideBackoffMs(0, cfg), 3000);
  assert.strictEqual(core.decideBackoffMs(2, cfg), 3000);
  assert.strictEqual(core.decideBackoffMs(3, cfg), 30000);
  assert.strictEqual(core.decideBackoffMs(99, cfg), 30000);
  // 缺 cfg 时用内置缺省,不得返回 NaN/0
  assert.ok(core.decideBackoffMs(1) > 0);
});

test('isSessionExpired: 只认 ret=-14', () => {
  assert.strictEqual(core.isSessionExpired({ ret: -14 }), true);
  assert.strictEqual(core.isSessionExpired({ ret: 0 }), false);
  assert.strictEqual(core.isSessionExpired({ ret: -1 }), false);
  assert.strictEqual(core.isSessionExpired(null), false);
});

test('createDedupe: 只认 message_id;无 id 一律放行;容量满淘汰最旧', () => {
  const d = core.createDedupe(10);
  assert.strictEqual(d.accept(1), true);
  assert.strictEqual(d.accept(1), false, '重复须挡');
  assert.strictEqual(d.accept(2), true);
  // 没有 message_id 无法去重 → 宁可重复也不丢
  assert.strictEqual(d.accept(null), true);
  assert.strictEqual(d.accept(null), true);

  // 溢出后淘汰最旧的一半,新 id 仍可接受,且不会把当前这批全清掉
  const d2 = core.createDedupe(4);
  for (let i = 0; i < 5; i++) d2.accept(i);
  assert.ok(d2.size() <= 4, `容量应受限,实际 ${d2.size()}`);
  assert.strictEqual(d2.accept(4), false, '最新的 id 不应被淘汰');
});

// ── 文本判定 ─────────────────────────────────────────────────────────────────

test('parsePermissionReply: 中英文与常见变体', () => {
  for (const yes of ['y', 'Y', 'yes', ' YES ', '是', '好', '允许', '同意', 'y.', '是。']) {
    assert.strictEqual(core.parsePermissionReply(yes), 'allow', `期望 allow: ${yes}`);
  }
  for (const no of ['n', 'no', '否', '不', '拒绝', '不允许', 'n!']) {
    assert.strictEqual(core.parsePermissionReply(no), 'deny', `期望 deny: ${no}`);
  }
  // 普通话语不应被误判成审批回复
  for (const other of ['', '  ', 'yep', '好的帮我写个函数', '不过我想问', 'yesterday']) {
    assert.strictEqual(core.parsePermissionReply(other), null, `不应判为审批: ${other}`);
  }
});

test('parseSlashCommand: 剩余部分整体作为 args,不分词', () => {
  assert.deepStrictEqual(core.parseSlashCommand('/help'), { cmd: 'help', args: '' });
  assert.deepStrictEqual(core.parseSlashCommand('/CWD  /tmp/a b '), { cmd: 'cwd', args: '/tmp/a b' });
  assert.deepStrictEqual(core.parseSlashCommand('  /model gpt-4  '), { cmd: 'model', args: 'gpt-4' });
  assert.strictEqual(core.parseSlashCommand('hello'), null);
  assert.strictEqual(core.parseSlashCommand('/'), null);
  assert.strictEqual(core.parseSlashCommand(''), null);
  assert.strictEqual(core.parseSlashCommand(null), null);
});

test('detectImageMime: 按 magic bytes,不信声明', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0]);
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
  const gif = Buffer.from([0x47, 0x49, 0x46, 0x38]);
  assert.strictEqual(core.detectImageMime(png), 'image/png');
  assert.strictEqual(core.detectImageMime(jpg), 'image/jpeg');
  assert.strictEqual(core.detectImageMime(gif), 'image/gif');
  assert.strictEqual(core.detectImageMime(Buffer.alloc(0)), 'application/octet-stream');
  assert.strictEqual(core.detectImageMime(null), 'application/octet-stream');
});
