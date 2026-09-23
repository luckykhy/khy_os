'use strict';

/**
 * ilinkDispatchDiagnostics — IlinkDispatcher 的「描述/自述」职责簇。
 *
 * 从 ilinkDispatcher.js（原 1655 行巨石）拆出的第一簇。拆分的判据不是行数，
 * 而是**职责边界**：这三个方法只做一件事 —— 把运行时状态渲染成人读的多行文本。
 * 它们不发送、不排队、不碰会话持久化，也不改变任何状态（纯读 + 拼串）。
 *
 * 为什么值得单独成文件：
 *   ① 它们是「用户问『你现在什么状态』」的全部答案，是故障排查的第一入口；
 *   ② 它们的正确性依赖若干**微妙的口径**（见 _describeRoute 的三分法），
 *      这些口径值得有一处独立的、可注释、可单测的家，而不是埋在一个千行类里；
 *   ③ 拆出后 IlinkDispatcher 只剩「编排」职责，读起来先看得到队列/路由/权限的主干。
 *
 * 契约（与拆分前的类方法逐字节同构）：
 *   - 取 `state`（{ channel, queueLength, running }）与 `opts`，返回字符串。
 *   - 绝不抛：所有外部读取（gateway / accountStore / channel.toJSON）都在 try 里，
 *     失败退化为「取不到」的诚实措辞，而不是让 /conn /route /adapters 崩掉。
 *   - 纯读：不写任何状态。
 */

/**
 * 「连接健康」自述。
 *
 * @param {object} state
 * @param {object} [state.channel]     IlinkChannel（读 toJSON()）
 * @param {number} [state.queueLength] 队列长度
 * @param {boolean} [state.running]    是否有 1 条在处理中
 * @returns {string}
 */
function describeConnection(state = {}) {
  const lines = ['🔗 连接健康'];
  const ch = state.channel;
  const s = ch && typeof ch.toJSON === 'function' ? ch.toJSON() : {};

  lines.push(`通道:${s.connected ? '已连接' : '未连接'}`);
  if (s.accountId) {
    lines.push(`账号:${s.accountId}`);
  }
  if (s.sessionExpired) {
    lines.push('⚠️ 会话已过期 —— 需要在电脑上重新扫码:khy wx login');
  }
  if (Number(s.failures) > 0) {
    lines.push(`连续轮询失败:${s.failures} 次(正在退避重试)`);
  }
  if (s.baseUrlFellBack) {
    lines.push('注:服务端下发的 baseurl 不可信,已回落默认端点');
  }

  try {
    const store = require('../messaging/ilinkAccountStore');
    const id = s.accountId || '';
    const hb = id ? store.getHeartbeat(id) : null;
    if (hb) {
      lines.push(`心跳:${Math.round(hb.ageMs / 1000)} 秒前`);
    } else {
      lines.push('心跳:还没打过(可能刚启动)');
    }
    if (id) {
      lines.push(`轮询游标:${store.getSyncBuf(id) ? '已保存' : '空(首轮或刚重置)'}`);
    }
  } catch {
    /* fail-soft */
  }

  const qlen = Number(state.queueLength) || 0;
  lines.push(`队列:${qlen} 条等待${state.running ? '、1 条处理中' : ''}`);
  lines.push('');
  lines.push('你能收到这条,说明收发都是通的。想看模型路由发 /status。');
  return lines.join('\n');
}

/**
 * 报告路由。**严格区分「已证实」与「只是配置」**。
 *
 * 为什么要这么啰嗦:模型会照着上下文里的配置值自称身份,而真实路由在首选通道不可用时
 * 早已回落 —— 于是它会非常自信地报出一个根本没在用的模型名。但换个数据源照样能撒谎:
 * getActiveAdapter() 返回的是**启动时的选路**(env > lastVerified > 首个可用),不是
 * 实际服务了上一条请求的那个。唯一可证的是网关记的 lastSuccessAt —— 哪个通道最近真的
 * 成功答过话。所以这里三者分开列,并标明各自是什么,而不是挑一个当作事实。
 *
 * @param {object} state
 * @param {object} [state.channel]
 * @param {number} [state.queueLength]
 * @param {boolean} [state.running]
 * @param {boolean} full 是否附带通道/队列状态
 * @returns {string}
 */
function describeRoute(state = {}, full) {
  const lines = [];
  let gw = null;
  try {
    gw = require('../../../gateway/aiGateway');
  } catch {
    /* fail-soft */
  }

  // ① 已证实:最近一次真的成功答话的通道。
  let proven = null;
  try {
    const act = gw && gw._adapterActivity;
    if (act) {
      for (const key of Object.keys(act)) {
        const at = act[key] && act[key].lastSuccessAt;
        if (at && (!proven || at > proven.at)) {
          proven = { key, at };
        }
      }
    }
  } catch {
    /* fail-soft */
  }
  if (proven) {
    const ago = Math.round((Date.now() - proven.at) / 1000);
    lines.push(`✅ 最近成功答话的通道:${proven.key}(${ago} 秒前)— 这条是可证的`);
  } else {
    lines.push('尚无「已成功答话」的记录(本进程还没答过,或刚重启)。');
  }

  // ② 启动选路:注意它不等于实际服务方。
  try {
    const active = gw && typeof gw.getActiveAdapter === 'function' ? gw.getActiveAdapter() : null;
    if (active) {
      lines.push(
        `启动选路:${active.key || active.name || '未知'}` +
          `${active.activeModel ? ` / ${active.activeModel}` : ''}` +
          `${active.modelSource ? `(来源 ${active.modelSource})` : ''}`
      );
    }
  } catch {
    /* fail-soft */
  }

  // ③ 配置值:仅仅是 .env 里写了什么。
  const cfgAdapter = process.env.GATEWAY_PREFERRED_ADAPTER || '(未设)';
  const cfgModel = process.env.GATEWAY_PREFERRED_MODEL || '(未设)';
  lines.push(`配置首选:${cfgAdapter} / ${cfgModel}(只是配置,不代表在用)`);
  if (proven && cfgAdapter !== '(未设)' && cfgAdapter !== 'auto' && proven.key !== cfgAdapter) {
    lines.push(`⚠️ 首选通道 ${cfgAdapter} 没在服务,已回落到 ${proven.key}。`);
  }
  lines.push('');
  lines.push('注:模型自称的身份来自上下文里的配置值,回落时会报错。以上面「已证实」那行为准。');

  if (full) {
    lines.push('');
    const qlen = Number(state.queueLength) || 0;
    lines.push(`队列:${qlen} 条等待${state.running ? '、1 条处理中' : ''}`);
    const ch = state.channel;
    if (ch && typeof ch.toJSON === 'function') {
      const s = ch.toJSON();
      lines.push(
        `通道:${s.connected ? '已连接' : '未连接'}${s.sessionExpired ? '(会话已过期,需重新扫码)' : ''}`
      );
    }
  }
  return lines.join('\n');
}

/** 列出已连通的通道。 */
function listAdapters() {
  try {
    const gw = require('../../../gateway/aiGateway');
    const g = typeof gw.getAdapters === 'function' ? gw : gw.aiGateway || gw.default || null;
    const list = g && typeof g.getAdapters === 'function' ? g.getAdapters() : null;
    if (!Array.isArray(list) || !list.length) {
      return '取不到通道列表。';
    }
    const avail = list.filter((e) => {
      try {
        return e.enabled && e.adapter && e.adapter.detect();
      } catch {
        return false;
      }
    });
    if (!avail.length) {
      return '当前没有任何可用通道。';
    }
    return `已连通的通道:\n${avail.map((e) => `· ${e.key}`).join('\n')}`;
  } catch (e) {
    return `取通道列表失败:${(e && e.message) || e}`;
  }
}

module.exports = {
  describeConnection,
  describeRoute,
  listAdapters,
};
