'use strict';

/**
 * ilinkDispatcher.js — 微信入站消息的编排层。
 *
 * 职责:拿到一条已归一的入站消息 → 决定怎么处理 → 把回答发回微信。
 *
 * 为什么需要**串行队列**(而不是并发跑 agent):
 *   chat() 不可重入。即使会话历史已按 sessionId 隔离(见 _chatWithWatchdog 中的
 *   scopeSession),仍有一批进程级全局态会互相污染:
 *   cancelActiveRequest() 会 abort 所有在飞请求、aiLocalState.liveSessionId 让所有人的
 *   消息写进同一份转写本、以及进程级的权限模式与 cwd。所以一次只跑一个查询。
 *
 * 为什么**权限回复要插队**:
 *   `y`/`n` 是对「正在跑的那个查询」的应答。若让它排在队列里等,它要等的正是它要放行的
 *   那个查询——必然死锁到超时。故权限回复不进队列,直接交给等待中的 resolver。
 *
 * 与参考实现的关键差异:「忙」状态只放内存,绝不落盘。参考实现把 state='processing'
 * 持久化,进程崩在查询中途后重启即永久死锁(每条消息都回「正在处理上一条」,而唯一的
 * 逃生口 /clear 又被显式挡住,只能手删 JSON)。
 *
 * 契约:fail-soft。任何异常都要变成一句发得出去的中文,绝不让微信那头没有下文。
 *
 * @module services/channels/ilinkDispatcher
 */

const fs = require('fs');
const path = require('path');

const defaults = require('../../../../constants/serviceDefaults');
const log = require('../../../../utils/logger');
const core = require('../messaging/ilinkCore');

/**
 * 取 chat 内核。
 *
 * **显式注入是权威的**:deps.getChat 一旦给出,它的结果(含 null)即为最终答案,绝不再往下
 * 回落。否则测试注入一个空 chat 后,会静默把整个 CLI ai 模块拉起来打真模型——既让「离线单测」
 * 名不副实,也让「AI 内核缺失」这条分支永远测不到。
 *
 * 未注入时才走生产回落链:aiChatPort → 惰性加载 CLI ai(headless 守护进程正是这样接的,
 * 此时 cli/ai.js 可能还没被 require 过,aiChatPort 就是空的)。
 *
 * @param {object} deps
 * @returns {Function|null}
 */
function _resolveChat(deps = {}) {
  if (typeof deps.getChat === 'function') {
    try {
      const c = deps.getChat();
      return typeof c === 'function' ? c : null;
    } catch {
      return null;
    }
  }
  try {
    const c = require('../../../aiChatPort').getAiChat();
    if (typeof c === 'function') {
      return c;
    }
  } catch {
    /* 落到下一档 */
  }
  try {
    // 惰性加载:cli/ai.js 在加载时会把 chat 注册进 aiChatPort。
    require('../../../../cli/ai');
    const c = require('../../../aiChatPort').getAiChat();
    if (typeof c === 'function') {
      return c;
    }
  } catch {
    /* 仍无 → 返回 null,上层回一句诚实的话 */
  }
  return null;
}

/** 看门狗的哨兵值。用独占 Symbol,避免与 chat() 的任何合法返回值撞上。 */
const _TIMED_OUT = Symbol('ilink-query-timeout');

/**
 * 判定一条自然语言文本是否在请求「发绑定二维码」。
 *
 * 仅匹配明确含「二维码/绑定码/qrcode」意图的短语,避免误伤正常对话
 * (比如只提到“二维码”三个字但在问别的事)。纯函数。
 * @param {string} text
 * @returns {boolean}
 */
function isBindQrIntent(text) {
  const t = String(text == null ? '' : text)
    .trim()
    .toLowerCase();
  if (!t) {
    return false;
  }
  const patterns = [
    '绑定二维码',
    '二维码发给我',
    '发绑定码',
    '把二维码',
    '绑定码',
    '发我二维码',
    '给我二维码',
    '发个二维码',
    '要二维码',
    '二维码给我',
    '发个绑定码',
    'qrcode',
  ];
  return patterns.some((p) => t.includes(p));
}

/**
 * 取结构化工具循环(runToolUseLoop),不可用/未启用时返回 null。
 *
 * 为什么微信这条路**必须**走它:模型有两种发起工具调用的方式 ——
 *   1. 自然语言语法写在回复正文里 → chat() 内部的循环会处理;
 *   2. 原生 tool_calls(结构化 toolUseBlocks) → chat() **只把它原样返回给调用方**,
 *      自己不执行。执行者是 runToolUseLoop,历来只有 REPL / TUI 在驱动。
 * 现在的云端模型(agnes / sensenova / stepfun 都是)走的是第 2 种。只调 chat() 的话,
 * 「我的桌面上有什么」这类请求会拿到一句合成的占位符 `[模型请求执行工具: Glob]`,
 * 工具一个都没跑 —— 于是微信里只有纯闲聊能通,凡是要动手的一律哑火,而这恰恰是
 * 接微信的全部意义。
 *
 * @returns {object|null} toolUseLoop 模块,或 null
 */
function _resolveToolLoop() {
  if (String(process.env.KHY_ILINK_DISABLE_TOOL_LOOP || '').toLowerCase() === '1') {
    return null;
  }
  try {
    const loop = require('../../../toolUseLoop');
    if (!loop || typeof loop.runToolUseLoop !== 'function') {
      return null;
    }
    if (typeof loop.isEnabled === 'function' && !loop.isEnabled()) {
      return null;
    }
    return loop;
  } catch {
    return null;
  }
}

/**
 * 微信这条路是否也遵循全局的「首选通道严格模式」。
 * 默认 false(允许回落)——见 _runQuery 里 preferredStrict 处的说明。
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
function _ilinkStrictRoute(env = process.env) {
  const raw = env && env.KHY_ILINK_STRICT_ROUTE;
  const v = String(raw == null ? '' : raw)
    .trim()
    .toLowerCase();
  return v === '1' || v === 'true' || v === 'on' || v === 'yes';
}

/**
 * 微信通道单轮追加的 khy-os 身份 / 绑定说明系统提示。
 *
 * 为什么必须有:底层云端大模型的训练语料里带着 OpenClaw/ClawBot 官方产品套路
 * (khy-os 从 OpenClaw 衍生,ilink 通道用同套 bot_type=3 后端)。不告诉模型
 * 「你现在是 khy-os」,用户在微信问「你是谁 / 怎么绑定 / 发绑定二维码」时,模型
 * 就会按 OpenClaw 老剧本乱答(让用户装 WorkBuddy、去 openclaws.io),与 khy-os
 * 真实流程(khy wx login)完全对不上。
 *
 * 作用域:只通过 chatOpts.appendSystemPrompt 追加到「本轮」已装配好的系统提示尾部
 * (见 aiChatCore 的 --append-system-prompt 对齐点),不改全局人设/静态基座,
 * 不碰 .env。这段只补「khy-os 身份 + 微信绑定事实」,不改变任何其他行为。
 */
const ILINK_IDENTITY_SYSTEM_PROMPT = [
  '【khy-os 身份与微信绑定事实 —— 仅本次微信对话生效,补充说明,不改变其他行为】',
  '你是 khy-os(一个 AI 平台操作系统)内置的助手,通过微信 ilink bot API(bot_type=3,',
  '与 ClawBot 同一套后端)接入用户微信。你不是 OpenClaw 官方产品,也不是 WorkBuddy 桌面端。',
  '',
  '关于「如何绑定微信 / 首次接入」的正确流程(务必据此回答,不要沿用旧产品套路):',
  '1. 在用户自己的电脑上运行 khy wx login —— 终端会显示一个二维码,用户用微信扫码登录。',
  '2. 扫码成功后运行 khy wx start,(重)启守护进程,微信这条通道才会持续在线。',
  '3. 会话过期时,重新运行 khy wx login 扫码即可恢复。',
  '',
  '绝对不要这样回答:不要建议用户去 openclaws io 下载 WorkBuddy;不要声称「二维码只能显示在',
  '我自己的屏幕上、我无法生成或发送」。事实相反:khy-os 支持在微信里直接发送「绑定二维码」或',
  '「发我二维码」之类的短语,由 bot 现场申请并以图片形式发回一张绑定码。该绑定码用于邀请其他',
  '受信任的人接入同一个 khy-os 实例,发送时请附带简短安全提示(仅发给信任的人,勿公开转发)。',
  '',
  '保持简洁,只补充上述 khy-os 身份与微信绑定事实,不与既有全局人设冲突,不改变其他任何行为。',
].join('\n');

/**
 * Whether a normalized reply still carries raw tool-block JSON.
 *
 * finalResponse 可能来自「结构化 content blocks 被整体 JSON 化」的降级路径,
 * 直接外发就会把 tool_use / tool_result 原文推到微信用户眼前。
 * @param {string} text
 * @returns {boolean}
 */
function _looksLikeToolBlockJson(text) {
  if (!text) {
    return false;
  }
  return /"type"\s*:\s*"(tool_use|tool_result)"/.test(text);
}

/**
 * 把含 tool 块 JSON 的文本用 contentBlockUtils 二次清洗为纯文本(降级)。
 * fail-soft:解析不出结构化内容时原样返回,绝不因清洗失败丢掉整轮回复。
 * @param {string} text
 * @returns {string}
 */
function _stripToolBlocks(text) {
  try {
    const { contentToText, isStructuredContent } = require('../../../contentBlockUtils');
    const parsed = JSON.parse(text);
    // Only trust contentToText when parsed is a real content-block array.
    // A single object (e.g. {type:'text',...}) would otherwise stringify to
    // "[object Object]" and be sent to the WeChat user as a "cleaned" reply.
    if (isStructuredContent(parsed)) {
      const cleaned = contentToText(parsed);
      if (typeof cleaned === 'string' && cleaned.trim().length) {
        return cleaned;
      }
    }
  } catch {
    /* not a JSON payload — fall through to the line filter */
  }
  // Not a structured blocks array: drop the lines carrying tool-block markers.
  try {
    const kept = String(text)
      .split('\n')
      .filter((line) => !_looksLikeToolBlockJson(line));
    const cleaned = kept.join('\n').trim();
    if (cleaned.length) {
      return cleaned;
    }
  } catch {
    /* fail-soft */
  }
  return text;
}

/** 把 chat 的返回值归一成非空文本;形状与 msgReplyBridge._normalizeReply 一致。 */
function normalizeReply(out) {
  if (out == null) {
    return null;
  }
  let text = null;
  if (typeof out === 'string') {
    text = out;
  }
  // finalResponse 排在最前:走 runToolUseLoop 时,那才是工具执行完的最终答复;
  // 循环结果上没有 reply/content 字段,漏了它整轮就会被当成「没有可发送的回答」。
  else if (typeof out === 'object') {
    text =
      out.finalResponse ||
      out.text ||
      out.content ||
      out.reply ||
      out.message ||
      out.output ||
      null;
  }
  if (typeof text !== 'string') {
    return null;
  }
  // 防御层:提取出的文本仍带 tool 块 JSON 标记时降级清洗,不透传给微信用户。
  if (_looksLikeToolBlockJson(text)) {
    text = _stripToolBlocks(text);
  }
  const trimmed = text.trim();
  return trimmed.length ? trimmed : null;
}

// 图片扩展名判定集。core.detectImageMime 存在,但它对非图片字节会回落到
// 'image/jpeg',不适作「是否图片」的闸门;故按扩展名确定投递方式。
const _IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'];

/**
 * 按扩展名判定是否图片(决定投递走 sendImage 还是 sendFile)。
 * @param {string} fileName
 * @returns {boolean}
 */
function _isImageFile(fileName) {
  const ext = path.extname(String(fileName || '')).toLowerCase();
  return _IMAGE_EXTS.includes(ext);
}

/**
 * 清洗 image_generate 成功后最终回复中的临时文件路径行。仅微信 dispatcher 调用,
 * CLI 仍保留工具返回的本地路径。
 * @param {string|null} reply
 * @param {*} out
 * @returns {string|null}
 */
function _sanitizeGeneratedImageReply(reply, out) {
  if (!defaults.ILINK_SANITIZE_PATHS || typeof reply !== 'string') {
    return reply;
  }
  const logArr = out && Array.isArray(out.toolCallLog) ? out.toolCallLog : [];
  const generatedPaths = [];
  const hasSuccessfulImage = logArr.some((entry) => {
    if (!entry || entry.tool !== 'image_generate' || !entry.result || entry.result.success !== true) {
      return false;
    }
    const paths = entry.result.meta && entry.result.meta.paths;
    if (Array.isArray(paths)) {
      generatedPaths.push(...paths.filter((value) => typeof value === 'string' && value.trim()));
    }
    return true;
  });
  if (!hasSuccessfulImage) {
    return reply;
  }

  const escapedPaths = generatedPaths.map((filePath) =>
    filePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  );
  const knownPathPattern = escapedPaths.length ? new RegExp(escapedPaths.join('|'), 'i') : null;
  const tempPathPattern = /(?:^|\s)(?:\/tmp\/\S+|[a-z]:\\[^\r\n]*?\\temp\\\S+)/i;
  const cleaned = reply
    .split(/\r?\n/)
    .map((line) =>
      (knownPathPattern && knownPathPattern.test(line)) || tempPathPattern.test(line)
        ? '（图片已发送）'
        : line
    )
    .filter((line, index, lines) => line !== '（图片已发送）' || lines.indexOf(line) === index)
    .join('\n')
    .trim();
  return cleaned || '（图片已发送）';
}

/**
 * Build the live-session scope key for an inbound message.
 *
 * Pure function: no side effects, never throws. An unknown/invalid scope
 * falls back to the per-account-channel-peer form (the safest isolation).
 * userId is trimmed to stay consistent with the historical
 * `ilink:${String(msg.userId||'').trim()}` cleansing.
 *
 *   'main'                     → 'ilink:shared'        (all peers share history)
 *   'per-peer'                 → 'ilink:<userId>'
 *   'per-channel-peer'         → 'ilink:<userId>'
 *   'per-account-channel-peer' → 'ilink:<accountId>:<userId>'  (default)
 *
 * @param {string} scope one of defaults.ILINK_SESSION_SCOPES
 * @param {string} accountId owning account id
 * @param {string} userId inbound peer user id
 * @returns {string} session scope key
 */
function buildSessionKey(scope, accountId, userId) {
  const uid = String(userId == null ? '' : userId).trim();
  const acc = String(accountId == null ? '' : accountId);
  switch (scope) {
    case 'main':
      return 'ilink:shared';
    case 'per-peer':
    case 'per-channel-peer':
      return `ilink:${uid}`;
    case 'per-account-channel-peer':
      return `ilink:${acc}:${uid}`;
    default:
      // Unknown/invalid scope: fall back to the strongest isolation form.
      return `ilink:${acc}:${uid}`;
  }
}

/**
 * One-time fallback migration for the Phase-1 dmScope change.
 *
 * Phase 1 flipped the default dmScope to `per-account-channel-peer`, moving the
 * live-session key from the historical single-account form `ilink:<userId>` to
 * `ilink:<accountId>:<userId>`. Without a migration, an existing single-account
 * user's next inbound message resumes the new (empty) key and their prior
 * history is silently orphaned on disk (the old session files still exist, they
 * are just no longer referenced).
 *
 * Chosen strategy vs. the real sessionPersistence API: there is NO id-rename /
 * alias primitive (renameSession only sets a title), so we copy — read the
 * legacy transcript via restoreSession and re-persist it under the new
 * account-scoped key via persistSession. persistSession appends only messages
 * beyond the current on-disk count, so a brand-new key receives the full legacy
 * transcript, and the metadata.cwd bucket is preserved. The subsequent
 * scopeSession(newKey) then resumes the migrated context seamlessly.
 *
 * Gates (all must hold, else no-op):
 *   - accountId is present;
 *   - the resolved scope produces an account-scoped key (i.e. it carries the
 *     accountId prefix — differs from the legacy per-peer key);
 *   - the new key has no persisted history yet (idempotent / one-time);
 *   - the legacy key DOES have persisted history.
 *
 * Fail-soft: throws nothing meaningful to the caller path; migration never
 * blocks chat and never weakens multi-account isolation — the target is the
 * account-scoped key, sourced only from THIS user's own single-account history.
 *
 * @param {object} persistence sessionPersistence-shaped module
 * @param {string} scope defaults.ILINK_SESSION_SCOPE
 * @param {string} accountId owning account id
 * @param {string} userId inbound peer user id
 * @returns {{migrated:boolean, reason:string}}
 */
function _migrateLegacyIlinkSession(persistence, scope, accountId, userId) {
  if (
    !persistence ||
    typeof persistence.loadSessionMeta !== 'function' ||
    typeof persistence.restoreSession !== 'function' ||
    typeof persistence.persistSession !== 'function'
  ) {
    return { migrated: false, reason: 'NO_PERSISTENCE' };
  }

  const acc = String(accountId == null ? '' : accountId).trim();
  if (!acc) {
    return { migrated: false, reason: 'NO_ACCOUNT' };
  }

  // Reuse buildSessionKey for BOTH keys — never re-derive key shapes here.
  const newKey = buildSessionKey(scope, accountId, userId);
  const legacyKey = buildSessionKey('per-peer', accountId, userId); // ilink:<userId>
  // Only account-scoped keys carry the accountId prefix. main / per-peer /
  // per-channel-peer either equal the legacy key or share nothing to migrate.
  if (newKey === legacyKey) {
    return { migrated: false, reason: 'NOT_ACCOUNT_SCOPED' };
  }
  if (newKey !== buildSessionKey('per-account-channel-peer', accountId, userId)) {
    return { migrated: false, reason: 'NOT_ACCOUNT_SCOPED' };
  }

  // New key already has history → already migrated or a native account user.
  // Cheap snapshot-only read (no chain rebuild); keeps the check O(1)/turn.
  const newMeta = persistence.loadSessionMeta(newKey);
  if (newMeta && Number(newMeta.messageCount) > 0) {
    return { migrated: false, reason: 'NEW_KEY_HAS_HISTORY' };
  }

  // Legacy single-account history present?
  const legacy = persistence.restoreSession(legacyKey);
  if (!legacy || !Array.isArray(legacy.messages) || legacy.messages.length === 0) {
    return { migrated: false, reason: 'NO_LEGACY_HISTORY' };
  }

  // Copy the legacy transcript under the new account-scoped key (one-time).
  persistence.persistSession(newKey, {
    messages: legacy.messages,
    title: legacy.title || '',
    model: legacy.model || '',
    metadata: legacy.metadata && typeof legacy.metadata === 'object' ? legacy.metadata : {},
  });
  return { migrated: true, reason: 'MIGRATED' };
}

class IlinkDispatcher {
  /**
   * @param {object} opts
   * @param {object} opts.channel IlinkChannel(用于发回复与 typing)
   * @param {Function} [opts.getChat] 注入 chat 解析器(测试用)
   * @param {Function} [opts.getPersistence] 注入 sessionPersistence 解析器(测试用)
   * @param {Function} [opts.getBindingStore] 注入 ilinkBindingStore 解析器(测试用)
   * @param {Function} [opts.getWorkspaceRouter] 注入工作空间路由器解析器(测试用)
   * @param {string} [opts.accountId] 归属账号 id,用于按 dmScope 构造会话键
   */
  constructor(opts = {}) {
    this.channel = opts.channel;
    this._getChat = opts.getChat;
    this._getPersistence = opts.getPersistence;
    this._getBindingStore = opts.getBindingStore;
    this._getWorkspaceRouter = opts.getWorkspaceRouter;
    this.accountId = String(opts.accountId || '');
    /** @type {Array<{msg:object, resolve:Function}>} 串行队列 */
    this._queue = [];
    this._running = false;
    /** 正在等权限回复的 resolver(单槽:串行队列保证同时只有一个查询在跑)。 */
    this._pendingPermission = null;
    this._warnedNoChat = false;
    this._warnedNoToolLoop = false;
  }

  /**
   * messageRouter 的 per-channel handler 入口。
   * @param {object} msg 已由 ilinkCore.parseInboundMessage 归一
   * @returns {Promise<void>}
   */
  async handle(msg) {
    if (!msg || !msg.userId) {
      return;
    }

    // 持久化本轮入站的 context-token(msg.threadId 即 context_token,见 parseInboundMessage),
    // 供后续主动发送(如发绑定二维码)在无 threadId 时 fallback 取用。
    // fail-soft:存不进去只是少一个 fallback,绝不影响入站处理。
    if (this.accountId && msg.threadId) {
      try {
        require('../messaging/ilinkAccountStore').setContextToken(
          this.accountId,
          msg.userId,
          msg.threadId
        );
      } catch {
        /* fail-soft */
      }
    }

    // ① 权限回复插队:必须在入队之前判,否则它会排在自己要放行的那个查询后面。
    if (this._pendingPermission) {
      const verdict = core.parsePermissionReply(msg.text);
      if (verdict) {
        const p = this._pendingPermission;
        this._pendingPermission = null;
        p.resolve(verdict);
        return;
      }
    }

    // ② 超时宽限期:审批已超时后才发来的 y/n 要吞掉,不能当成新 prompt 丢给模型
    //    (否则用户会看到 agent 认真回答「y」是什么意思)。
    if (this._graceUntil && Date.now() < this._graceUntil && core.parsePermissionReply(msg.text)) {
      this._graceUntil = 0;
      await this._say(msg, '⏰ 上一个授权请求已超时(已自动拒绝)。请重新发一次你的指令。');
      return;
    }

    // ③ 空文本(纯图片/语音等)在阶段 4 之前先如实告知,不静默丢。
    if (!msg.text) {
      if (msg.unsupported && msg.unsupported.length) {
        await this._say(msg, `📎 暂不支持${msg.unsupported.join('、')}消息,请改用文字。`);
      } else if (msg.images && msg.images.length) {
        await this._say(msg, '🖼 收到图片,但图片理解尚未接通(即将支持)。请先用文字描述。');
      }
      return;
    }

    // ④ 斜杠命令:在进 agent 之前拦截。不进队列(都是即时操作,不跑模型),
    //    /clear 与 /reset **永远可执行** —— 参考实现把它们在「忙」时挡掉,
    //    结果进程崩在查询中途后唯一的逃生口也没了,只能手删 JSON。
    const cmd = core.parseSlashCommand(msg.text);
    if (cmd) {
      await this._runSlash(msg, cmd);
      return;
    }

    // ⑤½ 自然语言拦截:请求发绑定二维码。在进 AI 队列之前直接发码,
    //    不该把这类意图当普通 prompt 丢给模型。
    if (isBindQrIntent(msg.text)) {
      await this._sendBindQrCode(msg);
      return;
    }

    // ⑤ 排队(串行)。队列有上限,避免有人连发几十条把内存和 token 都撑爆。

    if (this._queue.length >= 10) {
      await this._say(msg, '⏳ 排队的消息太多了,这条先丢掉。等我把前面的处理完再发。');
      return;
    }
    this._queue.push(msg);
    if (this._queue.length > 1 || this._running) {
      await this._say(msg, `⏳ 正在处理前一条,你这条排在第 ${this._queue.length} 位。`);
    }
    await this._drain();
  }

  /**
   * 执行斜杠命令。全部 fail-soft:任何异常都变成一句发得出去的中文。
   * @param {object} msg
   * @param {{cmd:string, args:string}} cmd
   */
  async _runSlash(msg, cmd) {
    try {
      const out = await this._slashResult(msg, cmd);
      await this._say(msg, out);
    } catch (err) {
      await this._say(msg, `⚠️ /${cmd.cmd} 执行出错:${(err && err.message) || err}`);
    }
  }

  /** @returns {Promise<string>} 要发回微信的文本 */
  async _slashResult(msg, cmd) {
    switch (cmd.cmd) {
      case 'help':
      case '?':
        return [
          '可用命令:',
          '/wx      — 连接健康(通道/心跳/会话/游标)',
          '/status  — 当前真实路由(通道/模型)与通道状态',
          '/model   — 当前实际在用的模型',
          '/models  — 列出已连通的通道',
          '/ping    — 看我还在不在',
          '/clear   — 清空对话历史(随时可用)',
          '/reset   — 同 /clear',
          '/queue   — 查看排队情况',
          '/version — khy 版本',
          '',
          '直接发文字即可对话;需要授权时回 y 允许、n 拒绝。',
        ].join('\n');

      case 'wx':
      case 'conn':
      case 'connection':
        return this._describeConnection();

      case 'ping':
        return '🏓 在。';

      case 'status':
        return this._describeRoute(true);

      case 'model':
        return this._describeRoute(false);

      case 'models':
        return this._listAdapters();

      case 'clear':
      case 'reset':
      case 'new':
        // 永远可执行 —— 这是卡死时唯一的逃生口,绝不因为「忙」而挡掉。
        try {
          require('../../../../cli/aiConversationOps').clearHistory();
          this._queue.length = 0;
          return '🧹 已清空对话历史(排队中的消息也一并丢弃)。';
        } catch (e) {
          return `⚠️ 清空失败:${(e && e.message) || e}`;
        }

      case 'queue':
        return (
          `队列:${this._queue.length} 条等待中${this._running ? '(有一条正在处理)' : ''}` +
          `${this._pendingPermission ? ',正在等你的授权回复' : ''}。`
        );

      case 'qr':
      case 'bind':
      case '二维码':
        // 发送是多步异步(申请→渲染→上传→发图/降级发链接),自己发完,
        // 返回空串让 _runSlash 的 _say 不再叠发多余文本。
        await this._sendBindQrCode(msg);
        return '';

      case 'version':
        try {
          return `khy ${require('../../../package.json').version}`;
        } catch {
          return 'khy(版本未知)';
        }

      default:
        return `未知命令:/${cmd.cmd}。发 /help 看可用命令。`;
    }
  }

  /**
   * 连接健康。回答的是「这条链路本身好不好」,而不是「模型是谁」(那是 /status)。
   *
   * 注意能收到这条命令本身就说明入站是通的 —— 所以真正有信息量的是**出站以外**的东西:
   * 心跳有多新、会话有没有过期、游标在不在、连续失败了多少次。
   */
  _describeConnection() {
    const lines = ['🔗 连接健康'];
    const ch = this.channel;
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

    lines.push(`队列:${this._queue.length} 条等待${this._running ? '、1 条处理中' : ''}`);
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
   * @param {boolean} full 是否附带通道/队列状态
   */
  _describeRoute(full) {
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
      lines.push(`队列:${this._queue.length} 条等待${this._running ? '、1 条处理中' : ''}`);
      const ch = this.channel;
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
  _listAdapters() {
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

  /** 串行消费队列。 */
  async _drain() {
    if (this._running) {
      return;
    }
    this._running = true;
    try {
      while (this._queue.length) {
        const msg = this._queue.shift();
        try {
          await this._runQuery(msg);
        } catch (err) {
          log.warn(`ilink dispatcher 处理失败:${(err && err.message) || err}`);
          await this._say(msg, `⚠️ 处理出错了:${(err && err.message) || '未知错误'}`);
        }
      }
    } finally {
      this._running = false;
    }
  }

  /** 跑一次 agent 查询,期间维持「正在输入」并把权限审批引到微信。 */
  async _runQuery(msg) {
    const chat = _resolveChat({ getChat: this._getChat });
    if (!chat) {
      if (!this._warnedNoChat) {
        this._warnedNoChat = true;
        log.warn('ilink: AI 内核未就绪(headless?),入站消息已解析但无法回答');
      }
      await this._say(
        msg,
        '⚠️ AI 内核未就绪,暂时无法回答。请确认守护进程已启动:khy daemon start。'
      );
      return;
    }

    const stopTyping = this._startTyping(msg);
    try {
      // 全局串行锁:进程内任一时刻只允许一个 agent 查询在跑,跨所有账号 dispatcher 共享
      // (见 ilinkExecutionLock)。scopeSession(在 _chatWithWatchdog 内)与权限 prompter 都是
      // 进程级单例态,故二者的读写都必须在锁内,才不会被并发账号互相污染。
      // 权限等待(等用户回 y/n)发生在锁内属预期:一次查询连同其审批是不可分割的执行单元;
      // y/n 回复经 handle() 直达 _pendingPermission.resolver —— 它不入队、也不抢这把锁(handle
      // 是 fire-and-forget 派发进来的),所以锁持有者 await 审批 promise 不会死锁。
      const out = await require('./ilinkExecutionLock').runExclusive(async () => {
        // 策略二——执行期工作空间路由:若本账号有绑定,在本次已全局串行的时间片内
        // 把进程级 cwd/agent 切到目标 workspace/agent。必须在锁内切、锁内恢复:
        // runExclusive 保证同一时刻只有一个查询在跑,故进程级状态不会与另一账号交叠
        // (与 chat() 不可重入约束一致,绝不引入并发独立 agent)。放在 scopeSession/迁移
        // 之前,确保本次查询确实在目标 workspace 下执行且会话元数据记对 cwd。
        const restoreWorkspace = this._applyBindingRouting();
        const restorePermission = this._installPermissionBridge(msg);
        try {
          return await this._chatWithWatchdog(chat, msg);
        } finally {
          restorePermission();
          // 即使 chat 抛错也要还原 cwd/agent——恢复与切换成对,都在锁内。
          restoreWorkspace();
        }
      });
      let reply = normalizeReply(out);
      // 先投递本轮工具产出的文件,再发文本回复。内部 fail-soft,
      // 绝不因发文件失败而影响后面的文本回复。
      await this._deliverFiles(msg, out);
      reply = _sanitizeGeneratedImageReply(reply, out);
      await this._say(msg, reply || '(没有产生可发送的回答)');
      // 断点续接「写」侧修复:微信路从不触发 clearHistory/eofExit,自动检查点
      // (maybeAutoCheckpointProgress)只在那些路径被调 → PROGRESS.md 永不落盘 →
      // 「学完记不住学到哪」。这里在每轮成功收尾后补一次(叶子自带三道门槛:
      // 门控/已手写跳过/实质轮次+学习信号,误触发率极低)。fail-soft。
      this._maybeAutoCheckpointTurn(msg);
    } finally {
      stopTyping();
    }
  }

  /**
   * 投递本轮工具链产出的文件到微信(SendUserFile 的结果)。
   *
   * out 来自 runToolUseLoop 的返回(经 _runAgentTurn 透传):{ finalResponse, toolCallLog,
   * iterations, ... }。toolCallLog 每项形如 { iteration, tool, params, result, elapsed },
   * 其中 tool 是工具规范名、result 是工具 execute 的返回。out 也可能是纯字符串
   * (工具循环不可用/看门狗超时),故非数组直接 return。
   *
   * 契约:fail-soft。整体 try/catch 兼底;每个文件再独立 try/catch——单个文件失败
   * 仅记 log.warn + 文本告知路径,绝不影响其余文件与后续文本回复。
   * @param {object} msg 入站消息
   * @param {*} out _chatWithWatchdog 的返回
   */
  async _deliverFiles(msg, out) {
    try {
      const logArr = out && Array.isArray(out.toolCallLog) ? out.toolCallLog : null;
      if (!logArr) {
        return;
      }
      const channel = this.channel;
      if (!channel) {
        return;
      }
      const channelId = msg.channelId || msg.userId;
      const threadId = msg.threadId || '';

      for (const entry of logArr) {
        if (!entry || entry.tool !== 'SendUserFile') {
          continue;
        }
        const result = entry.result;
        if (!result || result.success !== true) {
          continue;
        }
        // 防御性解析文件路径:直接字段 / 则又一层 result 嵌套。
        const filePath = result.file || result.file_path || (result.result && result.result.file);
        if (!filePath) {
          continue;
        }

        const fileName = path.basename(String(filePath));
        try {
          const st = await fs.promises.stat(filePath);
          if (st.size > defaults.ILINK_MAX_FILE_SIZE_BYTES) {
            const limitMb = Math.round(defaults.ILINK_MAX_FILE_SIZE_BYTES / (1024 * 1024));
            const sizeMb = (st.size / (1024 * 1024)).toFixed(1);
            await this._say(
              msg,
              `📎 文件「${fileName}」太大(${sizeMb}MB,超过上限 ${limitMb}MB),暂不能直接发送。` +
                `你可以到这个路径自取:${filePath}`
            );
            continue;
          }

          const buf = await fs.promises.readFile(filePath);
          const isImage = _isImageFile(fileName);
          const sendRes = isImage
            ? await channel.sendImage(channelId, buf, { threadId, fileName })
            : await channel.sendFile(channelId, buf, { threadId, fileName, fileSize: st.size });

          if (!sendRes || sendRes.ok === false) {
            const reason = (sendRes && sendRes.error) || '未知原因';
            log.warn(`ilink: 文件发送失败(${fileName}):${reason}`);
            await this._say(
              msg,
              `📎 文件「${fileName}」发送失败。你可以到这个路径自取:${filePath}`
            );
          }
        } catch (err) {
          const reason = (err && err.message) || String(err);
          log.warn(`ilink: 文件投递出错(${fileName}):${reason}`);
          await this._say(
            msg,
            `📎 文件「${fileName}」发送出错。你可以到这个路径自取:${filePath}`
          ).catch(() => {});
        }
      }
    } catch (err) {
      // 整体兼底:_deliverFiles 绝不能抛错影响后续文本回复。
      log.warn(`ilink: 文件投递环节异常(已忽略):${(err && err.message) || err}`);
    }
  }

  /**
   * 微信通道的「会话结束自动检查点」安全网(断点续接写侧)。
   * 只在有实质回复后触发;主题锚点按用户隔离(微信无 cwd 概念,进程 cwd 是
   * 家目录,直接用它会把所有微信用户的学习进度混成一条)。绝不抛。
   * @param {object} msg
   */
  _maybeAutoCheckpointTurn(msg) {
    try {
      const ai = require('../../../../cli/ai');
      if (!ai || typeof ai.maybeAutoCheckpointProgress !== 'function') {
        return;
      }
      const userId = String((msg && msg.userId) || '').trim();
      // 主题锚点:微信-<userId 前 8 位>,避免多用户共用一条主题、也避免用家目录名。
      const anchor = userId ? `微信-${userId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 8)}` : '微信';
      ai.maybeAutoCheckpointProgress('ilinkTurn', anchor);
    } catch {
      /* best effort */
    }
  }

  /**
   * 取会话持久化模块。显式注入优先(测试桩);未注入时惰性加载真实模块。
   * 取不到返回 null,迁移路径自行降级为 no-op(fail-soft)。
   * @returns {object|null}
   */
  _resolvePersistence() {
    if (typeof this._getPersistence === 'function') {
      try {
        const p = this._getPersistence();
        return p || null;
      } catch {
        return null;
      }
    }
    try {
      return require('../../../sessionPersistence');
    } catch {
      return null;
    }
  }

  /**
   * Resolve the ilink binding store. Injection wins (test stub); otherwise lazy
   * require the real module. Unresolvable → null (routing degrades to no-op).
   * @returns {object|null}
   */
  _resolveBindingStore() {
    if (typeof this._getBindingStore === 'function') {
      try {
        return this._getBindingStore() || null;
      } catch {
        return null;
      }
    }
    try {
      return require('../messaging/ilinkBindingStore');
    } catch {
      return null;
    }
  }

  /**
   * Resolve the workspace router that performs the process-level cwd + agent
   * switch. Injection wins (test stub); otherwise a default router wrapping the
   * two real, verified primitives:
   *   - cwd:   worktreeSessionCwd.switchToolCwd(dir) — syncs BOTH the tools'
   *            authoritative KHYQUANT_CWD env source AND process.chdir. There is
   *            NO chatOpts cwd passthrough (tools read process.env.KHYQUANT_CWD
   *            || process.cwd()), so a process-level switch is the only faithful
   *            mechanism; it is safe here because the switch happens under the
   *            global exclusive lock and is reverted in finally.
   *   - agent: agentFsService.{getActiveAgentId,setActiveAgent,clearActiveAgent}
   *            — an .active.json companion pointer read by the chat system
   *            prompt. setActiveAgent throws for an unknown id (handled fail-soft).
   * Unresolvable → null (routing degrades to no-op).
   * @returns {object|null}
   */
  _resolveWorkspaceRouter() {
    if (typeof this._getWorkspaceRouter === 'function') {
      try {
        return this._getWorkspaceRouter() || null;
      } catch {
        return null;
      }
    }
    try {
      const cwdSwitcher = require('../../../worktreeSessionCwd');
      const agentSvc = require('../../agents/agentFs/agentFsService');
      return {
        switchCwd: (dir) => cwdSwitcher.switchToolCwd(dir),
        getActiveAgentId: () => agentSvc.getActiveAgentId(),
        setActiveAgent: (id) => agentSvc.setActiveAgent(id),
        clearActiveAgent: () => agentSvc.clearActiveAgent(),
      };
    } catch {
      return null;
    }
  }

  /**
   * Route this serialized query into the account's bound workspace/agent, and
   * return a restore function that undoes the switch.
   *
   * MUST be called INSIDE the global exclusive lock: it mutates process-level
   * state (KHYQUANT_CWD + process.cwd + the active-agent pointer) that is shared
   * across all account dispatchers. The lock guarantees no other account's query
   * runs concurrently, so this per-time-slice isolation never introduces a
   * concurrent independent agent (consistent with chat()'s non-reentrant contract).
   *
   * Fail-soft end to end: reading the binding or performing either switch may
   * fail; on ANY error we fall back to "unbound" and let the query proceed under
   * the default cwd/agent — nothing is thrown. Each successful switch captures
   * its own prior state and contributes a restore step; the returned function
   * replays them in reverse order (LIFO). The returned function is always
   * callable (no-op when nothing was switched).
   *
   * @returns {Function} restore function (always safe to call)
   */
  _applyBindingRouting() {
    const noop = () => {};
    const acc = this.accountId;
    if (!acc) {
      return noop;
    }

    // ① Read the binding. Any failure → treat as unbound.
    let binding = null;
    try {
      const store = this._resolveBindingStore();
      binding = store && typeof store.getBinding === 'function' ? store.getBinding(acc) : null;
    } catch {
      binding = null;
    }
    if (!binding) {
      return noop;
    }

    const workspace = String(binding.workspace || '').trim();
    const agent = String(binding.agent || '').trim();
    if (!workspace && !agent) {
      return noop;
    }

    const router = this._resolveWorkspaceRouter();
    if (!router) {
      return noop;
    }

    const restores = [];

    // ② cwd switch. Capture prior KHYQUANT_CWD (may be unset) + process.cwd so
    //    restore is exact — including deleting the env var when it was unset.
    if (workspace && typeof router.switchCwd === 'function') {
      // Capture the restore baseline defensively: reading process.cwd() throws
      // if the current directory was deleted / became inaccessible, and env
      // reads are similarly guarded. Without a reliable baseline we cannot
      // guarantee an exact restore, so we abandon the cwd switch entirely and
      // proceed at the default cwd — honoring the module's fail-soft contract
      // (a failed switch degrades to "unbound", never throws).
      let baseline = null;
      try {
        baseline = {
          hadEnvCwd: Object.prototype.hasOwnProperty.call(process.env, 'KHYQUANT_CWD'),
          prevEnvCwd: process.env.KHYQUANT_CWD,
          prevProcCwd: process.cwd(),
        };
      } catch {
        /* fail-soft: cannot read current cwd/env → skip cwd switch */
      }
      if (baseline) {
        try {
          const res = router.switchCwd(workspace);
          if (!res || res.switched !== false) {
            restores.push(() => {
              // Restore chdir + env via the same switcher (keeps both cwd sources
              // in sync), then fix the env var if it was originally unset.
              try {
                router.switchCwd(baseline.prevProcCwd);
              } catch {
                /* best effort */
              }
              try {
                if (baseline.hadEnvCwd) {
                  process.env.KHYQUANT_CWD = baseline.prevEnvCwd;
                } else {
                  delete process.env.KHYQUANT_CWD;
                }
              } catch {
                /* best effort */
              }
            });
          }
        } catch {
          /* fail-soft: cwd switch failed → proceed at default cwd */
        }
      }
    }

    // ③ agent switch. Capture prior active id; setActiveAgent throws for an
    //    unknown agent → skip (proceed with default agent). Restore to prior id,
    //    or clear the pointer when there was none.
    if (agent && typeof router.setActiveAgent === 'function') {
      try {
        const prevAgent =
          typeof router.getActiveAgentId === 'function' ? router.getActiveAgentId() : null;
        router.setActiveAgent(agent);
        restores.push(() => {
          try {
            if (prevAgent) {
              router.setActiveAgent(prevAgent);
            } else if (typeof router.clearActiveAgent === 'function') {
              router.clearActiveAgent();
            }
          } catch {
            /* best effort */
          }
        });
      } catch {
        /* fail-soft: unknown agent → proceed with default agent */
      }
    }

    if (!restores.length) {
      return noop;
    }
    return () => {
      for (let i = restores.length - 1; i >= 0; i--) {
        try {
          restores[i]();
        } catch {
          /* best effort: never throw on restore */
        }
      }
    };
  }

  /**
   * 跑 chat(),但给它一个墙钟上限。
   *
   * 为什么必须有:chat() **既不接受 abort signal,也没有整体超时**。一次卡死的查询
   * (工具在等一个永不返回的网络调用、模型流断在半路)会让串行队列永久阻塞 ——
   * 微信从此一条都不理,而且从外面完全看不出为什么,只能重启守护进程。
   *
   * 超时后调 cancelActiveRequest() 真正掐掉在飞的网关请求(守护进程里没有 REPL 争用,
   * 这个进程级操作是安全的),然后放行队列。
   *
   * 诚实边界:cancelActiveRequest 只能掐网关请求;若 chat 卡在别处(比如某个工具的
   * 阻塞调用),那个 promise 可能仍悬着。所以这里给它挂了 catch 防止变成
   * unhandledRejection,并且**不**等它 —— 队列的畅通优先于那次查询的收尾。
   */
  async _chatWithWatchdog(chat, msg) {
    const limit = Number(defaults.ILINK_QUERY_TIMEOUT_MS) || 0;
    // 会话隔离(阶段 3 起在通道层生效):chat() 内 _chatState.messages 是进程级单例,
    // 之前 opts.sessionId 只进 trace audit、从不影响历史 → 所有微信用户共用一条历史、
    // 守护进程重启后消息全失(「从头开始」)。这里在每轮 chat 前按 sessionId 把 live
    // 会话作用域切到该用户:同 id no-op;异 id 恢复该用户已持久化历史(新用户空历史
    // 起步);随后 _persistLiveSession 把本轮追加到该用户独立文件,跨重启存活、用户隔离。
    try {
      const ai = require('../../../../cli/ai');
      if (ai && typeof ai.scopeSession === 'function') {
        const scope = defaults.ILINK_SESSION_SCOPE;
        // Phase-1 向后兼容:默认 dmScope 翻到 per-account-channel-peer 后,会话键从
        // 旧的 `ilink:<userId>` 变成 `ilink:<accountId>:<userId>`。在 scopeSession 之前做
        // 一次性 fallback 迁移:新键无历史而旧单账号键有历史时,把旧会话拷到新键,
        // 使既有用户升级后上下文无缝续接。失败不阻断聊天(fail-soft)。
        try {
          _migrateLegacyIlinkSession(this._resolvePersistence(), scope, this.accountId, msg.userId);
        } catch {
          /* fail-soft:迁移任何异常都不得影响正常聊天 */
        }
        ai.scopeSession(buildSessionKey(scope, this.accountId, msg.userId));
      }
    } catch {
      /* fail-soft:作用域失败不回退本轮 */
    }
    const p = this._runAgentTurn(chat, msg);
    if (limit <= 0) {
      return p;
    }

    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(_TIMED_OUT), limit);
      if (typeof timer.unref === 'function') {
        timer.unref();
      }
    });
    let winner;
    try {
      winner = await Promise.race([p, timeout]);
    } finally {
      clearTimeout(timer);
    }
    if (winner !== _TIMED_OUT) {
      return winner;
    }

    // 超时:掐掉在飞请求,并确保被遗弃的 promise 不会变成 unhandledRejection。
    p.catch(() => {});
    const mins = Math.max(1, Math.round(limit / 60000));
    log.warn(`ilink: 单次查询超过 ${limit}ms,已放弃并放行队列(用户 ${msg.userId})`);
    try {
      require('../../../../cli/ai').cancelActiveRequest('微信端查询超时');
    } catch {
      /* 取不到就算了,放行队列本身才是关键 */
    }
    return (
      `⏱ 这条处理超过 ${mins} 分钟还没结果,我先放弃了(在飞的请求已取消),` +
      '免得后面的消息一直排队。你可以换个说法再试,或把任务拆小一点。'
    );
  }

  /**
   * 跑一轮 agent:优先结构化工具循环,取不到才退回裸 chat()。
   *
   * 回退只在**开跑之前**判定(模块缺失 / isEnabled() 为假 / 门控关闭)。循环一旦抛错就
   * 如实报错,绝不改用 chat() 重跑一遍 —— 那时工具很可能已经执行过副作用(写文件、
   * 发请求),再跑一遍就是静默重复执行,比多一条错误消息危险得多。
   *
   * @param {Function} chat
   * @param {object} msg
   * @returns {Promise<*>} 供 normalizeReply 归一的结果
   */
  async _runAgentTurn(chat, msg) {
    const chatOpts = {
      source: 'ilink',
      channelName: core.PLATFORM,
      userId: msg.userId,
      // 会话隔离:每用户独立历史由 scopeSession 保证;此处 sessionId 供 trace audit。
      sessionId: `ilink:${msg.userId}`,
      // 按次放开「首选通道严格模式」——**只影响微信这条路,不碰全局 .env**。
      // 理由:GATEWAY_PREFERRED_STRICT=true 的含义是「首选通道不可用就硬失败」,
      // 这在终端是合理的(你能看到报错并当场 khy gateway model 换一个);但在微信里
      // 没有任何交互式换通道的余地,硬失败只会让对面收到一段看不懂的诊断文本。
      // 允许回落到其他已连通的通道,是这条链路上唯一能真正答话的选择。
      // 想让微信也严格遵循全局设置:把 KHY_ILINK_STRICT_ROUTE 设为 1/true。
      preferredStrict: _ilinkStrictRoute(),
      // 仅微信这一轮追加 khy-os 身份/绑定说明——通过已支持的 appendSystemPrompt
      // 字段,被 aiChatCore 拼到「本轮」系统提示尾部(--append-system-prompt 对齐点),
      // 不覆盖全局人设/静态基座。两条路径都透传:裸 chat(msg.text, chatOpts) 直读
      // opts.appendSystemPrompt;runToolUseLoop 以 {...chatOpts} 展开到每轮 chat()。
      appendSystemPrompt: ILINK_IDENTITY_SYSTEM_PROMPT,
    };

    const loop = _resolveToolLoop();
    if (!loop) {
      if (!this._warnedNoToolLoop) {
        this._warnedNoToolLoop = true;
        log.warn('ilink: 结构化工具循环不可用,本通道只能做纯文本问答(需要动手的请求会答不了)');
      }
      return chat(msg.text, chatOpts);
    }

    return loop.runToolUseLoop(msg.text, {
      chat,
      chatOpts,
      // 权限审批已由 _installPermissionBridge 改道到微信,循环里的工具闸门会用它。
      onToolCall: (name) => {
        log.debug?.(`ilink: 工具 ${name}(用户 ${msg.userId})`);
      },
      // syscall 网关的 L1/L2 交互式确认与 exec 审批走的是**独立于 permissionPromptPort**
      // 的 onControlRequest 通道。不接它 → executeTool 里 onCtrl 为 null → 守护进程这种
      // 非交互环境下 L2 高危/破坏性工具被 fail-closed 直接拒绝(审计里就是那句「L2 高危且
      // 无交互器,fail-closed 拒绝」)。这里把确认改道到微信,复用 _askPermission 的
      // 单槽/超时/宽限机制,让用户在微信里真正批准工具执行。
      onControlRequest: (ctrl) => this._askControlPermission(msg, ctrl),
    });
  }

  /**
   * 把权限审批从「本地终端」改道到微信,查询结束后原样还原。
   *
   * 为什么必须做,而且不能只当增强:守护进程是 detached 的,stdin 不是 TTY。若不接这条桥,
   * toolCallingPermissions.askUser 会回落到 readline(process.stdin),那个 question 的回调
   * **永远不会被调用** —— agent 永久挂住、串行队列死锁、微信这头再无下文。
   *
   * 走 permissionPromptPort 而非 setReadlineProvider:后者只能拿到 '  > ' 这个裸提示符
   * (工具详情是 console.log 到 stdout 的,在守护进程里进日志、到不了微信);前者给的是
   * 结构化的 (toolName, params, riskInfo, reasoning),且返回值会被既有代码正确记账到
   * permissionStore。
   *
   * **不削弱任何闸门**:不可绕过的 critical 人闸门(rm -rf / .env 改动 / git reset --hard)
   * 依旧生效——本桥只是给它一条能触达人的通道,绝不代替人回答。
   *
   * @returns {Function} 还原函数
   */
  _installPermissionBridge(msg) {
    let port;
    try {
      port = require('../../../permissionPromptPort');
    } catch {
      return () => {};
    }
    const prev = port.getPermissionPrompter();
    try {
      port.registerPermissionPrompter({
        prompt: (toolName, params, riskInfo, reasoning) =>
          this._askPermission(msg, { toolName, params, riskInfo, reasoning }),
        // 批量预检不接:让它回落到既有的非交互路径,比在微信里渲染一屏批量对话框可靠。
        promptBatch: prev && prev.promptBatch ? prev.promptBatch : undefined,
      });
    } catch {
      return () => {};
    }
    return () => {
      try {
        port.registerPermissionPrompter(prev);
      } catch {
        /* best effort */
      }
    };
  }

  /**
   * 向微信发一次授权询问并等回复。
   * @returns {Promise<'allow'|'deny'>} 超时一律 deny —— **绝不能 resolve 成空串**:
   *   toolCallingPermissions 把空应答当作 allow(见其 switch 的 case ''),
   *   那会让「没人理」变成「默许执行」。
   */
  _askPermission(msg, info) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (verdict) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        this._pendingPermission = null;
        resolve(verdict === 'allow' ? 'allow' : 'deny');
      };

      const timer = setTimeout(() => {
        // 进入宽限期:超时后才发来的 y/n 要被吞掉,不能当成新 prompt 丢给模型。
        this._graceUntil = Date.now() + defaults.ILINK_PERMISSION_GRACE_MS;
        this._say(
          msg,
          `⏰ 等待授权超过 ${Math.round(defaults.ILINK_PERMISSION_TIMEOUT_MS / 1000)} 秒,已自动拒绝。`
        ).catch(() => {});
        finish('deny');
      }, defaults.ILINK_PERMISSION_TIMEOUT_MS);
      if (typeof timer.unref === 'function') {
        timer.unref();
      }

      this._pendingPermission = {
        resolve: (verdict) => {
          // 给个回执,否则用户不知道那句 y 到底收到没有。
          this._say(msg, verdict === 'allow' ? '✅ 已授权,继续执行。' : '🚫 已拒绝。').catch(
            () => {}
          );
          finish(verdict);
        },
      };

      this._say(msg, core.formatPermissionPrompt(info)).catch(() => {});
    });
  }

  /**
   * onControlRequest 微信桥:把 syscall 网关(L1/L2)与 exec 审批的交互式确认改道
   * 到微信,复用 _askPermission 的单槽/超时/宽限机制(不另造定时器)。
   *
   * 与 permissionPromptPort 的关系:两条独立的审批通道。网关判 allow 后会盖一枚
   * EXEC_APPROVED 戳,既有 requestPermission 据此**免二次打断**——故同一次工具调用
   * 不会被问两次(网关先问 onControlRequest,放行即盖戳跳过 permissionPromptPort)。
   * 两者复用同一个 _askPermission 展示逻辑,且共享 _pendingPermission 单槽,天然串行。
   *
   * 调用契约(见 syscallGateway.makeControlPrompter 与 toolUseLoopCore._resolveExecApproval):
   *   入参 ctrl = { requestId, request: { subtype:'can_use_tool', tool_name, input } }
   *     · 网关 input = { tool, level:'L1'|'L2', action, scope, resource, requireTyped?, explanation? }
   *     · exec input = { command, risk, reason }
   *   返回值(被 makeControlPrompter.decode / _decisionFromControl / confirmL2 解读):
   *     · 允许 → { behavior:'allow', typed:<L2 确认串> }
   *       (behavior 供 L1 askL1 与 exec 审批;typed 供 L2 confirmL2 匹配确认串)
   *     · 拒绝 → { behavior:'deny' }
   *
   * fail-closed:任何无法识别/超时 → deny。
   * @param {object} msg 入站消息
   * @param {object} ctrl 控制请求
   * @returns {Promise<{behavior:string, typed?:string}>}
   */
  async _askControlPermission(msg, ctrl) {
    const req = (ctrl && ctrl.request) || {};
    const input = req.input && typeof req.input === 'object' ? req.input : {};
    const level = String(input.level || '').toUpperCase(); // '', 'L1', 'L2'
    const toolName = input.tool || req.tool_name || '未知工具';

    // 归一成 formatPermissionPrompt 期望的 info 形状,复用同一展示逻辑。
    // 网关 intent 携 action/scope/resource;exec 携 command。
    const params = {};
    if (input.command != null) {
      params.command = input.command;
    }
    if (input.resource != null) {
      params.resource = input.resource;
    }
    if (input.action != null) {
      params.action = input.action;
    }
    if (input.scope != null) {
      params.scope = input.scope;
    }

    const riskLabel =
      level === 'L2'
        ? 'L2 高危(破坏性/不可逆,需你确认)'
        : level === 'L1'
          ? 'L1 中危'
          : input.risk || '未知';
    const info = {
      toolName,
      params,
      riskInfo: { level: riskLabel },
      reasoning: input.reason || (typeof input.explanation === 'string' ? input.explanation : ''),
    };

    const verdict = await this._askPermission(msg, info);
    if (verdict !== 'allow') {
      return { behavior: 'deny' };
    }

    // L2 确认串取自网关协议常量(DEFAULT_L2_CONFIRM),不写死字面量;取不到时
    // 回落协议默认 'YES'。allow 同时给 behavior 与 typed,一次满足 L1(behavior)、
    // L2(typed 匹配确认串)、exec(behavior) 三个消费方。
    let l2Word = 'YES';
    try {
      const w = require('../syscallGateway').DEFAULT_L2_CONFIRM;
      if (typeof w === 'string' && w.trim()) {
        l2Word = w;
      }
    } catch {
      /* fall back to protocol default */
    }
    return { behavior: 'allow', typed: l2Word };
  }

  /**
   * 维持「正在输入」直到查询结束。返回停止函数。
   * 纯装饰:全程静默失败,绝不影响回答。
   */
  _startTyping(msg) {
    if (!this.channel || typeof this.channel.setTyping !== 'function') {
      return () => {};
    }
    let stopped = false;
    const tick = () => {
      if (stopped) {
        return;
      }
      this.channel.setTyping(msg.userId, true, msg.threadId).catch(() => {});
    };
    tick();
    const timer = setInterval(tick, defaults.ILINK_TYPING_KEEPALIVE_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
      this.channel.setTyping(msg.userId, false, msg.threadId).catch(() => {});
    };
  }

  /**
   * 申请并发送微信绑定二维码。fail-soft:全程不抛。
   *
   * 流程:申请二维码 → 渲染 PNG → 优先发图;图片发送失败(协议未验证可能
   * 失败)时降级为发送扫码链接文字。无论哪种形式都附带中文安全提示。
   * @param {object} msg
   */
  async _sendBindQrCode(msg) {
    const login = require('../messaging/ilinkLogin');
    await this._say(msg, '正在申请微信绑定二维码…');

    let qr;
    try {
      qr = await login.requestQrCode();
    } catch (e) {
      qr = { ok: false, error: (e && e.message) || String(e) };
    }
    if (!qr || !qr.ok) {
      await this._say(msg, `⚠️ 申请绑定二维码失败:${(qr && qr.error) || '未知原因'}`);
      return;
    }

    // 安全提示（必须）:转发二维码 = 授权对方使用你的 khy 实例。
    const safety = [
      '⚠️ 安全提示:这张二维码等同于你的 khy 授权入口。',
      '谁扫码绑定,谁就能用你的 khy 实例——可访问你的文件系统与工具。',
      '请只转发给你完全信任的人;二维码有时效,过期需重新申请。',
    ].join('\n');

    // 优先发图:渲染 PNG data URL → 拆出 base64 → Buffer → channel.sendImage。
    let imageSent = false;
    try {
      const dataUrl = await login.renderQrToDataUrl(qr.qrcodeUrl);
      const base64 =
        dataUrl && dataUrl.includes(',') ? dataUrl.slice(dataUrl.indexOf(',') + 1) : '';
      const buf = base64 ? Buffer.from(base64, 'base64') : null;
      if (buf && buf.length && this.channel && typeof this.channel.sendImage === 'function') {
        const r = await this.channel.sendImage(msg.channelId || msg.userId, buf, {
          threadId: msg.threadId || '',
          fileName: 'khy-bind-qr.png',
        });
        imageSent = !!(r && r.ok);
        if (!imageSent) {
          log.warn(`ilink: 绑定二维码图片发送失败,降级发链接:${r && r.error}`);
        }
      }
    } catch (e) {
      log.warn(`ilink: 绑定二维码渲染/发图异常,降级发链接:${(e && e.message) || e}`);
    }

    if (imageSent) {
      // 图片已发,追一条安全提示。
      await this._say(msg, safety);
    } else {
      // 降级:图片发不出去时,改发扫码链接文字 + 安全提示。
      await this._say(
        msg,
        [`扫码绑定链接:${qr.qrcodeUrl}`, '(图片发送暂不可用,已改发链接)', '', safety].join('\n')
      );
    }
  }

  /** 发一句话回原会话。fail-soft:发不出去只记日志。 */
  async _say(msg, text) {
    if (!this.channel || typeof this.channel.sendReply !== 'function') {
      return;
    }
    try {
      const r = await this.channel.sendReply(msg.channelId || msg.userId, msg.threadId || '', text);
      if (r && r.ok === false) {
        log.warn(`ilink 回复未发全(已发 ${r.sent} 片):${r.error}`);
      }
    } catch (err) {
      log.warn(`ilink 回复发送失败:${(err && err.message) || err}`);
    }
  }

  /** 诊断用。 */
  toJSON() {
    return {
      queued: this._queue.length,
      running: this._running,
      awaitingPermission: !!this._pendingPermission,
    };
  }
}

module.exports = {
  IlinkDispatcher,
  normalizeReply,
  buildSessionKey,
  _migrateLegacyIlinkSession,
  _resolveChat,
  _resolveToolLoop,
  _ilinkStrictRoute,
  isBindQrIntent,
};
