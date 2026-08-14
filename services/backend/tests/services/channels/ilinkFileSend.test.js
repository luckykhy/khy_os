'use strict';

/**
 * 微信「文件发送链路」离线单测(node:test 运行器,与既有 ilink 套件一致)。
 *
 * 覆盖四段:
 *   1. ilinkCore.buildFileItems      —— 纯函数出站 item_list 结构与兜底。
 *   2. ilinkMedia.uploadFile         —— mock api.getUploadUrl + 全局 fetch(CDN POST)。
 *   3. ilinkChannel.sendFile         —— mock media.uploadFile + 实例 _sendChunkWithRetry。
 *   4. ilinkDispatcher._deliverFiles —— 构造 toolCallLog + mock channel/_say。
 *
 * 全部离线:不触模型、不触网络、不落真实配置。api._post/网络一律以桩替身注入。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// 隔离数据家,避免污染真实 ~/.khyquant;文件大小上限压到 1KB,便于测「超限降级」。
process.env.KHYOS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'khyos-ilinkfile-'));
process.env.KHY_ILINK_MAX_FILE_SIZE = '1024';
process.env.KHY_ILINK_DISABLE_TOOL_LOOP = '1';

const { test } = require('node:test');
const assert = require('node:assert');

const core = require('../../../src/services/messaging/ilinkCore');
const cryptoUtil = require('../../../src/services/messaging/ilinkCrypto');
const media = require('../../../src/services/messaging/ilinkMedia');
const defaults = require('../../../src/constants/serviceDefaults');
const { IlinkChannel } = require('../../../src/services/channels/ilinkChannel');
const { IlinkDispatcher } = require('../../../src/services/channels/ilinkDispatcher');

// ── 1. buildFileItems:纯函数结构断言(真实协议:file_item.media,不含 size/md5)──

test('buildFileItems: 正常路径 —— type=4 + file_item.media(encrypt_type=1)+ file_name', () => {
  const items = core.buildFileItems(
    { aes_key: 'AK', encrypt_query_param: 'EQ' },
    { fileName: 'report.pdf' },
  );
  assert.strictEqual(items.length, 1);
  const it = items[0];
  assert.strictEqual(it.type, core.ITEM_TYPE.FILE);
  assert.strictEqual(it.type, 4, 'FILE 项类型固定为 4');
  assert.deepStrictEqual(it.file_item.media, {
    encrypt_query_param: 'EQ',
    aes_key: 'AK',
    encrypt_type: 1,
  });
  assert.strictEqual(it.file_item.file_name, 'report.pdf');
  // file 的 size/md5 参考实现说填了反而发不出,暂不填。
  assert.strictEqual(it.file_item.file_size, undefined);
  assert.strictEqual(it.file_item.cdn_media, undefined, '不再用旧的 cdn_media 形态');
});

test('buildFileItems: 缺 media / 缺 meta —— 退化成空串,不产出 undefined 字段值', () => {
  const items = core.buildFileItems();
  const fi = items[0].file_item;
  assert.strictEqual(items[0].type, 4);
  assert.strictEqual(fi.media.encrypt_query_param, '');
  assert.strictEqual(fi.media.aes_key, '');
  assert.strictEqual(fi.media.encrypt_type, 1);
  assert.strictEqual(fi.file_name, '');
  // 传 null media 与空 meta 同样兜底。
  const items2 = core.buildFileItems(null, {});
  assert.deepStrictEqual(items2[0].file_item.media, {
    encrypt_query_param: '',
    aes_key: '',
    encrypt_type: 1,
  });
});

test('buildFileItems: 字段缺失 / 非法类型的 String() 兜底', () => {
  const items = core.buildFileItems({ aes_key: null }, { fileName: 123 });
  const fi = items[0].file_item;
  assert.strictEqual(fi.media.aes_key, '');
  assert.strictEqual(fi.media.encrypt_query_param, '');
  assert.strictEqual(fi.file_name, '123', 'fileName 经 String() 归一');
});

// ── 2. uploadFile:mock api.getUploadUrl + 全局 fetch(CDN POST)─────────────────

/** 装一个假的全局 fetch,返回 restore。 */
function installFetch(impl) {
  const original = global.fetch;
  global.fetch = impl;
  return () => { global.fetch = original; };
}

/** 只暴露 getUploadUrl 的假 api,记录收到的入参(真实协议是单对象)。 */
function fakeUploadApi(resp, { throwErr } = {}) {
  return {
    calls: [],
    async getUploadUrl(p) {
      this.calls.push(p);
      if (throwErr) throw throwErr;
      return resp;
    },
  };
}

/** 成功形态的 CDN 响应:2xx + 响应头 x-encrypted-param(下载凭据)。 */
function okCdnResponse(eqp = 'EQ-1') {
  return {
    ok: true,
    status: 200,
    headers: { get: (k) => (String(k).toLowerCase() === 'x-encrypted-param' ? eqp : null) },
  };
}

test('uploadFile: 成功 —— getUploadUrl 收全参数,CDN POST octet-stream,eqp 取自响应头', async () => {
  const buf = Buffer.from('hello file payload');
  const api = fakeUploadApi({ upload_param: 'UP-1', ret: 0 });
  let cdnArgs = null;
  const restore = installFetch(async (url, init) => {
    cdnArgs = { url, init };
    return okCdnResponse('EQ-1');
  });
  try {
    const r = await media.uploadFile(api, buf, { toUserId: 'u1', fileName: 'doc.bin' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.media.encrypt_query_param, 'EQ-1', 'eqp 应取自 CDN 响应头 x-encrypted-param');
    assert.ok(r.media.aesKeyOutbound, 'aesKeyOutbound = base64(hex)');
    assert.strictEqual(r.media.rawsize, buf.length);
    // getUploadUrl 契约:收单对象,含全部字段(缺一微信恒返回 ret:-2)。
    assert.strictEqual(api.calls.length, 1);
    const p = api.calls[0];
    assert.strictEqual(p.mediaType, media.MEDIA_TYPE.FILE);
    assert.strictEqual(p.toUserId, 'u1');
    assert.strictEqual(p.rawsize, buf.length);
    assert.strictEqual(p.filesize, cryptoUtil.aesEcbPaddedSize(buf.length));
    assert.match(p.filekey, /^[0-9a-f]{32}$/, 'filekey 为 32 位 hex');
    assert.match(p.aeskey, /^[0-9a-f]{32}$/, 'aeskey 为 32 位 hex 明文');
    assert.match(p.rawfilemd5, /^[0-9a-f]{32}$/, 'rawfilemd5 为 MD5 hex');
    // CDN 用 POST + octet-stream + 无 Authorization;URL 带 upload_param 与 filekey。
    assert.ok(cdnArgs.url.includes('encrypted_query_param=UP-1'), `CDN URL 应带 upload_param:${cdnArgs.url}`);
    assert.ok(cdnArgs.url.includes(`filekey=${p.filekey}`));
    assert.strictEqual(cdnArgs.init.method, 'POST');
    assert.strictEqual(cdnArgs.init.headers['Content-Type'], 'application/octet-stream');
    assert.ok(!cdnArgs.init.headers.Authorization, 'CDN 上传不带 Authorization');
  } finally {
    restore();
  }
});

test('uploadFile: api 缺失 —— {ok:false},不发起任何网络请求,绝不抛', async () => {
  let fetched = false;
  const restore = installFetch(async () => { fetched = true; return okCdnResponse(); });
  try {
    const r = await media.uploadFile(null, Buffer.from('x'), { fileName: 'a.bin' });
    assert.strictEqual(r.ok, false);
    assert.ok(/ilink api/.test(r.error), `实际:${r.error}`);
    assert.strictEqual(fetched, false, '缺 api 时不应触网');
  } finally {
    restore();
  }
});

test('uploadFile: buffer 为空 —— {ok:false 内容为空},不触网', async () => {
  const api = fakeUploadApi({ upload_param: 'UP' });
  let fetched = false;
  const restore = installFetch(async () => { fetched = true; return okCdnResponse(); });
  try {
    const r = await media.uploadFile(api, Buffer.alloc(0), { fileName: 'a.bin' });
    assert.strictEqual(r.ok, false);
    assert.ok(/内容为空/.test(r.error), `实际:${r.error}`);
    assert.strictEqual(api.calls.length, 0, '空内容不该申请上传地址');
    assert.strictEqual(fetched, false);
  } finally {
    restore();
  }
});

test('uploadFile: getUploadUrl 抛错 —— catch 成 {ok:false},绝不抛', async () => {
  const err = new Error('申请超时'); err.status = 503;
  const api = fakeUploadApi(null, { throwErr: err });
  const restore = installFetch(async () => okCdnResponse());
  try {
    const r = await media.uploadFile(api, Buffer.from('data'), { fileName: 'a.bin' });
    assert.strictEqual(r.ok, false);
    assert.ok(/申请上传地址出错/.test(r.error), `实际:${r.error}`);
    assert.ok(r.error.includes('503'), '应带上 HTTP 状态');
  } finally {
    restore();
  }
});

test('uploadFile: getUploadUrl 缺 upload_param(ret=-2)—— 如实失败,不触 CDN', async () => {
  const api = fakeUploadApi({ ret: -2 });
  let fetched = false;
  const restore = installFetch(async () => { fetched = true; return okCdnResponse(); });
  try {
    const r = await media.uploadFile(api, Buffer.from('data'), { fileName: 'a.bin' });
    assert.strictEqual(r.ok, false);
    assert.ok(/upload_param/.test(r.error), `实际:${r.error}`);
    assert.ok(r.error.includes('-2'), '应带上 ret 便于排查');
    assert.strictEqual(fetched, false, '拿不到 upload_param 不应上传 CDN');
  } finally {
    restore();
  }
});

test('uploadFile: CDN 返回非 2xx —— {ok:false CDN 返回非 2xx}', async () => {
  const api = fakeUploadApi({ upload_param: 'UP' });
  const restore = installFetch(async () => ({
    ok: false,
    status: 500,
    async text() { return 'internal error'; },
    headers: { get: () => null },
  }));
  try {
    const r = await media.uploadFile(api, Buffer.from('data'), { fileName: 'a.bin' });
    assert.strictEqual(r.ok, false);
    assert.ok(/CDN 返回非 2xx/.test(r.error), `实际:${r.error}`);
    assert.ok(r.error.includes('500'));
  } finally {
    restore();
  }
});

test('uploadFile: CDN 响应头缺 x-encrypted-param —— 如实失败(下载方拼不出 URL)', async () => {
  const api = fakeUploadApi({ upload_param: 'UP-1' });
  const restore = installFetch(async () => ({
    ok: true, status: 200, headers: { get: () => null },
  }));
  try {
    const r = await media.uploadFile(api, Buffer.from('data'), { fileName: 'a.bin' });
    assert.strictEqual(r.ok, false);
    assert.ok(/x-encrypted-param/.test(r.error), `实际:${r.error}`);
  } finally {
    restore();
  }
});

test('uploadFile: 走大文件超时常量 ILINK_FILE_UPLOAD_TIMEOUT_MS(区别于图片)', () => {
  // 断言常量本身有效且明显大于图片超时(契约:文件走 180s 级、图片走 30s 级)。
  assert.ok(Number.isFinite(defaults.ILINK_FILE_UPLOAD_TIMEOUT_MS));
  assert.ok(defaults.ILINK_FILE_UPLOAD_TIMEOUT_MS >= defaults.ILINK_CDN_TIMEOUT_MS);
});

// ── 3. sendFile:mock media.uploadFile + 实例 _sendChunkWithRetry ──────────────

/**
 * 临时替换 media.uploadFile(channel 与本测试共享同一模块对象),返回 restore。
 */
function stubUploadFile(impl) {
  const original = media.uploadFile;
  media.uploadFile = impl;
  return () => { media.uploadFile = original; };
}

function mkChannel() {
  // sendFile 里 api 只透传给被 stub 掉的 media.uploadFile,给个空桩即可。
  return new IlinkChannel({ accountId: 'bot1', api: {} });
}

test('sendFile: 上传成功 —— 构造含 buildFileItems(media 结构)的 payload,返回 {ok:true,sent:1}', async () => {
  const restore = stubUploadFile(async (api, buf, opts) => {
    // 断言参数如实透传(真实协议:第三参为 opts,含 toUserId/fileName)。
    assert.ok(Buffer.isBuffer(buf));
    assert.strictEqual(opts.toUserId, 'u1');
    assert.strictEqual(opts.fileName, 'data.bin');
    return { ok: true, media: { encrypt_query_param: 'EQ', aesKeyOutbound: 'AK64', rawsize: 5 } };
  });
  try {
    const ch = mkChannel();
    let captured = null;
    ch._sendChunkWithRetry = async (payload) => { captured = payload; };
    const r = await ch.sendFile('u1', Buffer.from('12345'), { fileName: 'data.bin', threadId: 'ctx' });
    assert.deepStrictEqual(r, { ok: true, sent: 1 });
    const it = captured.msg.item_list[0];
    assert.strictEqual(it.type, core.ITEM_TYPE.FILE);
    assert.strictEqual(it.file_item.media.encrypt_query_param, 'EQ');
    assert.strictEqual(it.file_item.media.aes_key, 'AK64', 'aes_key 用 aesKeyOutbound(base64)');
    assert.strictEqual(it.file_item.media.encrypt_type, 1);
    assert.strictEqual(it.file_item.file_name, 'data.bin');
    assert.strictEqual(it.file_item.file_size, undefined, 'file 的 size 暂不填');
    assert.strictEqual(captured.msg.context_token, 'ctx');
    assert.strictEqual(captured.msg.to_user_id, 'u1');
    assert.strictEqual(captured.msg.from_user_id, '', '机器人发送 from_user_id 固定空串');
    assert.strictEqual(captured.base_info.channel_version, core.CHANNEL_VERSION);
  } finally {
    restore();
  }
});

test('sendFile: 上传失败 —— 直接返回 {ok:false,error},不进入发送路径', async () => {
  const restore = stubUploadFile(async () => ({ ok: false, error: '上传文件失败:内容为空' }));
  try {
    const ch = mkChannel();
    let sendCalled = false;
    ch._sendChunkWithRetry = async () => { sendCalled = true; };
    const r = await ch.sendFile('u1', Buffer.from('x'), { fileName: 'a.bin' });
    assert.strictEqual(r.ok, false);
    assert.ok(/上传文件失败/.test(r.error), `实际:${r.error}`);
    assert.strictEqual(sendCalled, false, '上传失败不应再发消息');
  } finally {
    restore();
  }
});

test('sendFile: 发送抛错 —— 返回 {ok:false,sent:0,error},绝不抛', async () => {
  const restore = stubUploadFile(async () => ({
    ok: true, media: { encrypt_query_param: 'EQ', aesKeyOutbound: 'AK', rawsize: 1 },
  }));
  try {
    const ch = mkChannel();
    ch._sendChunkWithRetry = async () => { throw new Error('网络炸了'); };
    const r = await ch.sendFile('u1', Buffer.from('x'), { fileName: 'a.bin' });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.sent, 0);
    assert.ok(/网络炸了/.test(r.error), `实际:${r.error}`);
  } finally {
    restore();
  }
});

// ── 4. _deliverFiles:toolCallLog 扫描 + 投递编排 ─────────────────────────────

/** 记录 sendImage/sendFile 调用的假通道。 */
function fakeFileChannel(overrides = {}) {
  return {
    imageCalls: [],
    fileCalls: [],
    async sendImage(cid, buf, opts) {
      this.imageCalls.push({ cid, buf, opts });
      return overrides.imageResult ? overrides.imageResult(this.imageCalls.length) : { ok: true, sent: 1 };
    },
    async sendFile(cid, buf, opts) {
      this.fileCalls.push({ cid, buf, opts });
      return overrides.fileResult ? overrides.fileResult(this.fileCalls.length) : { ok: true, sent: 1 };
    },
    async sendReply() { return { ok: true, sent: 1 }; },
  };
}

/** 造一个临时文件并返回其绝对路径与大小。 */
function makeTmpFile(name, contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khyos-deliver-'));
  const p = path.join(dir, name);
  fs.writeFileSync(p, contents);
  return p;
}

/** 构造一条 SendUserFile 成功的 toolCallLog 条目。 */
function sendUserFileEntry(filePath) {
  return { iteration: 1, tool: 'SendUserFile', params: {}, result: { success: true, file: filePath }, elapsed: 5 };
}

/** 造一个带 _say spy 的 dispatcher。 */
function mkDispatcher(channel) {
  const d = new IlinkDispatcher({ channel, accountId: 'bot1' });
  d.says = [];
  d._say = async (_msg, text) => { d.says.push(text); };
  return d;
}

const MSG = { userId: 'u1', channelId: 'u1', threadId: 'ctx' };

test('_deliverFiles: 图片扩展名走 sendImage,不走 sendFile', async () => {
  const ch = fakeFileChannel();
  const d = mkDispatcher(ch);
  const p = makeTmpFile('pic.png', 'tiny');
  await d._deliverFiles(MSG, { toolCallLog: [sendUserFileEntry(p)] });
  assert.strictEqual(ch.imageCalls.length, 1, '图片应走 sendImage');
  assert.strictEqual(ch.fileCalls.length, 0);
  assert.strictEqual(ch.imageCalls[0].opts.fileName, 'pic.png');
  assert.strictEqual(d.says.length, 0, '成功投递无需文本补充');
});

test('_deliverFiles: 非图片扩展名走 sendFile,并透传 fileSize', async () => {
  const ch = fakeFileChannel();
  const d = mkDispatcher(ch);
  const p = makeTmpFile('report.txt', 'hi');
  await d._deliverFiles(MSG, { toolCallLog: [sendUserFileEntry(p)] });
  assert.strictEqual(ch.fileCalls.length, 1, '普通文件应走 sendFile');
  assert.strictEqual(ch.imageCalls.length, 0);
  assert.strictEqual(ch.fileCalls[0].opts.fileName, 'report.txt');
  assert.strictEqual(ch.fileCalls[0].opts.fileSize, 2, 'fileSize 取自 stat.size');
});

test('_deliverFiles: 文件超限 —— 走 _say 文本降级,不上传', async () => {
  const ch = fakeFileChannel();
  const d = mkDispatcher(ch);
  // 上限被压到 1KB;造一个 2KB 文件触发降级。
  const p = makeTmpFile('big.bin', Buffer.alloc(2048, 1));
  await d._deliverFiles(MSG, { toolCallLog: [sendUserFileEntry(p)] });
  assert.strictEqual(ch.fileCalls.length, 0, '超限不应上传');
  assert.strictEqual(ch.imageCalls.length, 0);
  assert.strictEqual(d.says.length, 1);
  assert.ok(/太大/.test(d.says[0]), `应告知太大:${d.says[0]}`);
  assert.ok(d.says[0].includes(p), '应把自取路径给用户');
});

test('_deliverFiles: 发送返回 {ok:false} —— fail-soft,_say 告知,不抛', async () => {
  const ch = fakeFileChannel({ fileResult: () => ({ ok: false, error: 'CDN 拒绝' }) });
  const d = mkDispatcher(ch);
  const p = makeTmpFile('a.txt', 'hi');
  await d._deliverFiles(MSG, { toolCallLog: [sendUserFileEntry(p)] });
  assert.strictEqual(ch.fileCalls.length, 1);
  assert.strictEqual(d.says.length, 1);
  assert.ok(/发送失败/.test(d.says[0]), `实际:${d.says[0]}`);
});

test('_deliverFiles: 发送抛错 —— fail-soft,_say 告知,不抛', async () => {
  const ch = fakeFileChannel({ fileResult: () => { throw new Error('炸了'); } });
  const d = mkDispatcher(ch);
  const p = makeTmpFile('a.txt', 'hi');
  await d._deliverFiles(MSG, { toolCallLog: [sendUserFileEntry(p)] });
  assert.strictEqual(d.says.length, 1);
  assert.ok(/发送出错/.test(d.says[0]), `实际:${d.says[0]}`);
});

test('_deliverFiles: out.toolCallLog 非数组 —— 直接 return,不报错不投递', async () => {
  const ch = fakeFileChannel();
  const d = mkDispatcher(ch);
  // 纯字符串 out(工具循环不可用)。
  await d._deliverFiles(MSG, '这是一段纯文本回复');
  await d._deliverFiles(MSG, { toolCallLog: 'not-an-array' });
  await d._deliverFiles(MSG, null);
  assert.strictEqual(ch.fileCalls.length, 0);
  assert.strictEqual(ch.imageCalls.length, 0);
  assert.strictEqual(d.says.length, 0);
});

test('_deliverFiles: 只投递 SendUserFile 且 result.success===true 的条目', async () => {
  const ch = fakeFileChannel();
  const d = mkDispatcher(ch);
  const good = makeTmpFile('good.txt', 'ok');
  const log = [
    { tool: 'Read', result: { success: true, file: good } },          // 非 SendUserFile → 跳
    { tool: 'SendUserFile', result: { success: false, file: good } }, // 未成功 → 跳
    { tool: 'SendUserFile', result: { success: true } },              // 无路径 → 跳
    sendUserFileEntry(good),                                          // 唯一应投递
  ];
  await d._deliverFiles(MSG, { toolCallLog: log });
  assert.strictEqual(ch.fileCalls.length, 1, '只应投递一条合格条目');
});

test('_deliverFiles: 多文件时单个失败不影响其余(fail-soft 且继续)', async () => {
  // 第一个 sendFile 失败,第二个成功。
  const ch = fakeFileChannel({ fileResult: (n) => (n === 1 ? { ok: false, error: '失败' } : { ok: true, sent: 1 }) });
  const d = mkDispatcher(ch);
  const p1 = makeTmpFile('one.txt', 'a');
  const p2 = makeTmpFile('two.txt', 'b');
  await d._deliverFiles(MSG, { toolCallLog: [sendUserFileEntry(p1), sendUserFileEntry(p2)] });
  assert.strictEqual(ch.fileCalls.length, 2, '第一个失败不能中断第二个');
  assert.strictEqual(d.says.length, 1, '仅第一个失败发一条告知');
  assert.ok(/发送失败/.test(d.says[0]));
});
