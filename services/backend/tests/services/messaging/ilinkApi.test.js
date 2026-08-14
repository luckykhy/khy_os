'use strict';

/**
 * ilinkApi.getUploadUrl 离线单测(node:test 运行器)。
 *
 * 只验薄 IO 层的报文契约:getUploadUrl 必须按真实协议发出完整字段(缺一微信恒返回
 * ret:-2),且带鉴权三件套头。全程离线:global.fetch 以桩替身注入,不触网。
 */

const { test } = require('node:test');
const assert = require('node:assert');

const core = require('../../../src/services/messaging/ilinkCore');
const { IlinkApi } = require('../../../src/services/messaging/ilinkApi');

/** 装一个假的全局 fetch,记录一次调用并返回 2xx JSON。返回 {calls, restore}。 */
function installFetch(json = { ret: 0, upload_param: 'UP' }) {
  const original = global.fetch;
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      async json() { return json; },
      async text() { return JSON.stringify(json); },
    };
  };
  return { calls, restore: () => { global.fetch = original; } };
}

test('getUploadUrl: 发出完整报文体 —— filekey/media_type/to_user_id/rawsize/rawfilemd5/filesize/aeskey/no_need_thumb/base_info', async () => {
  const { calls, restore } = installFetch();
  try {
    const api = new IlinkApi({ botToken: 'tok_xyz' });
    const resp = await api.getUploadUrl({
      filekey: 'a'.repeat(32),
      mediaType: 1,
      toUserId: 'u-9',
      rawsize: 17,
      rawfilemd5: 'b'.repeat(32),
      filesize: 32,
      aeskey: 'c'.repeat(32),
    });
    assert.strictEqual(resp.ret, 0);
    assert.strictEqual(resp.upload_param, 'UP');

    assert.strictEqual(calls.length, 1);
    const { url, init } = calls[0];
    assert.ok(url.endsWith('/ilink/bot/getuploadurl'), `路径应为 getuploadurl:${url}`);
    assert.strictEqual(init.method, 'POST');

    const body = JSON.parse(init.body);
    assert.strictEqual(body.filekey, 'a'.repeat(32));
    assert.strictEqual(body.media_type, 1, 'media_type 必须是数字编码(1=图片)');
    assert.strictEqual(body.to_user_id, 'u-9');
    assert.strictEqual(body.rawsize, 17);
    assert.strictEqual(body.rawfilemd5, 'b'.repeat(32));
    assert.strictEqual(body.filesize, 32);
    assert.strictEqual(body.aeskey, 'c'.repeat(32));
    assert.strictEqual(body.no_need_thumb, true, '默认 no_need_thumb=true');
    assert.deepStrictEqual(body.base_info, { channel_version: core.CHANNEL_VERSION }, '缺 base_info 发不出');

    // 鉴权三件套头(缺一不可)。
    assert.strictEqual(init.headers.Authorization, 'Bearer tok_xyz');
    assert.strictEqual(init.headers.AuthorizationType, 'ilink_bot_token');
    assert.ok(init.headers['X-WECHAT-UIN'], 'X-WECHAT-UIN 必须存在');
  } finally {
    restore();
  }
});

test('getUploadUrl: 字段缺失 —— 退化成空串/0/默认,绝不发出 undefined', async () => {
  const { calls, restore } = installFetch();
  try {
    const api = new IlinkApi({ botToken: 'tok' });
    await api.getUploadUrl({ noNeedThumb: false });
    const body = JSON.parse(calls[0].init.body);
    assert.strictEqual(body.filekey, '');
    assert.strictEqual(body.media_type, 0);
    assert.strictEqual(body.to_user_id, '');
    assert.strictEqual(body.rawsize, 0);
    assert.strictEqual(body.rawfilemd5, '');
    assert.strictEqual(body.filesize, 0);
    assert.strictEqual(body.aeskey, '');
    assert.strictEqual(body.no_need_thumb, false, 'noNeedThumb 显式 false 应尊重');
  } finally {
    restore();
  }
});
