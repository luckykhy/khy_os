/**
 * agentFeedbackService — 三模态反馈契约的**提示通道**（PROCESS-006 的 S2 落点）。
 *
 * 为什么需要它：`scripts/ci/check-agent-feedback.js` 是**提交期**的检查器，只在改动
 * 落盘之后（或 `rules:gate` 跑时）才说话。而 `[DESIGN-ARCH-113]` 要的是**改动过程中的
 * 主动开口** —— 客户在看病/求学/搓澡的**当下**就把话说出来，而不是等手术做完再甩红灯。
 * 本服务就是这条「当场说话」的通道。
 *
 * ## 落点选择（实测订正 PROCESS-006 §3）
 *
 * `[DESIGN-PROCESS-002]` §3 把 S2 推荐落点写成「`PreToolUse` hook，返回放行但附提示」。
 * **在本仓这条建议是错的**，实测依据：
 *
 *   - `hookRunner.js` 的 `CMD_HOOK_ALLOWED_FIELDS.PreToolUse = ['params']` ——
 *     PreToolUse 的结果**只能改 params**，没有任何字段能承载一段文本提示；
 *   - 能送达对话的 `additionalContext` **只**在 `PrePrompt`/`PostToolUse`/`PostResponse`/
 *     `PreCompact`/`PostCompact` 的白名单里，**不含 PreToolUse**；
 *   - `toolUseLoopCore.js:3732` 消费 `promptHr.context.additionalContext` 追加进
 *     `currentMessage` —— 这是提示进入 AI 上下文**唯一**的注入点。
 *
 * ⇒ 注册在 **`PrePrompt`**，与既有先例 `changeWatchService.makePrePromptInjector()`
 * 同构。PROCESS-006 §3 的「S2 = PreToolUse」应读作「S2 = 有干预能力但不用的那一类 hook」；
 * 在 khyos 里具备该能力的实际事件名是 `PrePrompt`。
 *
 * ## 为什么是文件 store 而不是进程内单例
 *
 * hook 命令由 `hookRunner` 以**子进程**方式 spawn（`node <file>`），子进程的模块作用域
 * 与主进程完全隔离 —— 进程内单例槽位会出现「子进程 push 了、主进程的注入器永远读不到」
 * 的静默失效，而且看起来一切正常。故一律走文件 store（与 changeWatchService 的
 * `<dataHome>/change-watch/verdict.json` 同构）：tmp + rename 原子写，按 `consumerId`
 * 各自记账以保证多消费者（khyos 内部 + 外部 AI 工具）**各自恰好拿到一次**。
 *
 * ## 阶段语义（PP-3）
 *
 * 全程**只注入提示、永不阻断**：只产出 `{action:'allow'}` 或
 * `{action:'modify', additionalContext:...}`，两者都不含 block。
 * fail-soft：任何异常一律放行，绝不挡 AI 管线。
 *
 * @module services/agentFeedbackService
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * 提示通道的**应急开关**（默认**开**）。
 *
 * ⚠ 为什么默认是开：本仓既有的三个 hook（`guardDangerousCommand` / `detectFileLeak` /
 * `bash-safety-guard`）**都没有 env 门控** —— 「被写进 `.khy/hooks.json`」本身就是同意。
 * 若这里要求显式 `KHY_AGENT_FEEDBACK=1` 才工作，会出现一条**死钩子**：条目在、
 * 进程也 spawn 了、但永远静默退出，而 `hookRunner` 只注入 `HOOK_EVENT`、没有 per-hook
 * env 机制，无法在 `hooks.json` 里带环境变量。这正是本仓反复出现的
 * 「声明了但没生效」——注册状态无法自证，只能靠实测。
 *
 * ⇒ **注册即启用**；本变量保留为排障用的**关闭开关**（`0/false/off/no/disable`）。
 */
const ENV_FLAG = 'KHY_AGENT_FEEDBACK';

/** store 文件覆盖用的环境变量（测试隔离用）。 */
const ENV_STORE = 'KHY_AGENT_FEEDBACK_STORE';

/** khyos 内部通道的消费者 ID；外部 AI 工具应传各自的 ID，互不抢账。 */
const INTERNAL_CONSUMER = 'khy-internal';

/** 注入文本前缀。带 `[客户]` 标记便于在 transcript 里一眼认出是机制在说话。 */
const SPEECH_PREFIX = '[客户]';

/**
 * 三模态的「一句话」契约。与检查器的 `customerSpeech()` 同源，但这里只取最关键的
 * **一句话** —— 进提示词的文本必须短，长了就是噪声（PP-2 的 10% 误报率阈值正是为
 * 「提示的代价是注意力」设的）。
 */
const MODE_PROMPT = {
  FIX: '这是修 bug。先别开药 —— 复现了吗？把原始输出留下（repro-before.txt），我要看到它，不要你的转述。',
  BUILD: '这是加功能。先回答我五个问题（谁在什么场景下需要它、现在怎么凑合的、不做会怎样、最小可用形态、怎么验证），答完再动手。',
  DELETE: '这是删东西。先说清楚搓哪儿、多大力、疼了怎么喊停 —— 给一份部位清单和一条**可执行**的回滚命令。',
};

const _OFF = new Set(['0', 'false', 'off', 'no', 'disable', 'disabled']);

/** 默认开；只有显式关闭值才关（详见 ENV_FLAG 的注释）。 */
function isEnabled(env = process.env) {
  const v = String((env && env[ENV_FLAG]) || '').toLowerCase().trim();
  return !_OFF.has(v);
}

function _storeDir() {
  const override = process.env[ENV_STORE];
  if (override) return String(override);
  let base;
  try {
    base = require('../utils/dataHome').getDataHome();
  } catch {
    base = path.join(os.homedir(), '.khyos');
  }
  return path.join(base, 'agent-feedback');
}

function _storePath() {
  return path.join(_storeDir(), 'pending.json');
}

/** 原子写：tmp + rename，避免读者读到半截文件。 */
function _write(rec) {
  const d = _storeDir();
  fs.mkdirSync(d, { recursive: true });
  const tmp = path.join(d, 'pending.json.tmp');
  const dst = path.join(d, 'pending.json');
  fs.writeFileSync(tmp, JSON.stringify(rec, null, 2));
  fs.renameSync(tmp, dst);
}

function _read() {
  const dst = _storePath();
  if (!fs.existsSync(dst)) return null;
  try {
    return JSON.parse(fs.readFileSync(dst, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 压入一条待注入的客户提示（跨进程：落盘）。
 *
 * 单槽位而非队列：客户一次只说一句最要紧的话。攒一堆提示会让 AI 注意力涣散，
 * 也让「哪句提示对应哪次改动」无法归因。后压覆盖先压。
 *
 * @param {string} text
 * @param {{mode?:string, source?:string, signature?:string}} [meta]
 */
function push(text, meta = {}) {
  const s = String(text || '').trim();
  if (!s) return false;
  try {
    _write({
      text: s,
      mode: String(meta.mode || '').toUpperCase(),
      source: meta.source || '',
      signature: meta.signature || '',
      ts: Date.now(),
      ackedBy: [],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * 按模态压入标准提示（调用方只给模态，文本取 `MODE_PROMPT`）。
 * @param {'FIX'|'BUILD'|'DELETE'} mode
 * @param {string} [signature] 改动集签名（去抖用：同一改动不重复说话）
 */
function pushForMode(mode, signature) {
  const m = String(mode || '').toUpperCase();
  const text = MODE_PROMPT[m];
  if (!text) return false;
  return push(text, { mode: m, source: 'builtin:AgentFeedbackInjector', signature });
}

/**
 * 取走待注入提示，**按消费者记账**（多消费者各自恰好拿到一次）。
 *
 * 门控关 / 无记录 / 已被该消费者取走 / 无文本 → null（静默）。
 * @param {string} [consumerId]
 * @returns {{text:string, mode:string}|null}
 */
function consume(consumerId = INTERNAL_CONSUMER) {
  if (!isEnabled()) return null;
  const cid = String(consumerId || INTERNAL_CONSUMER).trim() || INTERNAL_CONSUMER;
  let rec = null;
  try {
    rec = _read();
  } catch {
    return null;
  }
  if (!rec) return null;
  const text = String(rec.text || '').trim();
  if (!text) return null;
  const acks = Array.isArray(rec.ackedBy) ? rec.ackedBy : [];
  if (acks.includes(cid)) return null;
  acks.push(cid);
  rec.ackedBy = acks;
  if (cid === INTERNAL_CONSUMER) rec.consumed = true;
  try {
    _write(rec);
  } catch {
    /* best-effort：落盘失败不影响本次注入 */
  }
  return { text, mode: rec.mode || '' };
}

/** 只读窥视，不记账（诊断用）。 */
function peek() {
  return _read();
}

/** 公开契约路径：外部 AI 工具可直接定位并读取。 */
function getStorePath() {
  return _storePath();
}

/** 清空（测试与回退用）。 */
function reset() {
  try {
    fs.rmSync(_storePath(), { force: true });
  } catch {
    /* ignore */
  }
}

/**
 * 造 `PrePrompt` 钩子处理器：把待注入的客户提示作为 `additionalContext` 注入下一轮。
 *
 * 与 `changeWatchService.makePrePromptInjector()` 同构：
 *   - 无待注入内容 → `{action:'allow'}`（不改动任何东西）；
 *   - 有待注入内容 → `{action:'modify', additionalContext}`（追加，不覆盖原提示词）；
 *   - 任何异常 → `{action:'allow'}`（fail-soft，绝不挡 AI 管线）。
 *
 * @param {(id:string)=>({text:string}|null)} [take] 取数原语，可注入测试
 * @param {string} [consumerId]
 * @returns {(context?:Object)=>Promise<{action:'modify'|'allow', additionalContext?:string}>}
 */
function makePrePromptInjector(take, consumerId = INTERNAL_CONSUMER) {
  const takeOne = typeof take === 'function' ? take : () => consume(consumerId);
  return async function agentFeedbackInjector() {
    try {
      const pending = takeOne(consumerId);
      if (pending && pending.text) {
        return { action: 'modify', additionalContext: `${SPEECH_PREFIX} ${pending.text}` };
      }
    } catch {
      /* fail-soft：反馈通道故障绝不挡 AI 管线 */
    }
    return { action: 'allow' };
  };
}

module.exports = {
  ENV_FLAG,
  ENV_STORE,
  INTERNAL_CONSUMER,
  SPEECH_PREFIX,
  MODE_PROMPT,
  push,
  pushForMode,
  consume,
  peek,
  isEnabled,
  getStorePath,
  makePrePromptInjector,
  reset,
};
