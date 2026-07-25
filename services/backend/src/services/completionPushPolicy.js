'use strict';

/**
 * completionPushPolicy.js — 纯叶子:决定「一个 turn / 长任务完成时,是否把一条提醒
 * 推到终端之外(用户手机/桌面)」,以及那条提醒的文案。单一真源。
 *
 * 背景(先核实再动手):khy 已有完整 off-terminal 推送基建(纯叶子 pushNotifyCore 构造服务商
 * 报文、薄 IO pushConfigStore 落 0600 配置、AI 工具 PushNotify 走 SSRF + 脱敏发出),也已有
 * turn 完成时的**终端内** BEL 提示(useQueryBridge `_ringCompletionBellIfDue`,门控 KHY_BELL_ON_DONE,
 * 阈值 KHY_BELL_MIN_MS)。**真缺口不是机制缺失,而是缺接线**:completion 事件从不触发 off-terminal
 * 推送 —— 用户切走后,长任务跑完只在终端里响一声 BEL(还得 TTY + 显式开),手机上什么也收不到;
 * off-terminal 推送纯靠手动 `khy notify send` 或模型自决调 PushNotify 工具。这正是 Claude Code
 * 「turn 完成 → 系统/设备通知」相对 khy 的缺口。
 *
 * 本叶子镜像 BEL 的 `shouldRingCompletionBell` 范式,只是判据多一条 `configured`(必须先配过推送目标)
 * 且阈值更高(推到手机比响铃更打扰,默认 60s,短任务不骚扰)。决策 + 文案都在此,接缝(useQueryBridge)
 * 只读判据、拿文案,fire-and-forget 复用 PushNotify 工具的 execute(SSRF + 脱敏保持单一真源)。
 *
 * 契约:零 IO、确定性(不依赖时钟/随机)、绝不抛(fail-soft)。门控 `KHY_PUSH_ON_DONE` **opt-in 默认关**
 * —— 与 BEL 一致:把消息推到用户**自己的设备**是打扰性副作用,必须用户显式开(自然语言经 nlConfig
 * 即可开,不必改文件);且只在用户**已配过**推送目标时才可能触发。
 */

const DEFAULT_MIN_MS = 60000; // 60s:比 BEL 的 10s 更高 —— 推到手机的门槛该更高。

/** opt-in 门控(镜像 KHY_BELL_ON_DONE 的真值语义:仅 1/true/on/yes 开)。 */
function isEnabled(env = process.env) {
  return /^(1|true|on|yes)$/i.test(String((env && env.KHY_PUSH_ON_DONE) || '').trim());
}

/** 触发阈值(毫秒)。非法/缺省回落 60000。 */
function minMs(env = process.env) {
  const n = parseInt(String((env && env.KHY_PUSH_ON_DONE_MIN_MS) || String(DEFAULT_MIN_MS)), 10);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_MIN_MS;
}

/**
 * 纯判据:所有输入显式传入,便于无 env/Date/TTY 单测。
 * 开 + 已配推送目标 + 本轮耗时 ≥ 阈值 → 推。
 * @param {{enabled:boolean, configured:boolean, elapsedMs:number, minMs:number}} p
 * @returns {boolean}
 */
function shouldPushOnCompletion(p) {
  const o = p || {};
  return !!o.enabled && !!o.configured && Number(o.elapsedMs) >= Number(o.minMs);
}

/** 把毫秒人性化成简短时长(确定性,无本地化时钟)。e.g. 90000 → "1m30s"。 */
function humanizeElapsed(ms) {
  const n = Math.max(0, Math.floor(Number(ms) || 0));
  const totalSec = Math.floor(n / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m < 60) return s ? `${m}m${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return mm ? `${h}h${mm}m` : `${h}h`;
}

/** 截断单行摘要,去掉换行,避免把整段输出塞进推送(确定性)。 */
function _oneLine(text, max = 140) {
  const flat = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  const lim = Math.max(16, Math.floor(Number(max)) || 140);
  return flat.length > lim ? `${flat.slice(0, lim - 1)}…` : flat;
}

/**
 * 构造 completion 推送文案(单一真源:标题/正文/优先级都在此,接缝不另写)。
 * @param {{elapsedMs?:number, ok?:boolean, summary?:string, label?:string}} info
 * @returns {{title:string, body:string, priority:string}}
 */
function buildCompletionPushMessage(info = {}) {
  const ok = info.ok !== false; // 缺省按成功
  const took = humanizeElapsed(info.elapsedMs);
  const what = _oneLine(info.label || 'khy 任务', 60);
  const title = ok ? `✅ ${what}已完成` : `⚠️ ${what}失败`;
  const parts = [];
  parts.push(ok ? `耗时 ${took},可以回到终端查看结果了。` : `耗时 ${took} 后失败,回终端看看吧。`);
  const sum = _oneLine(info.summary, 140);
  if (sum) parts.push(sum);
  return {
    title,
    body: parts.join('\n'),
    // 失败更要紧 → high;成功 → default。沿用 pushNotifyCore 的命名优先级。
    priority: ok ? 'default' : 'high',
  };
}

/** 自描述(给 CLI 帮助 / 文档 / 自检)。 */
function describeCompletionPush() {
  return {
    gate: 'KHY_PUSH_ON_DONE',
    thresholdEnv: 'KHY_PUSH_ON_DONE_MIN_MS',
    defaultMinMs: DEFAULT_MIN_MS,
    summary: '长任务/turn 完成且耗时超阈值时,自动把一条提醒推到终端之外(复用已配置的推送目标);'
      + 'opt-in 默认关,且仅在已 `khy notify set` 配过目标时才触发。',
  };
}

module.exports = {
  DEFAULT_MIN_MS,
  isEnabled,
  minMs,
  shouldPushOnCompletion,
  humanizeElapsed,
  buildCompletionPushMessage,
  describeCompletionPush,
};
