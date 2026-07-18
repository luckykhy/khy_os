'use strict';

/**
 * subscribePrPlan.js — `/subscribe-pr`(订阅某 PR/分支的 CI 状态,达到终态时推送通知)的零 IO 确定性单一真源(纯叶子)。
 *
 * 契约 (CONTRACT): 零 IO、确定性、绝不抛、无副作用;订阅列表、CI 轮询结果、env 全经入参注入,本叶子绝不读
 * process.env、绝不触文件、绝不开网络、绝不调 Date。真正的「持久化订阅列表」「轮询 CI(gh/glab)」「发推送」(有
 * fs/网络 IO)都在薄壳 store/handler,委托既有 getDataDir 原子写 + ciStatusService.checkCIStatus +
 * PushNotify/pushNotifyCore,绝不另起炉灶。本叶子只做:PR 引用解析 + 由「CI 轮询结果 vs 上次记录的分类」推导该不该
 * 通知 + 构造待持久化订阅描述符 + 文本渲染。
 *
 * 背后的逻辑(对齐 Claude Code /subscribe-pr —— 但**诚实落到 khy 的本地语义**):CC 的 /subscribe-pr 把当前会话订阅到
 * **云端 PR review/CI 状态推送**(绑 github.com OAuth,服务端在 PR 有评审/CI 结果时回推)。khy **没有那个云端推送服务端
 * —— 绝不伪造一个云订阅**;但 khy **真有**同构本地基质:① `getDataDir` 给持久订阅列表一个落点,② `ciStatusService`
 * 本地用 gh/glab 读 CI 状态,③ `pushNotifyCore`/PushNotify 既有推送通道(ntfy/bark/discord/slack/webhook)。把它们一合,
 * khy 的 /subscribe-pr = **本地持久订阅某 PR/分支 + `check` 时本地轮询 CI + 状态变为终态(成功/失败)时经既有推送通道发一条
 * 通知**,而非伪造一条不存在的云回推链路。
 *
 * 诚实边界(刻意不编造 khy 没有的能力):① **khy 无常驻后台守护轮询** —— 通知发生在用户(或调度器)显式 `check` 时,
 * 而非云端实时回推;如实说明。② 仅当 CI 分类为**终态(pass/fail)且与上次记录不同**才通知(去抖,绝不重复轰炸)。
 * ③ 推送目标/服务商沿用既有 `khy notify set` 配置,**绝不**在此写死任何 host/token;未配推送时如实提示去配置。
 * ④ PR 号仅作 CI 查询的分支/PR 线索透传,**绝不**远程改动他人 PR。
 *
 * 注意:本文件刻意不在注释里书写 require-调用样式,避免架构债扫描器把它当成幽灵依赖边。本叶子零依赖。
 */

const _LIST_WORDS = new Set(['list', 'ls', '列出', '列表']);
const _CHECK_WORDS = new Set(['check', 'poll', 'refresh', '检查', '轮询', '刷新']);
const _UNSUB_WORDS = new Set(['unsubscribe', 'remove', 'rm', 'off', 'del', 'delete', '取消', '退订', '删除']);
const _HELP_WORDS = new Set(['help', '-h', '--help', '帮助', '用法']);

/** CI 终态分类(仅这些才触发通知)。 */
const _TERMINAL = new Set(['pass', 'fail']);

/**
 * 解析 `/subscribe-pr [<pr-ref> | list | check | unsubscribe <ref> | help]`。
 * 第一个 token 是已知动作词 → 该动作;否则视为待订阅的 PR 引用 → action='subscribe'。空参 = list。
 * @param {string[]} args
 * @returns {{action:'subscribe'|'list'|'check'|'unsubscribe'|'help', ref:(string|null), valid:boolean, parseError:(string|null)}}
 */
function parseSubscribeArgs(args) {
  const list = Array.isArray(args) ? args.map((a) => String(a == null ? '' : a).trim()).filter(Boolean) : [];
  if (list.length === 0) return { action: 'list', ref: null, valid: true, parseError: null };
  const first = list[0].toLowerCase();
  if (_HELP_WORDS.has(first)) return { action: 'help', ref: null, valid: true, parseError: null };
  if (_LIST_WORDS.has(first)) return { action: 'list', ref: null, valid: true, parseError: null };
  if (_CHECK_WORDS.has(first)) return { action: 'check', ref: list[1] || null, valid: true, parseError: null };
  if (_UNSUB_WORDS.has(first)) {
    const ref = list[1] || null;
    if (!ref) return { action: 'unsubscribe', ref: null, valid: false, parseError: 'missing_ref' };
    return { action: 'unsubscribe', ref, valid: true, parseError: null };
  }
  // 否则首 token 即 PR 引用 → 订阅。
  return { action: 'subscribe', ref: list[0], valid: true, parseError: null };
}

/**
 * 解析 PR 引用:`owner/repo#N`、`#N`、`N`、或裸分支名。纯词法,零 IO。
 * @param {string} ref
 * @returns {{ raw:string, owner:(string|null), repo:(string|null), number:(number|null), branch:(string|null), key:string }}
 */
function parsePrRef(ref) {
  const raw = String(ref == null ? '' : ref).trim();
  if (raw === '') return { raw: '', owner: null, repo: null, number: null, branch: null, key: '' };
  // owner/repo#N
  let m = raw.match(/^([^/\s]+)\/([^#\s]+)#(\d+)$/);
  if (m) {
    return { raw, owner: m[1], repo: m[2], number: Number(m[3]), branch: null, key: `${m[1]}/${m[2]}#${m[3]}` };
  }
  // #N 或 N
  m = raw.match(/^#?(\d+)$/);
  if (m) {
    return { raw, owner: null, repo: null, number: Number(m[1]), branch: null, key: `#${m[1]}` };
  }
  // 其余按分支名
  return { raw, owner: null, repo: null, number: null, branch: raw, key: raw };
}

/**
 * 构造待持久化的订阅描述符。纯:调用方注入 subscribedAt(ISO 串),叶子保持无时钟。
 * @param {object} args - { ref:<parsed>, subscribedAt }
 */
function buildSubscriptionDescriptor({ ref, subscribedAt } = {}) {
  const p = ref && typeof ref === 'object' ? ref : parsePrRef(ref);
  return {
    key: p.key,
    raw: p.raw,
    owner: p.owner,
    repo: p.repo,
    number: p.number,
    branch: p.branch,
    lastClassification: null,
    subscribedAt: subscribedAt == null ? null : String(subscribedAt),
  };
}

/**
 * 由「CI 轮询结果 + 上次记录的分类」推导该不该通知。
 * 仅当分类为终态(pass/fail)且与上次不同才通知(去抖)。
 * @param {object} input - { ciResult:{classification,...}, lastClassification }
 * @returns {{ classification:string, terminal:boolean, changed:boolean, shouldNotify:boolean }}
 */
function decideNotify(input) {
  const src = input && typeof input === 'object' ? input : {};
  const ci = src.ciResult && typeof src.ciResult === 'object' ? src.ciResult : {};
  const classification = typeof ci.classification === 'string' ? ci.classification : 'unknown';
  const terminal = _TERMINAL.has(classification);
  const changed = classification !== src.lastClassification;
  return { classification, terminal, changed, shouldNotify: terminal && changed };
}

/** 构造推送通知的 {title, body}(交薄壳的 PushNotify 发送;纯文本,不含敏感信息)。 */
function buildNotification(subscription, decision) {
  const s = subscription && typeof subscription === 'object' ? subscription : {};
  const d = decision && typeof decision === 'object' ? decision : {};
  const ok = d.classification === 'pass';
  const title = `CI ${ok ? '✅ 通过' : '❌ 失败'} — ${s.key || s.raw || 'PR'}`;
  const body = `订阅 ${s.key || s.raw || ''} 的 CI 状态变为「${d.classification}」。`;
  return { title, body };
}

// ── 文本渲染 ──────────────────────────────────────────────────────────────
function buildSubscribeText(subscription) {
  const s = subscription && typeof subscription === 'object' ? subscription : {};
  return [
    `🔔 subscribe-pr · 已订阅 ${s.key || s.raw}`,
    '  说明: khy 无常驻后台轮询 —— 用 `/subscribe-pr check` 显式拉取 CI 状态;变为终态(成功/失败)时经既有推送通道通知。',
    '  (推送目标沿用 `khy notify set <provider> <target>` 配置;未配则 check 时如实提示。)',
  ].join('\n');
}

function buildListText(subscriptions) {
  const list = Array.isArray(subscriptions) ? subscriptions.filter((x) => x && typeof x === 'object') : [];
  const lines = ['🔔 subscribe-pr · 当前订阅'];
  if (list.length === 0) {
    lines.push('  暂无订阅(用 `/subscribe-pr <owner/repo#N | #N | 分支>` 订阅)。');
    return lines.join('\n');
  }
  for (const s of list) {
    const last = s.lastClassification ? ` · 上次 CI: ${s.lastClassification}` : ' · 尚未 check';
    lines.push(`  · ${s.key || s.raw}${last}`);
  }
  lines.push(`  共 ${list.length} 个订阅。用 \`/subscribe-pr check\` 拉取最新 CI 状态。`);
  return lines.join('\n');
}

function buildUnsubscribeText(ref, removed) {
  if (removed) return `🔔 subscribe-pr · 已退订 ${ref}。`;
  return `🔔 subscribe-pr · 未找到订阅 ${ref}(用 \`/subscribe-pr list\` 查看现有订阅)。`;
}

/**
 * 渲染一次 check 的结果汇总。
 * @param {Array<object>} outcomes - [{ key, decision, ciResult, notified, pushError }]
 * @param {object} [opts] - { pushConfigured }
 */
function buildCheckText(outcomes, opts) {
  const list = Array.isArray(outcomes) ? outcomes : [];
  const o = opts && typeof opts === 'object' ? opts : {};
  const lines = ['🔔 subscribe-pr · CI 轮询结果'];
  if (list.length === 0) {
    lines.push('  暂无订阅可检查(先订阅一个 PR/分支)。');
    return lines.join('\n');
  }
  for (const item of list) {
    const it = item && typeof item === 'object' ? item : {};
    const cls = (it.decision && it.decision.classification) || 'unknown';
    let suffix = '';
    if (it.notified) suffix = ' → 已推送通知';
    else if (it.decision && it.decision.shouldNotify && it.pushError) suffix = ` → 应通知但推送失败(${it.pushError})`;
    else if (it.decision && it.decision.terminal && !it.decision.changed) suffix = ' → 终态但无变化,不重复通知';
    lines.push(`  · ${it.key}: ${cls}${suffix}`);
  }
  if (o.pushConfigured === false) {
    lines.push('  提示: 尚未配置推送,达到终态也无法通知。先 `khy notify set <provider> <target>`。');
  }
  return lines.join('\n');
}

function buildHelpText() {
  return [
    '/subscribe-pr —— 订阅某 PR/分支的 CI 状态,达到终态时推送通知(对齐 Claude Code /subscribe-pr,但诚实落到 khy 本地语义)',
    '  用法:',
    '    /subscribe-pr <owner/repo#N | #N | 分支>   订阅一个 PR/分支',
    '    /subscribe-pr list                          列出当前订阅(默认)',
    '    /subscribe-pr check                         本地轮询所有订阅的 CI;变终态(成功/失败)时推送通知',
    '    /subscribe-pr unsubscribe <ref>             退订',
    '  说明:',
    '    · 与 CC 绑 github.com OAuth 的云端实时回推不同:khy 无云端推送服务端,不伪造云订阅。',
    '    · khy 本地持久订阅 + 显式 check 时用 gh/glab 读 CI + 经既有推送通道(ntfy/bark/discord/slack/webhook)通知。',
    '    · 无常驻后台轮询;仅当 CI 为终态且与上次不同才通知(去抖)。推送目标沿用 `khy notify set`,绝不在此写死。',
  ].join('\n');
}

function buildUnknownText() {
  return `用法有误。${buildHelpText()}`;
}

/**
 * 门控 KHY_SUBSCRIBE_PR(默认开;关时薄壳字节回退为「不接管」)。
 * @param {object} env
 * @returns {boolean}
 */
function isEnabled(env) {
  const e = env || {};
  const raw = e.KHY_SUBSCRIBE_PR === undefined ? 'true' : e.KHY_SUBSCRIBE_PR;
  const s = String(raw == null ? '' : raw).trim().toLowerCase();
  return !(s === '' || s === '0' || s === 'false' || s === 'off' || s === 'no');
}

module.exports = {
  parseSubscribeArgs,
  parsePrRef,
  buildSubscriptionDescriptor,
  decideNotify,
  buildNotification,
  buildSubscribeText,
  buildListText,
  buildUnsubscribeText,
  buildCheckText,
  buildHelpText,
  buildUnknownText,
  isEnabled,
};
