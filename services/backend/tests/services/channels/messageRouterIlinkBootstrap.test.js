'use strict';

/**
 * messageRouter._bootstrapChannels 的 ilink(微信)多账号并行拉起。
 *
 * 断言两条线:
 *   1. 有 N 个已绑定账号时,bootstrap 各起一路通道,注册名 `ilink:<accountId>`
 *      互不相同、无覆盖告警(否则名字冲突会静默替换掉前一路)。
 *   2. 无账号时跳过(向后兼容:与改造前无账号行为等价)。
 *
 * 全部离线:temp KHYOS_HOME 落真凭据,connect() 被打成 no-op —— 断言的是注册接线
 * 本身,不触网络、不起长轮询循环。
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.KHYOS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'khyos-mr-ilink-'));
process.env.KHY_MSG = 'true';           // ilinkCore.isEnabled 门:显式开,避免宿主环境干扰
delete process.env.SLACK_BOT_TOKEN;     // 避免 Slack 段抢注一路无关通道

const { MessageRouter, _bootstrapChannels } =
  require('../../../src/services/channels/messageRouter');
const { IlinkChannel } = require('../../../src/services/channels/ilinkChannel');
const store = require('../../../src/services/messaging/ilinkAccountStore');
const log = require('../../../src/utils/logger');

// connect() 会起真实长轮询;测的是注册接线,故打成 no-op 保持离线。
const _realConnect = IlinkChannel.prototype.connect;
before(() => { IlinkChannel.prototype.connect = async function () { this._connected = true; }; });
after(() => { IlinkChannel.prototype.connect = _realConnect; });

/** 临时接管 log.warn,收集告警文本,返回还原函数。 */
function captureWarn() {
  const warns = [];
  const original = log.warn;
  log.warn = (...args) => { warns.push(args.map(String).join(' ')); };
  return { warns, restore: () => { log.warn = original; } };
}

test('bootstrap: N 个已绑定账号各起一路,注册名 ilink:<id> 唯一且无覆盖告警', () => {
  store.clearAccount();                 // 清空,起点干净
  const ids = ['botA', 'botB', 'botC'];
  ids.forEach((id, i) => {
    const r = store.saveAccount({
      botToken: `tok-${id}`, accountId: id, userId: `u${i}`, baseUrl: 'https://example.invalid',
    });
    assert.strictEqual(r.ok, true, `账号 ${id} 应写入成功`);
  });

  const cap = captureWarn();
  const router = new MessageRouter();
  try {
    _bootstrapChannels(router);
  } finally {
    cap.restore();
  }

  const names = router.getChannels().map((c) => c.name).filter((n) => n.startsWith('ilink:'));
  assert.strictEqual(names.length, ids.length, `应注册 ${ids.length} 路 ilink 通道,实得 ${names.length}`);
  assert.deepStrictEqual(
    [...names].sort(),
    ids.map((id) => `ilink:${id}`).sort(),
    '注册名应为每账号唯一的 ilink:<accountId>',
  );
  assert.strictEqual(new Set(names).size, names.length, '注册名必须互不相同');
  assert.ok(
    !cap.warns.some((w) => w.includes('already registered')),
    `不应出现覆盖告警,实得:${cap.warns.join(' | ')}`,
  );
});

test('bootstrap: 无账号时跳过,不注册任何 ilink 通道(向后兼容)', () => {
  store.clearAccount();                 // 清空全部账号
  const router = new MessageRouter();
  _bootstrapChannels(router);
  const names = router.getChannels().map((c) => c.name).filter((n) => n.startsWith('ilink:'));
  assert.strictEqual(names.length, 0, '无账号时不应注册任何 ilink 通道');
});
