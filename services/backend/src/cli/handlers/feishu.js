'use strict';

/**
 * Feishu Command Handler — `khy feishu …` 飞书接入的一个入口,两种传输方式。
 *
 * 仓里飞书有两条**可并存**的路,差别不在协议好坏,而在你的部署有没有公网入口:
 *
 *   ① 群机器人 + 事件订阅(webhook):配置落 msg.json,通道是 channels/feishuChannel,
 *      入站靠飞书把事件 POST 到本服务的 /webhooks/feishu。**需要公网可达地址**,
 *      不需要 app 凭据。这条路今天就能收发。
 *   ② 长连接(long-link):配置落 `<数据家>/im/feishu.json` 或 env,通道是
 *      adapters/im/feishuAdapter 经 channels/imAdapterChannel 接进 messageRouter。
 *      **不需要公网入口**(由客户端主动连出去),要 app 凭据;掉线自动指数退避重连。
 *
 * 两条路的入站消息都汇进 messageRouter,走同一套 AI 应答回路(msgReplyBridge),
 * 所以「接进来之后的行为」完全一致——你只需要按部署条件选传输。
 *
 *   feishu [status]              — 两条路各自的配置与在跑状态
 *   feishu config                — 长连接侧解析后的配置(端点/secret 已打码 + 每个键的来源)
 *   feishu set <k>=<v> ...       — 写配置;按键名自动落到对应的那条路(值为 - 时从 stdin 读)
 *   feishu send <会话id> <文本…>  — 立即发一条(长连接优先,没连上时走 webhook 旁路)
 *   feishu test [文本…]          — 发一条测试消息(群机器人 webhook 模式无需会话 id)
 *   feishu connect | start       — 开长连接门(KHY_IM_ADAPTERS 加入 feishu)并拉起守护进程
 *   feishu stop                  — 关长连接门并重启守护进程(其余渠道不受影响)
 *   feishu clear [mode]          — 清配置:webhook / longlink / 省略=两者
 *
 * @module handlers/feishu
 */

const { printInfo, printError, printWarn, printSuccess, printTable, printErrorPanel } = require('../formatters');

const CHANNEL = 'feishu';
const GATE = 'KHY_IM_ADAPTERS';

function _runtime() {
  return require('../../adapters/im/imRuntimeConfig');
}

function _msgStore() {
  return require('../../services/domain/messaging/messaging/msgConfigStore.js');
}

function _msgCore() {
  return require('../../services/domain/messaging/messaging/msgChannelCore.js');
}

function _feishu() {
  return require('../../adapters/im/feishuAdapter');
}

function _daemon() {
  return require('../../services/daemonManager');
}

/**
 * 群机器人/事件订阅模式的合法字段。**取 msgConfigStore 的白名单**而不在这里抄一份:
 * 抄一份就会出现「CLI 收了这个字段、store 静默丢掉」的错位。
 * @returns {string[]}
 */
function _webhookKeys() {
  const fields = _msgStore().FIELDS || {};
  return Array.isArray(fields[CHANNEL]) ? fields[CHANNEL] : [];
}

/** 长连接侧的合法字段 = 适配器 CONFIG_SPEC 的键(同理,单一真源)。 */
function _longLinkKeys() {
  return Object.keys(_feishu().CONFIG_SPEC);
}

/** 守护进程是否在跑(daemonStatus 会探活,fail-soft)。 */
async function _daemonRunning() {
  try {
    const st = await _daemon().daemonStatus();
    return !!(st && st.running);
  } catch {
    return false;
  }
}

/** 当前 KHY_IM_ADAPTERS 里的渠道列表(小写去重)。 */
function _gateList(env = process.env) {
  return String((env && env[GATE]) || '')
    .split(/[,;\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function _readStdinValue() {
  try {
    return String(require('fs').readFileSync(0, 'utf-8') || '').replace(/\r?\n$/, '');
  } catch {
    return '';
  }
}

// ── status ───────────────────────────────────────────────────────────────

async function _handleStatus() {
  const rows = [];

  // ① webhook 模式。getPlatform 返回的是**明文**(供发请求用),展示前必须打码。
  const wcfg = _msgStore().getPlatform(CHANNEL);
  rows.push([
    '① 群机器人/事件订阅',
    wcfg ? '已配置' : '未配置',
    wcfg ? _msgCore().maskWebhook(wcfg.webhook) : '-',
    wcfg ? '收:把 /webhooks/feishu 配到飞书后台' : '配置:khy feishu set webhook=<url>',
  ]);

  // ② 长连接模式
  const { CONFIG_SPEC } = _feishu();
  const resolved = _runtime().resolveChannelConfig(CHANNEL, CONFIG_SPEC, { env: process.env });
  const hasCreds = !!(resolved.values.accessToken || resolved.values.appSecret);
  const gateOn = _gateList().includes(CHANNEL);
  rows.push([
    '② 长连接',
    hasCreds ? (gateOn ? '已配置·门已开' : '已配置·门未开') : '未配置',
    _runtime().redactUrl(resolved.values.wsUrl || ''),
    gateOn ? '状态见 .khy/logs/daemon.log' : '开门:khy feishu connect',
  ]);

  printTable(['接入方式', '配置', '端点(打码)', '下一步'], rows);

  // 门控与守护进程:两句必须都说,沉默会被误读成「已接通」。
  try {
    if (!require('../../services/domain/messaging/messaging/msgChannelCore.js').isEnabled(process.env)) {
      printWarn('消息能力当前已关闭(KHY_MSG=off),两条路都不会收发。开启:khy msg on。');
    }
  } catch {
    /* 门控读不到就不报——不影响其余诊断 */
  }
  const running = await _daemonRunning();
  if (!running) {
    printWarn('⚠️ 守护进程未运行 —— 配好了也收不到消息。启动:khy feishu connect(或 khy daemon start)。');
  } else if (gateOn) {
    printInfo('守护进程在跑且长连接门已开:飞书通道注册名 im:feishu(与 webhook 版 feishu 并存)。');
  }
  if (resolved.notes.length) {
    resolved.notes.forEach((n) => printInfo(`· ${n}`));
  }
  return 0;
}

// ── config(解析结果 + 来源)───────────────────────────────────────────────

function _handleConfig() {
  let adapter;
  try {
    adapter = _feishu().createFeishuAdapter({ env: process.env, logger: { info() {}, warn() {} } });
  } catch (err) {
    printError(`无法解析长连接配置:${(err && err.message) || err}`);
    return 1;
  }
  const desc = adapter.describeConfig(); // 端点/secret 已打码
  const rows = Object.entries(desc)
    .filter(([k]) => k !== 'sources')
    .map(([k, v]) => [k, String(v == null ? '(未设置)' : v)]);
  printTable(['字段', '值(已打码)'], rows);
  printInfo(`来源:${desc.sources || '(无)'}`);
  printInfo('env 键名形如 KHY_IM_FEISHU_APP_SECRET;文件落 <数据家>/im/feishu.json(0600)。');
  return 0;
}

// ── set ──────────────────────────────────────────────────────────────────

function _handleSet(args) {
  const list = Array.isArray(args) ? args.slice() : [];
  const webhookKeys = _webhookKeys();
  const longKeys = _longLinkKeys();
  if (!list.length) {
    printError(
      `用法:khy feishu set <k>=<v> ...。群机器人模式字段:${webhookKeys.join(' / ')};长连接模式字段:${longKeys.join(' / ')}。值填 - 表示从 stdin 读(避免密钥进 shell 历史)。`
    );
    return 1;
  }

  const webhookFields = {};
  const longFields = {};
  const routed = [];
  for (const token of list) {
    const idx = String(token).indexOf('=');
    if (idx <= 0) {
      printError(`无法解析参数「${token}」,应为 k=v 形式(如 appId=cli_xxx)。`);
      return 1;
    }
    const key = token.slice(0, idx).trim();
    let val = token.slice(idx + 1);
    if (val === '-') {
      val = _readStdinValue();
    }
    const inWebhook = webhookKeys.includes(key);
    const inLong = longKeys.includes(key);
    if (!inWebhook && !inLong) {
      printError(
        `未知字段「${key}」。群机器人模式:${webhookKeys.join(' / ')};长连接模式:${longKeys.join(' / ')}。`
      );
      return 1;
    }
    // 两边同名的键(verificationToken)两边都写:它在两条路上是同一个飞书后台的值,
    // 只写一边会让另一条路在用户以为配好了的时候拒收事件。
    if (inWebhook) {
      webhookFields[key] = val;
    }
    if (inLong) {
      longFields[key] = val;
    }
    routed.push([key, [inWebhook ? '① webhook' : null, inLong ? '② 长连接' : null].filter(Boolean).join(' + ')]);
  }

  if (Object.keys(webhookFields).length) {
    const res = _msgStore().setPlatform(CHANNEL, webhookFields);
    if (!res.ok) {
      printError(`群机器人模式写入失败:${res.error || '未知错误'}`);
      return 1;
    }
    printSuccess(`✅ 群机器人模式已更新(${res.preview})。`);
  }
  if (Object.keys(longFields).length) {
    const res = _runtime().writeChannelConfig(CHANNEL, longFields, { env: process.env });
    if (!res.ok) {
      printError(`长连接模式写入失败:${res.error}`);
      return 1;
    }
    const parts = [];
    if (res.set.length) {
      parts.push(`设置 ${res.set.join(', ')}`);
    }
    if (res.removed.length) {
      parts.push(`删除 ${res.removed.join(', ')}`);
    }
    printSuccess(`✅ 长连接模式已写入 ${res.file}(${parts.join(';') || '无变化'},权限 0600)。`);
  }
  printTable(['字段', '落到哪条路'], routed);
  printInfo('发测试:khy feishu test。开长连接:khy feishu connect。');
  return 0;
}

// ── send / test ──────────────────────────────────────────────────────────

/**
 * 用长连接适配器发一条。适配器在没有活连接时会自己走 webhook 旁路,故这里不预判,
 * 只如实把它的返回(via ws / via webhook)报出来。CLI 是一次性进程,发完就断。
 * @param {string} target
 * @param {string} text
 */
async function _sendViaAdapter(target, text) {
  const adapter = _feishu().createFeishuAdapter({ env: process.env });
  try {
    const res = await adapter.sendMessage(target, text);
    return { ok: true, res };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  } finally {
    await adapter.disconnect('cli-send').catch(() => {});
  }
}

async function _handleSend(args) {
  const list = Array.isArray(args) ? args.slice() : [];
  const target = list.shift();
  const text = list.join(' ').trim();
  if (!target || !text) {
    printError('用法:khy feishu send <会话id/群id> <文本...>。群机器人模式可用 khy feishu test <文本>(无需会话 id)。');
    return 1;
  }
  const out = await _sendViaAdapter(target, text);
  if (!out.ok) {
    printErrorPanel({
      title: '飞书发送失败',
      message: out.error,
      reason: '长连接未建立且没有可用的 webhook 旁路,或凭据不全。',
      suggestions: [
        '查看解析后的配置与来源:khy feishu config',
        '配 webhook 旁路:khy feishu set webhookUrl=<url>',
        '配长连接凭据:khy feishu set appId=<id> appSecret=-',
      ],
    });
    return 1;
  }
  const via = out.res && out.res.via ? out.res.via : 'unknown';
  printSuccess(`✅ 已发送(via ${via},目标 ${target})。`);
  return 0;
}

async function _handleTest(args) {
  const text = (Array.isArray(args) ? args.join(' ') : '').trim() || 'khy 飞书连通性测试';
  const wcfg = _msgStore().getPlatform(CHANNEL);
  if (wcfg) {
    // 群机器人 webhook:无会话概念,直接走既有 msgSender(与 khy msg test feishu 同一条路)。
    const sender = require('../../services/domain/messaging/messaging/msgSender.js');
    const res = await sender.sendText({ platform: CHANNEL, webhook: wcfg.webhook, secret: wcfg.secret, text });
    if (res && res.ok) {
      printSuccess('✅ 群机器人模式发送成功(已发到配置的群 webhook)。');
      return 0;
    }
    printError(`群机器人模式发送失败:${(res && res.error) || '未知错误'}。建议先跑 khy msg test feishu 复核配置。`);
    return 1;
  }
  printError('尚未配置群机器人 webhook。长连接模式需要会话 id:khy feishu send <会话id> <文本>;或先 khy feishu set webhook=<url>。');
  return 1;
}

// ── connect / stop(门控 + 守护进程)──────────────────────────────────────

function _persistGate(value, deps) {
  const writeEnvPatch =
    deps && typeof deps.writeEnvPatch === 'function' ? deps.writeEnvPatch : require('./config')._writeEnvPatch;
  // 清空时**删掉这一行**而不是留一个 `KHY_IM_ADAPTERS=`:留空行会让后来读 .env 的人以为
  // 「配过但没生效」,而实际语义与没配一样。
  if (!value) {
    return writeEnvPatch({}, [GATE]);
  }
  return writeEnvPatch({ [GATE]: value });
}

async function _handleConnect(deps) {
  const { CONFIG_SPEC } = _feishu();
  const resolved = _runtime().resolveChannelConfig(CHANNEL, CONFIG_SPEC, { env: process.env });
  if (!resolved.values.accessToken && !resolved.values.appSecret) {
    printErrorPanel({
      title: '长连接凭据未配置',
      message: '飞书长连接至少需要 accessToken 或 appSecret 之一,当前两者都没有。',
      reason: '端点与凭据只从 env 或运行期 JSON 读取,源码里没有任何内置值。',
      suggestions: [
        'khy feishu set appId=<cli_xxx> appSecret=-(值从 stdin 读,不进 shell 历史)',
        '或注入 env:KHY_IM_FEISHU_ACCESS_TOKEN=<token>',
        '没有公网入口以外的顾虑?也可只用群机器人模式:khy feishu set webhook=<url>',
      ],
    });
    return 1;
  }

  const list = _gateList();
  if (!list.includes(CHANNEL)) {
    list.push(CHANNEL);
  }
  const value = list.join(',');
  let where = '';
  try {
    where = _persistGate(value, deps);
    process.env[GATE] = value; // 即时生效(本进程后续的 status 能看到)
  } catch (err) {
    printError(`无法持久化 ${GATE}:${(err && err.message) || err}`);
    return 1;
  }
  printSuccess(`✅ 长连接门已开(${GATE}=${value}),已写入 ${where}。`);

  const running = await _daemonRunning();
  try {
    const r = running ? await _daemon().daemonRestart() : await _daemon().daemonStart();
    if (r && r.ok === false) {
      throw new Error(r.error || '守护进程未能启动');
    }
    printSuccess(`✅ 守护进程已${running ? '重启' : '启动'},飞书长连接通道(im:feishu)随之接管收信。`);
    printInfo('重连进度与心跳都写在 .khy/logs/daemon.log(含「连接飞书网关(...),第 n 次重试」)。');
    return 0;
  } catch (err) {
    printErrorPanel({
      title: '守护进程未能启动',
      message: (err && err.message) || String(err),
      reason: '门已开且配置已落盘,但没有常驻进程就不会有人去连飞书。',
      suggestions: [`手动执行 khy daemon ${running ? 'restart' : 'start'} 重试`, '查看守护进程日志:.khy/logs/daemon.log'],
    });
    return 1;
  }
}

async function _handleStop(deps) {
  const list = _gateList().filter((n) => n !== CHANNEL);
  const value = list.join(',');
  try {
    const where = _persistGate(value, deps);
    if (value) {
      process.env[GATE] = value;
    } else {
      delete process.env[GATE];
    }
    printSuccess(`✅ 长连接门已关(${GATE}=${value || '(已删除该项)'}),已写入 ${where}。`);
  } catch (err) {
    printError(`无法持久化 ${GATE}:${(err && err.message) || err}`);
    return 1;
  }
  if (!(await _daemonRunning())) {
    printInfo('守护进程未在运行,无需重启。');
    return 0;
  }
  try {
    await _daemon().daemonRestart();
    printSuccess('✅ 守护进程已重启:飞书长连接已摘除,其余渠道照常。');
    return 0;
  } catch (err) {
    printWarn(`守护进程重启失败(${(err && err.message) || err});门已关,手动执行 khy daemon restart 生效。`);
    return 1;
  }
}

// ── clear ────────────────────────────────────────────────────────────────

function _handleClear(args) {
  const mode = String((args && args[0]) || '').toLowerCase();
  const doWebhook = !mode || mode === 'webhook' || mode === 'msg' || mode === 'all';
  const doLong = !mode || mode === 'longlink' || mode === 'long' || mode === 'ws' || mode === 'all';
  if (!doWebhook && !doLong) {
    printError('用法:khy feishu clear [webhook|longlink];省略则两者都清。');
    return 1;
  }
  if (doWebhook) {
    const r = _msgStore().clearPlatform(CHANNEL);
    printInfo(r && r.ok ? '已清除群机器人模式配置。' : `群机器人模式配置未清除:${(r && r.error) || '本来就没有'}`);
  }
  if (doLong) {
    const r = _runtime().clearChannelConfig(CHANNEL, { env: process.env });
    if (!r.ok) {
      printError(`长连接配置清除失败:${r.error}`);
      return 1;
    }
    printInfo(r.existed ? `已删除 ${r.file}。` : `长连接配置文件本来就不存在(${r.file})。`);
    printWarn('注意:env 里的 KHY_IM_FEISHU_* 不受影响 —— 那是注入方(容器/CI)的地盘,得在那边撤。');
  }
  return 0;
}

/**
 * @param {string} subCommand
 * @param {string[]} args
 * @param {object} options
 * @param {object} [deps] - { writeEnvPatch } 可注入便于测试
 * @returns {Promise<number>|number}
 */
async function handleFeishu(subCommand, args = [], options = {}, deps = {}) {
  const sub = String(subCommand || 'status').toLowerCase();
  if (sub === 'help' || options.help) {
    printInfo(
      '用法: feishu [status] | feishu config | feishu set <k>=<v>... | feishu send <会话id> <文本> | feishu test [文本] | feishu connect | feishu stop | feishu clear [webhook|longlink]'
    );
    printInfo('两种接入:① 群机器人+事件订阅(需公网入口,填 webhook 即用);② 长连接(不需公网入口,要 app 凭据,掉线自动重连)。');
    return 0;
  }
  if (!sub || sub === 'status' || sub === 'show' || sub === 'list') {
    return _handleStatus();
  }
  if (sub === 'config' || sub === 'doctor') {
    return _handleConfig();
  }
  if (sub === 'set') {
    return _handleSet(args);
  }
  if (sub === 'send' || sub === 'push') {
    return _handleSend(args);
  }
  if (sub === 'test') {
    return _handleTest(args);
  }
  if (sub === 'connect' || sub === 'start' || sub === 'on') {
    return _handleConnect(deps);
  }
  if (sub === 'stop' || sub === 'off') {
    return _handleStop(deps);
  }
  if (sub === 'clear' || sub === 'rm' || sub === 'remove' || sub === 'unset') {
    return _handleClear(args);
  }
  printError(
    `未知子命令:${subCommand}。可用:status / config / set / send / test / connect(start) / stop / clear / help。`
  );
  return 1;
}

module.exports = { handleFeishu, _webhookKeys, _longLinkKeys, _gateList };
