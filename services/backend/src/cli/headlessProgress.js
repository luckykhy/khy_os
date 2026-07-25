'use strict';

/**
 * headlessProgress.js — headless `khy -p` 执行过程的人类友好进度反馈(CC `-p` TTY 对齐)。
 *
 * 背景(dogfood 实测):headless 经 runToolUseLoop 真执行工具后,人类全程零反馈——text 模式
 * 整段沉默(实测 8 轮 142s 空屏),stream-json 也只吐 init→user→assistant(final)→result,
 * 无中间 tool_use/tool_result 事件。Claude Code 的 `-p` 在 TTY 里会实时显示工具活动。
 *
 * 本叶子只产**显示字符串**(纯函数·零 IO·确定性·fail-soft),由 bin/khy.js 在原生循环的
 * onToolCall/onToolResult 回调里写 **stderr**——stdout 的机器契约(text/json/stream-json)
 * 逐字节不动,pipe/重定向安全。图标/显示名复用 renderTheme 保持与 TUI 一致,require 失败则
 * 本地兜底(绝不让进度反馈把主流程带崩)。
 *
 * 门控 KHY_HEADLESS_PROGRESS(default-on·CANON·parent=KHY_HEADLESS_NATIVE_LOOP)。
 * shouldEmitProgress:auto 档仅 stderr 是 TTY 才发(重定向到文件的 stderr 不被污染),
 * 显式 KHY_HEADLESS_PROGRESS=1|true|on|yes|force 可在非 TTY 强开(测试/CI)。
 */

const flagRegistry = require('../services/flagRegistry');

// 从工具参数里择一条最能说明「在干什么」的显著字段(路径/命令/查询等),截断避免刷屏。
const _PARAM_KEYS = [
  'path', 'file', 'file_path', 'filePath', 'command', 'cmd',
  'pattern', 'query', 'url', 'name', 'subagent_type',
];
const _ARG_MAX = 56;

// ── renderTheme 显示助手(require 失败则本地兜底,fail-soft)──────────────────────────
function _theme() {
  try {
    return require('./renderTheme');
  } catch {
    return null;
  }
}

function _displayName(name) {
  const t = _theme();
  try {
    if (t && typeof t.getToolDisplayName === 'function') {
      return t.getToolDisplayName(name) || String(name || 'tool');
    }
  } catch { /* fall through */ }
  return String(name || 'tool');
}

function _icon(name) {
  const t = _theme();
  try {
    if (t && typeof t.getToolFamilyIcon === 'function') {
      const ic = t.getToolFamilyIcon(name);
      if (ic) return ic;
    }
  } catch { /* fall through */ }
  return '•';
}

function _dotSuccess() {
  const t = _theme();
  try { if (t && t.DOT_SUCCESS) return t.DOT_SUCCESS; } catch { /* noop */ }
  return '●';
}

function _dotError() {
  const t = _theme();
  try { if (t && t.DOT_ERROR) return t.DOT_ERROR; } catch { /* noop */ }
  return '●';
}

// renderTheme._formatElapsed 吃**秒**;此处自带一个 ms→人类可读的独立格式(不依赖它)以免口径错配。
function _formatMs(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1000) return `${Math.round(n)}ms`;
  const sec = n / 1000;
  if (sec < 60) {
    // 1 位小数,去掉末尾 .0
    const s = sec.toFixed(1).replace(/\.0$/, '');
    // toFixed 会把 [59.95, 60) 窗口进位成 "60.0"→"60";它必须进位成 "1m",
    // 而非打出越界的 "60s"。只有这一个进位串会落到下面的分钟分支。
    if (s !== '60') return `${s}s`;
  }
  // 分钟+ 显示:min 与 rem 都从**同一个**四舍五入后的整秒数派生。
  // 若像旧代码那样 floor(sec/60) 与 round(sec%60) 各自独立取整,余数可能
  // 进位到 60(如 119.6s→"1m 60s"=越界时钟串)而分钟不进位;单一整秒数永
  // 不会这样。对既有正确整秒输入(65→"1m 5s"、60→"1m"…)逐字节等价。
  const totalSec = Math.round(sec);
  const min = Math.floor(totalSec / 60);
  const rem = totalSec % 60;
  return rem > 0 ? `${min}m ${rem}s` : `${min}m`;
}

/**
 * 从工具参数对象/字符串里提取一条显著参数用于展示。返回 '' 表示无可展示项。
 */
function _salientArg(params) {
  if (params == null) return '';
  if (typeof params === 'string') {
    const s = params.trim().replace(/\s+/g, ' ');
    return s.length > _ARG_MAX ? `${s.slice(0, _ARG_MAX)}…` : s;
  }
  if (typeof params !== 'object') return '';
  for (const key of _PARAM_KEYS) {
    const v = params[key];
    if (typeof v === 'string' && v.trim()) {
      const s = v.trim().replace(/\s+/g, ' ');
      return s.length > _ARG_MAX ? `${s.slice(0, _ARG_MAX)}…` : s;
    }
  }
  return '';
}

// ── 结果内容摘要(KHY_HEADLESS_PROGRESS_DETAIL)────────────────────────────────────
// 今日结果行只吐「完成 + 耗时」,零内容。CC `-p` 会显示「读取 N 行 / 更新 X (+a −b) / N 处匹配」等。
// 下面几个纯助手从 result(及 _khyWriteDiff)萃取一句 CC 风格摘要,门开时附到成功结果行尾。

// 路径末段(basename)。跨平台切 / 与 \,取最后非空段;无则返原串。纯函数。
function _basename(p) {
  if (typeof p !== 'string' || !p) return '';
  const parts = p.split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : p;
}

// 归一化工具名用于家族判定:小写并剥分隔符(readFile/read_file/read-file → readfile)。
function _normName(name) {
  return String(name || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
}

// 多重集行级增删计数(before/after 皆为整文件文本)。逐行入多重集,取正差:
//   added = Σ max(0, after 计数 − before 计数);removed = 反之。就地改一行 → +1 −1(比净行差有意义)。
// 纯函数、O(n)、绝不抛。仅用于摘要显示,非 /cost 净行账本(codeChangeStats 那套另有用途)。
function _diffLineCounts(before, after) {
  try {
    const b = typeof before === 'string' ? before.split('\n') : [];
    const a = typeof after === 'string' ? after.split('\n') : [];
    const bc = new Map();
    for (const l of b) bc.set(l, (bc.get(l) || 0) + 1);
    const ac = new Map();
    for (const l of a) ac.set(l, (ac.get(l) || 0) + 1);
    let added = 0;
    let removed = 0;
    for (const [l, c] of ac) added += Math.max(0, c - (bc.get(l) || 0));
    for (const [l, c] of bc) removed += Math.max(0, c - (ac.get(l) || 0));
    return { added, removed };
  } catch {
    return { added: 0, removed: 0 };
  }
}

/**
 * 从成功的工具 result 萃取一句人类友好的内容摘要(无前导分隔符)。无可摘要项 → ''。
 * 纯函数、fail-soft。按工具家族分派:读取/编辑/写入/搜索(grep)/文件(glob)/命令(shell)。
 */
function _summarizeResultContent(name, result, params) {
  try {
    if (!result || typeof result !== 'object') return '';
    const fam = _normName(name);
    const p = params && typeof params === 'object' ? params : {};
    const wd = result._khyWriteDiff && typeof result._khyWriteDiff === 'object' ? result._khyWriteDiff : null;

    // 读取:读了多少行(截断加注)。
    if (fam === 'read' || fam === 'readfile') {
      if (Number.isFinite(result.lines)) {
        return `读取 ${result.lines} 行${result.truncated ? '(截断)' : ''}`;
      }
      return '';
    }
    // 编辑:真 diff 优先算 +a −b;否则回退工具自带的 message(如 "Replaced N occurrences in X")。
    if (fam === 'edit' || fam === 'editfile' || fam === 'multiedit') {
      const base = _basename((wd && wd.filePath) || p.file_path || p.path || p.filePath || '');
      if (wd && typeof wd.beforeContent === 'string' && typeof wd.afterContent === 'string') {
        const { added, removed } = _diffLineCounts(wd.beforeContent, wd.afterContent);
        return `更新 ${base || '文件'} (+${added} −${removed})`;
      }
      if (typeof result.message === 'string' && result.message.trim()) {
        const m = result.message.trim().replace(/\s+/g, ' ');
        return m.length > _ARG_MAX ? `${m.slice(0, _ARG_MAX)}…` : m;
      }
      return base ? `更新 ${base}` : '';
    }
    // 写入/新建:按写入行数计(新建 before='' → after 全部行)。
    if (fam === 'write' || fam === 'writefile') {
      const base = _basename((wd && wd.filePath) || p.file_path || p.path || p.filePath || '');
      if (wd && typeof wd.afterContent === 'string') {
        const lines = wd.afterContent === '' ? 0 : wd.afterContent.split('\n').length;
        return `写入 ${base || '文件'}(${lines} 行)`;
      }
      if (Number.isFinite(result.bytes)) return `写入 ${base || '文件'}(${result.bytes} 字节)`;
      return base ? `写入 ${base}` : '';
    }
    // 搜索(grep):匹配处数。
    if (fam === 'grep' || fam === 'search' || fam === 'ripgrep') {
      if (Number.isFinite(result.count)) return `${result.count} 处匹配${result.truncated ? '(截断)' : ''}`;
      if (Array.isArray(result.matches)) return `${result.matches.length} 处匹配`;
      return '';
    }
    // 文件(glob):命中文件数。
    if (fam === 'glob' || fam === 'globtool' || fam === 'findfiles') {
      if (Number.isFinite(result.count)) return `${result.count} 个文件${result.truncated ? '(截断)' : ''}`;
      if (Array.isArray(result.files)) return `${result.files.length} 个文件`;
      return '';
    }
    // 命令(shell/bash):退出码 + 输出行数。
    if (fam === 'shell' || fam === 'shellcommand' || fam === 'bash' || fam === 'runcommand' || fam === 'executecode') {
      const hasExit = Number.isFinite(result.exitCode);
      const out = typeof result.output === 'string' ? result.output : '';
      const outLines = out ? out.split('\n').filter((l) => l.length > 0).length : 0;
      if (hasExit) return outLines > 0 ? `退出码 ${result.exitCode} · ${outLines} 行` : `退出码 ${result.exitCode}`;
      return '';
    }
    return '';
  } catch {
    return '';
  }
}

// ── 门控 ────────────────────────────────────────────────────────────────────────────
function isHeadlessProgressEnabled(env = process.env) {
  try {
    return flagRegistry.isFlagEnabled('KHY_HEADLESS_PROGRESS', env || {});
  } catch {
    return false;
  }
}

// 结果行内容摘要子门(KHY_HEADLESS_PROGRESS_DETAIL·default-on·parent=KHY_HEADLESS_PROGRESS)。
// 关 → formatToolResult 逐字节回退今日「完成 + 耗时」终态。fail-soft:注册表异常按关处理(不冒进)。
function isDetailEnabled(env = process.env) {
  try {
    return flagRegistry.isFlagEnabled('KHY_HEADLESS_PROGRESS_DETAIL', env || {});
  } catch {
    return false;
  }
}

// 中间叙述文本子门(KHY_HEADLESS_PROGRESS_TEXT·default-on·parent=KHY_HEADLESS_PROGRESS)。
// 关 → bin/khy.js 不给 chatOpts 挂 onChunk,过程散文继续沉默(逐字节回退)。fail-soft:异常按关处理。
function isTextEnabled(env = process.env) {
  try {
    return flagRegistry.isFlagEnabled('KHY_HEADLESS_PROGRESS_TEXT', env || {});
  } catch {
    return false;
  }
}

// 长时工具心跳子门(KHY_HEADLESS_PROGRESS_HEARTBEAT·default-on·parent=KHY_HEADLESS_PROGRESS)。
// 关 → bin/khy.js 不起心跳定时器,逐字节回退今日 start→静默→result。fail-soft:异常按关处理。
function isHeartbeatEnabled(env = process.env) {
  try {
    return flagRegistry.isFlagEnabled('KHY_HEADLESS_PROGRESS_HEARTBEAT', env || {});
  } catch {
    return false;
  }
}

// 原生循环整段抛错时的回退诊断子门(KHY_HEADLESS_LOOP_FALLBACK_DIAG·default-on·CANON·
// parent=KHY_HEADLESS_NATIVE_LOOP)。今日 bin/khy.js 的 catch 静默吞异常回退单发 chat(),用户不知
// 富工具循环被放弃(得到降级答案却零线索)。关 → 逐字节回退今日静默。fail-soft:异常按关处理。
function isLoopFallbackDiagEnabled(env = process.env) {
  try {
    return flagRegistry.isFlagEnabled('KHY_HEADLESS_LOOP_FALLBACK_DIAG', env || {});
  } catch {
    return false;
  }
}

/**
 * headless 原生工具循环抛错 → 回退单发前的一行 stderr 诊断(纯函数·fail-soft·绝不抛)。
 * `  ⚠ 原生工具循环失败,回退单发{ · 错误摘要}`——err 无消息则只给通用文案。仅写 stderr,stdout 不动。
 */
function formatLoopFallbackDiag(err) {
  try {
    let msg = '';
    if (err && typeof err.message === 'string') msg = err.message;
    else if (typeof err === 'string') msg = err;
    msg = String(msg || '').trim().replace(/\s+/g, ' ');
    if (msg.length > _ARG_MAX) msg = `${msg.slice(0, _ARG_MAX)}…`;
    return msg ? `  ⚠ 原生工具循环失败,回退单发 · ${msg}` : '  ⚠ 原生工具循环失败,回退单发';
  } catch {
    return '  ⚠ 原生工具循环失败,回退单发';
  }
}

// 心跳最短触发与重发间隔(ms):工具运行满 5s 才首发,此后每 5s 补一行。
const HEARTBEAT_MIN_MS = 5000;
const HEARTBEAT_INTERVAL_MS = 5000;

/**
 * 长时工具心跳行:`  ⏳ {displayName} 运行中 {elapsed}`(缩进 2 空格,置于 start 行之后)。
 * 纯函数、fail-soft。elapsedMs 无效 → ''(调用方据此跳过)。显示名复用 renderTheme 与 start 行一致。
 */
function formatToolHeartbeat(name, elapsedMs) {
  try {
    const el = _formatMs(elapsedMs);
    if (!el) return '';
    return `  ⏳ ${_displayName(name)} 运行中 ${el}`;
  } catch {
    return '';
  }
}

// 每行叙述前缀:一条细竖线,视觉上与工具行(图标/2 空格缩进)区分,又不喧宾夺主。
const _TEXT_PREFIX = '│ ';
const _TEXT_MAX = 4000; // 单块叙述展示上限(极长散文截断,避免刷屏)。

/**
 * 把 loop 补发的中间叙述文本(工具调用前的「说明」散文)格式化为 stderr 可读块。
 * - 非串/空白 → ''(调用方据此跳过,不写空行)。
 * - 折叠 3+ 连续空行为 1、逐行右侧去空白、每行加细竖线前缀,块尾不带换行(由调用方补)。
 * 纯函数、fail-soft、绝不抛。仅供 headless stderr 叙述,不影响 stdout finalResponse。
 */
function formatAssistantText(text) {
  try {
    if (typeof text !== 'string') return '';
    let s = text.replace(/\r\n/g, '\n');
    if (s.length > _TEXT_MAX) s = `${s.slice(0, _TEXT_MAX)}…`;
    const trimmed = s.trim();
    if (!trimmed) return '';
    // 逐行右侧去空白;折叠内部连续空行为最多一行;丢弃首尾空行。
    const rawLines = trimmed.split('\n').map((l) => l.replace(/\s+$/, ''));
    const out = [];
    let blank = 0;
    for (const l of rawLines) {
      if (l === '') {
        blank += 1;
        if (blank > 1) continue;
      } else {
        blank = 0;
      }
      out.push(l === '' ? '' : `${_TEXT_PREFIX}${l}`);
    }
    while (out.length && out[out.length - 1] === '') out.pop();
    return out.join('\n');
  } catch {
    return '';
  }
}

// 助手中间消息前缀:一个对话气泡图标,视觉上明确标记「这是 khy 对你说的话」
// (视觉路由场景:文本模型先说明「我无法识别图片,正在调用视觉模型」),区别于
// `│ ` 工具叙述前缀与工具行的图标缩进。
const _MSG_PREFIX = '💬 ';
const _MSG_MAX = 4000; // 单条中间消息展示上限(极长内容截断,避免刷屏)。

/**
 * 把 gateway 发来的 assistant_message chunk(用户可见的中间消息,如视觉路由说明)
 * 格式化为 stderr 可读块。与 formatAssistantText 的区别:这是**面向用户的一句话**
 * (非工具调用前的散文叙述),故用对话气泡图标而非细竖线前缀。
 * - 非串/空白 → ''(调用方据此跳过,不写空行)。
 * - 折叠 3+ 连续空行为 1、逐行右侧去空白、首行加气泡前缀、块尾不带换行(由调用方补)。
 * 纯函数、fail-soft、绝不抛。仅供 headless stderr 渲染,不影响 stdout finalResponse。
 */
function formatAssistantMessage(content) {
  try {
    if (typeof content !== 'string') return '';
    let s = content.replace(/\r\n/g, '\n');
    if (s.length > _MSG_MAX) s = `${s.slice(0, _MSG_MAX)}…`;
    const trimmed = s.trim();
    if (!trimmed) return '';
    const rawLines = trimmed.split('\n').map((l) => l.replace(/\s+$/, ''));
    const out = [];
    let blank = 0;
    let first = true;
    for (const l of rawLines) {
      if (l === '') {
        blank += 1;
        if (blank > 1) continue;
        out.push('');
      } else {
        blank = 0;
        // 首行加气泡图标;续行对齐缩进(气泡占位),保持视觉块感。
        out.push(first ? `${_MSG_PREFIX}${l}` : `   ${l}`);
        first = false;
      }
    }
    while (out.length && out[out.length - 1] === '') out.pop();
    return out.join('\n');
  } catch {
    return '';
  }
}

const _FORCE_RE = /^(1|true|on|yes|force)$/i;

/**
 * 是否应实际发送进度到 stderr。
 * - 门关 → 永不发(逐字节回退今日沉默)。
 * - 门开 + 显式强开值(1|true|on|yes|force)→ 发(非 TTY 也发,供测试/CI)。
 * - 门开 + auto → 仅 stderr 是 TTY 才发(重定向到文件不污染日志),对齐 CC `-p`。
 */
function shouldEmitProgress(env = process.env, isTTY = false) {
  if (!isHeadlessProgressEnabled(env)) return false;
  const raw = env && env.KHY_HEADLESS_PROGRESS;
  if (typeof raw === 'string' && _FORCE_RE.test(raw.trim())) return true;
  return !!isTTY;
}

/**
 * 工具开始行:`{icon} {displayName} {salientArg}`
 */
function formatToolStart(name, params) {
  try {
    const icon = _icon(name);
    const disp = _displayName(name);
    const arg = _salientArg(params);
    return arg ? `${icon} ${disp} ${arg}` : `${icon} ${disp}`;
  } catch {
    return `• ${String(name || 'tool')}`;
  }
}

/**
 * 工具结果行:`  {✓/✗} {elapsed}{ · 内容摘要 / err}`(缩进 2 空格,置于对应 start 行下)。
 * - 失败:`  ● 失败 {elapsed} · {errText}`(不变)。
 * - 成功 + 明细门开(KHY_HEADLESS_PROGRESS_DETAIL):`  ● 完成 {elapsed} · {内容摘要}`——
 *   摘要来自 _summarizeResultContent(读取 N 行 / 更新 X (+a −b) / N 处匹配 …),对齐 CC `-p`。
 * - 成功 + 明细门关:逐字节回退今日 `  ● 完成 {elapsed}` 终态。
 * params(可选·第 4 参)为该工具调用入参,供编辑/写入摘要取 basename;env(第 5 参)供门控与测试注入。
 */
function formatToolResult(name, result, elapsedMs, params, env = process.env) {
  try {
    let failed = false;
    let errText = '';
    if (result && typeof result === 'object') {
      if (result.error || result.isError || result.is_error) {
        failed = true;
        const e = result.error || result.message || '';
        errText = typeof e === 'string' ? e : '';
      }
    }
    const dot = failed ? _dotError() : _dotSuccess();
    const mark = failed ? `${dot} 失败` : `${dot} 完成`;
    const el = _formatMs(elapsedMs);
    let line = `  ${mark}`;
    if (el) line += ` ${el}`;
    if (failed && errText) {
      const e = errText.trim().replace(/\s+/g, ' ');
      line += ` · ${e.length > _ARG_MAX ? `${e.slice(0, _ARG_MAX)}…` : e}`;
    } else if (!failed && isDetailEnabled(env)) {
      const summary = _summarizeResultContent(name, result, params);
      if (summary) line += ` · ${summary}`;
    }
    return line;
  } catch {
    return '  ● 完成';
  }
}

module.exports = {
  isHeadlessProgressEnabled,
  isDetailEnabled,
  isTextEnabled,
  isHeartbeatEnabled,
  isLoopFallbackDiagEnabled,
  shouldEmitProgress,
  formatToolStart,
  formatToolResult,
  formatAssistantText,
  formatAssistantMessage,
  formatToolHeartbeat,
  formatLoopFallbackDiag,
  // 供测试
  _salientArg,
  _formatMs,
  _basename,
  _diffLineCounts,
  _summarizeResultContent,
  HEARTBEAT_MIN_MS,
  HEARTBEAT_INTERVAL_MS,
};
