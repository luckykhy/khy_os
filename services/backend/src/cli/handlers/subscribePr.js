'use strict';

/**
 * subscribePr.js — `/subscribe-pr` 命令薄壳:订阅某 PR/分支的 CI 状态,达到终态时推送通知。对齐 Claude Code 的
 * /subscribe-pr(订阅云端 PR review/CI 推送),但**诚实落到 khy 的本地语义**:不伪造云端推送服务端,而是复用
 * getDataDir 持久订阅列表 + ciStatusService.checkCIStatus 本地读 CI(gh/glab)+ 既有 PushNotify 推送通道。
 *
 * **背后逻辑**(PR 引用解析 + 该不该通知判定 + 去抖 + 文本渲染)在纯叶子 services/subscribePr/subscribePrPlan.js
 * (单一真源·零 IO);本薄壳只做:门控、读写订阅(subscribePrStore)、轮询 CI(委托 ciStatusService)、发推送
 * (委托 PushNotify 工具,与模型调用同源含 SSRF 守卫 + 脱敏)、渲染。绝不另起炉灶,绝不写任何 host/token 硬编码。
 *
 * 诚实边界:khy 无常驻后台轮询 —— 通知发生在显式 `check` 时;仅 CI 终态(成功/失败)且与上次不同才通知(去抖);
 * 推送目标沿用 `khy notify set` 配置,未配则如实提示;PR 号仅作 CI 查询线索,绝不远程改动他人 PR。
 *
 * 用法:`/subscribe-pr [<pr-ref> | list | check | unsubscribe <ref> | help]`(空参 = list)。
 * 门控 KHY_SUBSCRIBE_PR 默认开;关 → 命令不接管(字节回退)。
 */

const { printInfo, printError } = require('../formatters');
const leaf = require('../../services/subscribePr/subscribePrPlan');
const store = require('../../services/subscribePr/subscribePrStore');

// try/catch combinator 单一真源 utils/tryOr:执行 fn,任何异常 → dflt。
const _safe = require('../../utils/tryOr');
// async try/catch combinator 单一真源 utils/tryOrAsync:await fn,任何异常 → dflt。
const _safeAsync = require('../../utils/tryOrAsync');

/** 轮询单条订阅的 CI(委托 ciStatusService;按分支线索查询)。 */
function _checkCi(subscription) {
  const ci = _safe(() => require('../../services/ciStatusService'), null);
  if (!ci || typeof ci.checkCIStatus !== 'function') return { error: 'CI 服务不可用' };
  const options = {};
  if (subscription && subscription.branch) options.branch = subscription.branch;
  return _safe(() => ci.checkCIStatus(options), { error: 'CI 查询失败' });
}

/** 推送是否已配置(委托 pushConfigStore)。 */
function _pushConfigured() {
  const cfgStore = _safe(() => require('../../services/pushConfigStore'), null);
  if (!cfgStore || typeof cfgStore.isConfigured !== 'function') return false;
  return _safe(() => cfgStore.isConfigured(), false) === true;
}

/** 发推送(委托既有 PushNotify 工具,与模型调用同源)。 */
async function _sendPush(title, body) {
  const tool = _safe(() => require('../../tools/PushNotify'), null);
  if (!tool || typeof tool.execute !== 'function') return { success: false, error: '推送工具不可用' };
  return _safeAsync(() => tool.execute({ title, body }), { success: false, error: '推送执行失败' });
}

/** 执行一次 check:轮询所有订阅,按叶子决策去抖通知,更新 lastClassification。 */
async function _runCheck() {
  const subs = _safe(() => store.readAll(), []) || [];
  const pushConfigured = _pushConfigured();
  const outcomes = [];
  for (const sub of subs) {
    const ciResult = _checkCi(sub);
    const decision = leaf.decideNotify({ ciResult, lastClassification: sub.lastClassification });
    let notified = false;
    let pushError = null;
    if (decision.shouldNotify) {
      if (pushConfigured) {
        const { title, body } = leaf.buildNotification(sub, decision);
        const res = await _sendPush(title, body);
        notified = !!(res && res.success);
        if (!notified) pushError = (res && res.error) || '未知错误';
      } else {
        pushError = '未配置推送';
      }
    }
    // 始终更新 lastClassification 以便下次去抖(best-effort)。
    _safe(() => store.updateClassification(sub.key, decision.classification), false);
    outcomes.push({ key: sub.key, decision, ciResult, notified, pushError });
  }
  return { outcomes, pushConfigured };
}

/**
 * `/subscribe-pr` 入口。
 * @param {string} _subCommand
 * @param {string[]} [args]
 * @param {object} [_options]
 * @returns {Promise<boolean>} 是否接管该命令(门控关 → false)。
 */
async function handleSubscribePr(_subCommand, args = [], _options = {}) {
  if (!leaf.isEnabled(process.env)) {
    printInfo('subscribe-pr 命令未启用(KHY_SUBSCRIBE_PR 为关)。');
    return false;
  }

  const parsed = leaf.parseSubscribeArgs(args);

  if (parsed.action === 'help') {
    printInfo(leaf.buildHelpText());
    return true;
  }
  if (!parsed.valid) {
    printError(leaf.buildUnknownText());
    return true;
  }

  if (parsed.action === 'list') {
    const subs = _safe(() => store.readAll(), []) || [];
    printInfo(leaf.buildListText(subs));
    return true;
  }

  if (parsed.action === 'subscribe') {
    const ref = leaf.parsePrRef(parsed.ref);
    const claimedAt = new Date().toISOString();
    const descriptor = leaf.buildSubscriptionDescriptor({ ref, subscribedAt: claimedAt });
    const { added } = _safe(() => store.upsert(descriptor), { added: false });
    if (added) {
      printInfo(leaf.buildSubscribeText(descriptor));
    } else {
      printInfo(`🔔 subscribe-pr · ${descriptor.key} 已在订阅中(无变化)。`);
    }
    return true;
  }

  if (parsed.action === 'unsubscribe') {
    const ref = leaf.parsePrRef(parsed.ref);
    const { removed } = _safe(() => store.remove(ref.key), { removed: false });
    printInfo(leaf.buildUnsubscribeText(ref.key, removed));
    return true;
  }

  // check
  const { outcomes, pushConfigured } = await _runCheck();
  printInfo(leaf.buildCheckText(outcomes, { pushConfigured }));
  return true;
}

module.exports = { handleSubscribePr };
