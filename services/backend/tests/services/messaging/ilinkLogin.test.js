'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 隔离数据家 + 把轮询间隔压到 1ms,让测试不用真等 3 秒。
// 两者都必须在 require 被测模块之前设置(常量在 require 时求值)。
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'khyos-ilinklogin-'));
process.env.KHYOS_HOME = TMP_HOME;
process.env.KHY_ILINK_QR_POLL_INTERVAL_MS = '1';

const login = require('../../../src/services/messaging/ilinkLogin');
const store = require('../../../src/services/messaging/ilinkAccountStore');

const QR_OK = { ret: 0, qrcode: 'qr-123', qrcode_img_content: 'https://liteapp.weixin.qq.com/q/7GiQu1' };
const CONFIRMED = {
  ret: 0,
  status: 'confirmed',
  bot_token: 'tok_abcdefghij0123456789',
  ilink_bot_id: 'bot-1',
  ilink_user_id: 'user-1',
  baseurl: 'https://ilinkai.weixin.qq.com',
};

let realFetch;
let calls;

/**
 * 用一串预设应答替掉 global fetch。
 * @param {Array<object|Error>} script 按调用顺序返回;Error 则抛(模拟网络故障)
 */
function stubFetch(script) {
  calls = [];
  let i = 0;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const item = script[Math.min(i, script.length - 1)];
    i++;
    if (item instanceof Error) throw item;
    return { ok: true, status: 200, json: async () => item };
  };
}

beforeEach(() => {
  realFetch = globalThis.fetch;
  try { fs.rmSync(store._credFile(), { force: true }); } catch { /* ignore */ }
});

afterEach(() => { globalThis.fetch = realFetch; });

test('requestQrCode: ret=0 → 取出 qrcodeId 与待扫 URL', async () => {
  stubFetch([QR_OK]);
  const r = await login.requestQrCode();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.qrcodeId, 'qr-123');
  assert.strictEqual(r.qrcodeUrl, QR_OK.qrcode_img_content);
  assert.ok(calls[0].includes('get_bot_qrcode'), '应打取码接口');
  assert.ok(calls[0].includes(`bot_type=${login.BOT_TYPE}`), `bot_type 必须是 ${login.BOT_TYPE}`);
});

test('requestQrCode: 非 0 ret 把服务端 retmsg 原样透出,不自己编错误', async () => {
  stubFetch([{ ret: -1, retmsg: '当前版本不支持' }]);
  const r = await login.requestQrCode();
  assert.strictEqual(r.ok, false);
  assert.ok(r.error.includes('当前版本不支持'), `应带上服务端原话,实际:${r.error}`);
});

test('requestQrCode: 网络异常 fail-soft,绝不抛', async () => {
  stubFetch([new Error('ECONNREFUSED')]);
  const r = await login.requestQrCode();
  assert.strictEqual(r.ok, false);
  assert.ok(r.error.includes('ECONNREFUSED'));
});

test('_accountFromConfirmed: 字段齐全 → 账号结构;可信 baseUrl 才采纳', () => {
  const a = login._accountFromConfirmed(CONFIRMED);
  assert.strictEqual(a.botToken, CONFIRMED.bot_token);
  assert.strictEqual(a.accountId, 'bot-1');
  assert.strictEqual(a.userId, 'user-1');
  assert.strictEqual(a.baseUrl, CONFIRMED.baseurl, '白名单内应采纳');

  // 服务端下发的恶意 baseurl 必须被丢弃(留空 → IlinkApi 用默认值)
  const evil = login._accountFromConfirmed({ ...CONFIRMED, baseurl: 'https://attacker.com' });
  assert.strictEqual(evil.baseUrl, '', '不可信 baseurl 必须留空');
  const httpOnly = login._accountFromConfirmed({ ...CONFIRMED, baseurl: 'http://ilinkai.weixin.qq.com' });
  assert.strictEqual(httpOnly.baseUrl, '', 'http 必须拒绝');

  // 缺必要字段 → null
  for (const k of ['bot_token', 'ilink_bot_id', 'ilink_user_id']) {
    const partial = { ...CONFIRMED }; delete partial[k];
    assert.strictEqual(login._accountFromConfirmed(partial), null, `缺 ${k} 应为 null`);
  }
  assert.strictEqual(login._accountFromConfirmed(null), null);
});

test('login: wait → scaned → confirmed 全流程,凭据落盘', async () => {
  stubFetch([QR_OK, { ret: 0, status: 'wait' }, { ret: 0, status: 'scaned' }, CONFIRMED]);
  const qrShown = [];
  const statuses = [];
  const r = await login.login({
    onQr: (info) => qrShown.push(info),
    onStatus: (s) => statuses.push(s),
  });

  assert.strictEqual(r.ok, true, `期望成功,实际:${r.error}`);
  assert.strictEqual(r.account.accountId, 'bot-1');
  assert.ok(!r.account.preview.includes(CONFIRMED.bot_token), 'preview 须脱敏');
  assert.strictEqual(qrShown.length, 1, '只应展示一张码');
  assert.strictEqual(qrShown[0].attempt, 1);
  assert.ok(statuses.some((s) => s.includes('已扫码')), '扫码后应提示待确认');
  // 真正落盘了
  assert.strictEqual(store.getAccount().botToken, CONFIRMED.bot_token);
});

test('login: 单次查询失败不致命,继续轮询', async () => {
  stubFetch([QR_OK, new Error('socket hang up'), CONFIRMED]);
  const r = await login.login({});
  assert.strictEqual(r.ok, true, '网络抖动应被容忍');
});

test('login: 二维码过期自动换一张', async () => {
  stubFetch([QR_OK, { ret: 0, status: 'expired' }, QR_OK, CONFIRMED]);
  const qrShown = [];
  const statuses = [];
  const r = await login.login({ onQr: (i) => qrShown.push(i), onStatus: (s) => statuses.push(s) });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(qrShown.length, 2, '应换过一张码');
  assert.strictEqual(qrShown[1].attempt, 2);
  assert.ok(statuses.some((s) => s.includes('过期')));
});

test('login: 连续过期到上限后放弃(不无限刷码)', async () => {
  // 每次取码成功,状态恒为 expired
  stubFetch([QR_OK, { ret: 0, status: 'expired' }, QR_OK, { ret: 0, status: 'expired' },
    QR_OK, { ret: 0, status: 'expired' }, QR_OK, { ret: 0, status: 'expired' }]);
  const qrShown = [];
  const r = await login.login({ onQr: (i) => qrShown.push(i) });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(qrShown.length, login.MAX_QR_REFRESH, `应恰好试 ${login.MAX_QR_REFRESH} 张`);
  assert.ok(r.error.includes('过期'), `错误应说明原因:${r.error}`);
});

test('login: 已知失败状态透出服务端原话(未灰度等)', async () => {
  stubFetch([QR_OK, { ret: 0, status: 'not_support', retmsg: '当前微信版本不支持该功能' }]);
  const r = await login.login({});
  assert.strictEqual(r.ok, false);
  assert.ok(r.error.includes('当前微信版本不支持该功能'), `应原样透出:${r.error}`);
});

test('login: confirmed 但字段缺失 → 明确报错而不是落个残缺账号', async () => {
  const partial = { ...CONFIRMED }; delete partial.bot_token;
  stubFetch([QR_OK, partial]);
  const r = await login.login({});
  assert.strictEqual(r.ok, false);
  assert.ok(r.error.includes('缺少'), `实际:${r.error}`);
  assert.strictEqual(store.getAccount(), null, '不得落盘残缺凭据');
});

test('login: signal 取消能立刻退出', async () => {
  stubFetch([QR_OK, { ret: 0, status: 'wait' }]);
  const ac = new AbortController();
  // 展示二维码的那一刻就取消,模拟用户按 Ctrl-C。
  const r = await login.login({ signal: ac.signal, onQr: () => ac.abort() });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, '已取消');
  // 用已 abort 的 signal 进入时也应直接返回
  const ac2 = new AbortController();
  ac2.abort();
  const r2 = await login.login({ signal: ac2.signal });
  assert.strictEqual(r2.ok, false);
  assert.strictEqual(r2.error, '已取消');
});

test('renderQrToTerminal: 能出字符画;失败回 null 而不抛', async () => {
  const art = await login.renderQrToTerminal('https://example.com/q/abc');
  // qrcode 依赖存在则应出图;不存在则 null——两种都不能抛。
  if (art !== null) assert.ok(art.length > 0);
  assert.strictEqual(await login.renderQrToTerminal(''), null, '空 URL 应 fail-soft');
});

// ── 二维码尺寸 ───────────────────────────────────────────────────────────────

test('measureQrArt: 剥掉 ANSI 后量真实可见尺寸', () => {
  const ESC = String.fromCharCode(27);
  const colored = `${ESC}[47m  ${ESC}[40m  ${ESC}[0m\n${ESC}[47m    ${ESC}[0m`;
  const m = login.measureQrArt(colored);
  assert.strictEqual(m.rows, 2);
  assert.strictEqual(m.cols, 4, `含色彩码时必须只算可见字符,实际 ${m.cols}`);
  // 直接取 length 会得到被转义码污染的假宽度 —— 那正是本函数存在的理由。
  assert.ok(colored.split('\n')[0].length > 4);
  assert.deepStrictEqual(login.measureQrArt(''), { rows: 0, cols: 0 });
  assert.deepStrictEqual(login.measureQrArt(null), { rows: 0, cols: 0 });
});

test('renderQrToTerminal: 纠错等级是唯一的尺寸杠杆,L 比 M 更紧凑', async () => {
  const url = 'https://liteapp.weixin.qq.com/q/7GiQu1?q=' + 'a'.repeat(46);
  const l = await login.renderQrToTerminal(url, { errorCorrectionLevel: 'L' });
  const h = await login.renderQrToTerminal(url, { errorCorrectionLevel: 'H' });
  if (!l || !h) return;                                  // qrcode 依赖缺失 → 跳过
  const ml = login.measureQrArt(l);
  const mh = login.measureQrArt(h);
  assert.ok(ml.rows > 0 && ml.cols > 0);
  assert.ok(ml.rows < mh.rows, `L(${ml.rows}行) 应比 H(${mh.rows}行) 矮`);
  assert.ok(ml.cols < mh.cols, `L(${ml.cols}列) 应比 H(${mh.cols}列) 窄`);
});

test('renderQrToTerminal: 非法纠错等级回落到 L,不抛', async () => {
  const art = await login.renderQrToTerminal('https://example.com/q/abc', { errorCorrectionLevel: 'ZZZ' });
  if (art === null) return;
  assert.ok(login.measureQrArt(art).rows > 0, '非法等级应回落而不是渲染失败');
});

test('renderQrToTerminal: 尺寸在合理范围(防止某次改动把码撑爆)', async () => {
  const art = await login.renderQrToTerminal('https://liteapp.weixin.qq.com/q/7GiQu1?q=' + 'x'.repeat(46));
  if (art === null) return;
  const { rows, cols } = login.measureQrArt(art);
  // 实测 L 档 89 字符 URL 是 20×39;留出余量但守住上限,免得哪天默认值被改成 H(28×55)
  // 或有人去掉 small 模式(行数直接翻倍)而没人发现。
  assert.ok(rows <= 26, `二维码不该超过 26 行,实际 ${rows}`);
  assert.ok(cols <= 46, `二维码不该超过 46 列,实际 ${cols}(80 列终端要放得下并留出居中余量)`);
});
