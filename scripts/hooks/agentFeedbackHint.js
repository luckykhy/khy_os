#!/usr/bin/env node
'use strict';

/**
 * agentFeedbackHint.js — `PreToolUse` 命令钩子：嗅探当前改动的主模态，把客户那
 * **一句话**推进提示通道（落盘），由 `agentFeedbackService` 的 `PrePrompt` 函数钩子
 * 在下一轮对话里注入。
 *
 * ## 为什么这里是 PreToolUse 而注入器在 PrePrompt
 *
 * 两者的职责不同，事件能力也不同（详见 `agentFeedbackService` 的模块注释）：
 *
 *   - **本脚本（PreToolUse）是生产者**：它只需要「看到」即将发生的改动并落盘一句提示。
 *     PreToolUse 的输出白名单是 `['params']`（`hookRunner.js`），它**不能**注入文本，
 *     但它能拿到 `toolName` + `params` —— 判定主模态所需的全部信息。
 *   - **注入器（PrePrompt）是消费者**：只有 `PrePrompt` 的白名单含 `additionalContext`，
 *     那是文本进入 AI 上下文的唯一注入点（`toolUseLoopCore.js:3732`）。
 *
 * 故本脚本**恒 exit 0**（从不阻断，PP-3），副作用只有「往 store 里写一句话」。
 *
 * ## 轻量约束
 *
 * 钩子默认 5s 超时，而 `check-agent-feedback.js` 全量跑一次约 1.1s（要遍历 `docs/` 做
 * 文档背书匹配），**不能**在这里整体调用。本脚本只复用它的**纯函数**
 * `detectMode(changes, statement)`（实测 1ms，零 I/O）：判定逻辑仍然是单一真源，
 * 但不会把钩子拖到超时。
 *
 * ## 去抖（为什么必须有）
 *
 * AI 改一个文件往往连发十几次工具调用。若无去抖，同一句提示会被压入十几次，
 * `store` 的单槽位语义（后压覆盖前压、且重置 `ackedBy`）会让注入器反复说话 ——
 * 这正是 PP-2 说的「提示的代价是注意力」。故按**改动集签名**去抖：
 * 签名不变就不再压。
 *
 * ## 开关
 *
 * **注册即启用**；`KHY_AGENT_FEEDBACK=0/false/off/no/disable` 是排障用的关闭开关。
 * 无 pending 内容时本脚本不写任何文件，故启用状态下改无关文件也零副作用。
 *
 * @module scripts/hooks/agentFeedbackHint
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** 判定与标准话术的单一真源（纯函数，无 I/O）。 */
let detectMode;
try {
  ({ detectMode } = require('../ci/check-agent-feedback.js'));
} catch {
  detectMode = null;
}

/** 提示通道 store（与 agentFeedbackService 同一份文件；这里不能 require 后端模块，
 *  因为钩子是独立进程、且不应把 services/ 的依赖拖进钩子启动路径）。 */
function storeDir() {
  const override = process.env.KHY_AGENT_FEEDBACK_STORE;
  if (override) return String(override);
  let base;
  try {
    base = require(path.join(REPO_ROOT, 'services', 'backend', 'src', 'utils', 'dataHome')).getDataHome();
  } catch {
    base = path.join(os.homedir(), '.khyos');
  }
  return path.join(base, 'agent-feedback');
}

/** 去抖状态文件（记录上次开口时的签名）。 */
function debouncePath() {
  return path.join(storeDir(), 'last-hint.json');
}

/**
 * 默认**开**：被写进 `.khy/hooks.json` 就是同意（与既有三个 hook 一致）。
 * `KHY_AGENT_FEEDBACK=0/false/off/no/disable` 是排障用的关闭开关。
 *
 * ⚠ 不要改回「未设置即关闭」：`hookRunner` 只给子进程注入 `HOOK_EVENT`，
 * `hooks.json` 无法带 per-hook env，那样会得到一条注册了却永远静默的死钩子。
 */
const _OFF = new Set(['0', 'false', 'off', 'no', 'disable', 'disabled']);

function isEnabled() {
  const v = String(process.env.KHY_AGENT_FEEDBACK || '').toLowerCase().trim();
  return !_OFF.has(v);
}

/** 文件编辑类工具：改动体现在 params 里的路径字段。 */
const EDIT_TOOLS = new Set([
  'write', 'edit', 'multiedit', 'notebookedit', 'create', 'update',
  'writetool', 'edittool', 'strreplace', 'strreplaceeditor', 'replace',
  'patch', 'applypatch', 'filewrite', 'fileedit',
]);

/** shell 类工具：改动体现在命令字符串里。 */
const SHELL_TOOLS = new Set([
  'bash', 'shell', 'exec', 'execute', 'run', 'terminal', 'shellexec',
  'bashtool', 'shelltool', 'executetool',
]);

/** 视为「删文件」的命令形状。 */
const DELETE_CMD = /\b(rm|del|erase|rmdir|rd|remove-item|unlink|git\s+rm)\b/i;
/** 视为「建文件」的命令形状。 */
const BUILD_CMD = /\b(touch|mkdir|git\s+add|npm\s+create|npx\s+create|new-item)\b/i;

function toolKind(toolName) {
  const n = String(toolName || '').toLowerCase();
  if (EDIT_TOOLS.has(n)) return 'edit';
  if (SHELL_TOOLS.has(n)) return 'shell';
  if (/write|edit|replace|patch|create/i.test(n)) return 'edit';
  if (/bash|shell|exec|terminal|command/i.test(n)) return 'shell';
  return null;
}

/** 从 params 里抽出受影响的路径（编辑类工具）。 */
function pathsFromParams(params) {
  if (!params || typeof params !== 'object') return [];
  const out = [];
  for (const key of ['file_path', 'filePath', 'path', 'notebook_path', 'target_file', 'file']) {
    const v = params[key];
    if (typeof v === 'string' && v.trim()) out.push(v.trim());
  }
  return out;
}

/** 从 params 里抽出命令串（shell 类工具）。 */
function commandFromParams(params) {
  if (!params || typeof params !== 'object') return '';
  for (const key of ['command', 'cmd', 'script', 'input', 'code']) {
    const v = params[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

/**
 * 把一次工具调用翻译成 `detectMode` 需要的 changes 形状。
 *
 * 为什么不是直接读 `git status`：钩子跑在工具调用**之前**，改动尚未落盘，
 * 此时 git 看不到任何东西 —— 只能从调用参数里推断。
 *
 * ⚠ 新增的判定靠「目标文件当前是否存在」：钩子恰好跑在写入之前，所以
 * `Write` 一个尚不存在的文件 = 新增（'A'）。少了这一步，新建文件会被一律判成
 * 'M'，`detectMode` 拿不到 BUILD 的 +0.35 信号，置信度只有 0.05 → 客户在最该
 * 开口的场景（加功能）反而闭嘴。这是个静默失效：看起来跑了，其实永远不说话。
 */
function changesFromCall(kind, params) {
  if (kind === 'edit') {
    return pathsFromParams(params).map((p) => {
      const rel = normRel(p);
      const abs = path.isAbsolute(p) ? p : path.join(REPO_ROOT, rel);
      let exists = false;
      try {
        exists = fs.existsSync(abs);
      } catch {
        exists = false;
      }
      return { status: exists ? 'M' : 'A', path: rel };
    });
  }
  if (kind === 'shell') {
    const cmd = commandFromParams(params);
    const status = DELETE_CMD.test(cmd) ? 'D' : BUILD_CMD.test(cmd) ? 'A' : 'M';
    // shell 命令没有稳定路径可抽；用命令首行做占位，让语句特征成为主要判据。
    const first = cmd.split(/\r?\n/)[0].slice(0, 120);
    return first ? [{ status, path: first }] : [];
  }
  return [];
}

function normRel(p) {
  const s = String(p || '').replace(/\\/g, '/');
  const idx = s.indexOf(REPO_ROOT.replace(/\\/g, '/'));
  return idx >= 0 ? s.slice(idx + REPO_ROOT.length + 1) : s;
}

/** 改动集签名：用于去抖（同一组改动只说一次）。 */
function signatureOf(changes) {
  return changes
    .map((c) => `${c.status}:${c.path}`)
    .sort()
    .join('|')
    .slice(0, 400);
}

function readJson(p) {
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonAtomic(p, obj) {
  const d = path.dirname(p);
  fs.mkdirSync(d, { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, p);
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.on('data', (d) => {
      if (data.length < 1 << 20) data += d;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

async function main() {
  // 门控关 → 零副作用退出（默认状态）。
  if (!isEnabled() || !detectMode) process.exit(0);

  const raw = await readStdin();
  let ctx = {};
  try {
    ctx = JSON.parse(raw || '{}');
  } catch {
    process.exit(0);
  }

  const kind = toolKind(ctx.toolName);
  if (!kind) process.exit(0);

  const changes = changesFromCall(kind, ctx.params);
  if (!changes.length) process.exit(0);

  // 去抖：签名未变就直接退出，不打扰。
  const sig = signatureOf(changes);
  if (!sig) process.exit(0);
  const last = readJson(debouncePath());
  if (last && last.signature === sig) process.exit(0);

  const det = detectMode(changes, String((ctx.params && ctx.params.description) || ''));
  // 置信度太低（没有明确信号）就不开口 —— 宁可少说，不可乱说。
  if (!det || det.confidence < 0.3) process.exit(0);

  const MODE_PROMPT = {
    FIX: '这是修 bug。先别开药 —— 复现了吗？把原始输出留下（repro-before.txt），我要看到它，不要你的转述。',
    BUILD: '这是加功能。先回答我五个问题（谁在什么场景下需要它、现在怎么凑合的、不做会怎样、最小可用形态、怎么验证），答完再动手。',
    DELETE: '这是删东西。先说清楚搓哪儿、多大力、疼了怎么喊停 —— 给一份部位清单和一条**可执行**的回滚命令。',
  };
  const text = MODE_PROMPT[det.mode];
  if (!text) process.exit(0);

  const dir = storeDir();
  fs.mkdirSync(dir, { recursive: true });
  writeJsonAtomic(path.join(dir, 'pending.json'), {
    text,
    mode: det.mode,
    source: 'builtin:AgentFeedbackHint',
    signature: sig,
    confidence: det.confidence,
    ts: Date.now(),
    ackedBy: [],
  });
  writeJsonAtomic(debouncePath(), { signature: sig, mode: det.mode, ts: Date.now() });

  process.exit(0); // 恒放行（PP-3）
}

main().catch(() => process.exit(0)); // fail-open：自身崩溃绝不阻断工具
