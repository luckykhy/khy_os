'use strict';

/**
 * outputIntegrityMonitor.js — 主动监听「输出层软 bug」,能简单修复就修复,修不了就报错并
 * 落到错误日志(单一真源,纯叶子)。
 *
 * 背景(goal 2026-06-25):有一类 bug 不会让进程崩溃、也不在运行时内部状态里(那是
 * [[bugSentinel]] 管的),而是**最终呈现给用户的输出本身**出了问题,用户一眼能看出、
 * 程序却默默放过:
 *
 *   A) 输出不全 / 截断   —— 代码围栏(```)落单未闭合、被硬截断等结构性不完整。
 *   B) 乱码 / mojibake   —— U+FFFD 替换符、UTF-8 被按 Latin1 误解码的经典字节对混进可见文本。
 *   C) 缩放丢行          —— 终端 resize/zoom 时几何尺寸读取失败(rows 为 0/NaN/过期)
 *                          导致增量重绘 under-erase,最后几行内容丢失。
 *
 * 处置策略(对齐用户诉求):**监听 → 能简单修复就修复 → 否则报错 + 存错误日志**。
 *   - 可修复(strip 掉零星替换符 / 闭合围栏 / resize 用兜底 rows 强制全屏重绘):就地修好,记一笔。
 *   - 不可修复(整段乱码、几何彻底测不出):写入错误日志(winston error-%DATE%.log);
 *     strict 模式额外抛 OutputIntegrityError 让 CI/程序硬失败;observe(默认/渲染路径)
 *     绝不抛——抛了会把我们正想保护的那段输出整屏弄没,得不偿失——只记日志 + 返回最佳努力结果。
 *
 * 纯叶子:检测/修复逻辑零 IO、确定性;落日志经**可注入 sink**(默认懒加载 winston logger),
 * 既满足「存错误日志」又保持可单测(__setSink 注入假 sink)。时钟可注入。
 *
 * env:
 *   KHY_OUTPUT_MONITOR = off | observe | strict
 *     off      关闭:全部透传,不检测、不修复、不记日志。
 *     observe  (默认,含渲染路径)检测 + 修复 + 不可修复落错误日志,但**不抛**。
 *     strict   不可修复时除落日志外**抛 OutputIntegrityError**(测试 NODE_ENV==='test' 默认 strict)。
 *   KHY_OUTPUT_MOJIBAKE_RATIO   判「整段乱码不可修」的替换符占比阈值(默认 0.05)。
 */

const MAX_RECORDS = 100;
// 零星替换符的绝对上限:≤ 此数即视为可 strip 的偶发坏字节,不受短文本占比膨胀误伤。
const SPARSE_ABS = 3;

// ── 重复落盘抑制 ────────────────────────────────────────────────────────────
//
// 同一处输出软 bug(比如某个固定的乱码源)每渲染一次就产生一条完全相同的
// 记录,原来一条不落地全写进 error 日志:实测同一行 `mojibake ...
// replacement=40` 在日志里逐字重复几十遍。噪音本身还好说,真正的问题是它掩盖
// 了「这是同一个老问题」这个信息,让用户看到的就是「永远报相同的错误」。
//
// 抑制策略:按 `type|detail` 归并,首次照常落盘,之后只在次数达到 2 的幂时再落
// 一条(带累计次数与被抑制条数),即 1/2/4/8/16… —— 既不淹没日志,也不会让一个
// 持续恶化的问题彻底静音。
//
// 归并表是**有界**的:键数上限 DEDUP_MAX_KEYS,超了按插入序淘汰最老的;单个键
// 静默超过 DEDUP_WINDOW_MS 视为新一轮事件(重新从「首次」开始),这样问题隔了很
// 久再复现时不会被上一轮的计数吞掉。
const DEDUP_MAX_KEYS = 200;
const DEDUP_WINDOW_MS = 5 * 60_000;

// snapshot 的默认观察窗:health 只关心「现在还在发生吗」。原来 snapshot 返回的是
// 进程生命周期内的单调累计值,于是一次瞬时乱码会让 health 那条 yellow 挂到进程
// 退出为止 —— 问题早没了,状态还红着,而且没有任何命令能把它清掉。
const RECENT_WINDOW_MS = 15 * 60_000;

let _clock = () => Date.now();
function __setClock(fn) {
  _clock = typeof fn === 'function' ? fn : () => Date.now();
}

// 落日志出口(可注入):默认懒加载规范 winston logger 的 error 通道(error-%DATE%.log)。
let _sink = null;
function __setSink(fn) {
  _sink = typeof fn === 'function' ? fn : null;
}

// key -> { count, suppressed, lastAt };纯内存,有界。
const _seen = new Map();

function _isPowerOfTwo(n) {
  return n > 0 && (n & (n - 1)) === 0;
}

/**
 * 判断这条记录该不该落盘,并维护归并计数。
 *
 * @returns {null|{count:number, suppressed:number}} null = 本次抑制,不落盘。
 */
function _dedupe(entry) {
  const key = `${entry.type}|${entry.detail}`;
  const now = Number.isFinite(entry.at) ? entry.at : _clock();
  const prev = _seen.get(key);

  if (!prev || now - prev.lastAt > DEDUP_WINDOW_MS) {
    if (!prev && _seen.size >= DEDUP_MAX_KEYS) {
      // Map 保持插入序,删首个即淘汰最老的键;归并表宁可漏抑制也不能无界增长。
      const oldest = _seen.keys().next();
      if (!oldest.done) {
        _seen.delete(oldest.value);
      }
    }
    _seen.set(key, { count: 1, suppressed: 0, lastAt: now });
    return { count: 1, suppressed: 0 };
  }

  prev.count += 1;
  prev.lastAt = now;
  if (_isPowerOfTwo(prev.count)) {
    const suppressed = prev.suppressed;
    prev.suppressed = 0;
    return { count: prev.count, suppressed };
  }
  prev.suppressed += 1;
  return null;
}

function _persist(entry) {
  try {
    const gate = _dedupe(entry);
    if (!gate) {
      return; // 同一条软 bug 的重复出现,已归并计数,不再刷日志
    }
    const enriched =
      gate.count > 1 ? { ...entry, repeat: gate.count, suppressed: gate.suppressed } : entry;
    if (_sink) {
      _sink(enriched);
      return;
    }
    const logger = require('../utils/logger');
    if (logger && typeof logger.error === 'function') {
      const tail =
        gate.count > 1 ? ` (累计 ${gate.count} 次,期间抑制 ${gate.suppressed} 条重复)` : '';
      logger.error(`[outputIntegrity] ${entry.type}: ${entry.detail}${tail}`, enriched);
    }
  } catch {
    /* 落日志失败绝不反噬调用点 */
  }
}

// ── 进程内有界状态(供 health/doctor 被动呈现) ──
const _records = []; // {type, severity, repaired, detail, at}
let _repairedCount = 0;
let _unrepairedCount = 0;

class OutputIntegrityError extends Error {
  constructor(type, detail) {
    super(`[output-integrity] ${type}${detail ? `: ${detail}` : ''}`);
    this.name = 'OutputIntegrityError';
    this.type = type;
    this.isOutputIntegrity = true;
  }
}

function mode(env = process.env) {
  const raw = env && env.KHY_OUTPUT_MONITOR;
  if (raw === 'off' || raw === '0' || raw === 'false') {
    return 'off';
  }
  if (raw === 'strict') {
    return 'strict';
  }
  if (raw === 'observe' || raw === 'on' || raw === '1') {
    return 'observe';
  }
  if (env && env.NODE_ENV === 'test') {
    return 'strict';
  }
  return 'observe';
}

function isEnabled(env = process.env) {
  return mode(env) !== 'off';
}

function _ratioThreshold(env) {
  const v = Number(env && env.KHY_OUTPUT_MOJIBAKE_RATIO);
  return Number.isFinite(v) && v > 0 && v < 1 ? v : 0.05;
}

function _record(rec) {
  _records.push(rec);
  while (_records.length > MAX_RECORDS) {
    _records.shift();
  }
  if (rec.repaired) {
    _repairedCount += 1;
  } else {
    _unrepairedCount += 1;
  }
}

// ── 乱码 / mojibake 检测 ─────────────────────────────────────────────────────
// U+FFFD(�)是解码器对非法字节的占位符(最强信号)。另检测 UTF-8 被当 Latin1/CP1252
// 误解码后的经典可见字节对(用显式 \u 转义避免字符类范围歧义):
//   Ã[-¿]  é/è/ê… 类(UTF-8 0xC3xx 被当 Latin1)
//   â€           ’/“/” 类智能引号(0xE2 0x80 0x99 → â€™ 起始 â€)
//   ï¿½     U+FFFD 自身的 UTF-8 字节(EF BF BD)被当 Latin1(ï¿½)
//   Â[-¿]  ¢/£/©/不间断空格 类(UTF-8 0xC2xx 被当 Latin1)
const _REPLACEMENT_RE = /�/g;
const _MISDECODE_RE = /Ã[-¿]|â€|ï¿½|Â[-¿]/g;

function detectMojibake(text) {
  const s = String(text || '');
  if (!s) {
    return null;
  }
  const repl = (s.match(_REPLACEMENT_RE) || []).length;
  const mis = (s.match(_MISDECODE_RE) || []).length;
  if (repl === 0 && mis < 3) {
    return null;
  } // 保守:零替换符且误解码不足 3 处 → 不判,避免误报
  return { type: 'mojibake', replacement: repl, misdecode: mis, length: s.length };
}

// ── 输出不全 / 结构性截断检测 ────────────────────────────────────────────────
// 代码围栏奇数个 ``` = 恰有一个开围栏没闭合(结构性不完整,可修)。已知的截断尾注
// (salvage 兜底加的「内容较长，已截断」)是预期行为,不算 bug。
const _TRUNCATION_MARKERS = /内容较长，已截断|\[输出可能不完整\]/;
function detectIncomplete(text) {
  const s = String(text || '');
  if (!s) {
    return null;
  }
  const fenceCount = (s.match(/```/g) || []).length;
  const unbalancedFence = fenceCount % 2 === 1;
  const knownTruncation = _TRUNCATION_MARKERS.test(s);
  if (!unbalancedFence) {
    return null;
  }
  return { type: 'incomplete', reason: 'unbalanced-fence', knownTruncation };
}

/** 纯检测:返回软 bug 信号数组(不修改、不落盘)。 */
function inspectText(text) {
  const signals = [];
  const moji = detectMojibake(text);
  if (moji) {
    signals.push(moji);
  }
  const inc = detectIncomplete(text);
  if (inc) {
    signals.push(inc);
  }
  return signals;
}

/**
 * 纯修复尝试:对每个信号尝试「简单修复」。返回 { text, repaired:[], unrepaired:[] }。
 *   - mojibake:零星替换符(占比 < 阈值)→ 直接 strip,判为已修;整段误解码/高占比 → 不可修。
 *   - incomplete(未闭合围栏)→ 末尾补一行 ``` 闭合,判为已修。
 */
function repairText(text, signals, env = process.env) {
  let out = String(text || '');
  const repaired = [];
  const unrepaired = [];
  const ratioMax = _ratioThreshold(env);
  for (const sig of signals) {
    if (sig.type === 'mojibake') {
      const ratio = sig.length > 0 ? sig.replacement / sig.length : 0;
      // 误解码字节对无法无损还原 → 不可修。替换符:零星(绝对数 ≤ SPARSE_ABS)或占比 < 阈值
      // → 可 strip;占比过高且非零星 = 整段坏 → 不可修。绝对小数兜住短文本被占比误伤。
      const sparse = sig.replacement <= SPARSE_ABS || ratio < ratioMax;
      if (sig.misdecode >= 3 || !sparse) {
        unrepaired.push(sig);
      } else if (sig.replacement > 0) {
        out = out.replace(_REPLACEMENT_RE, '');
        repaired.push({ ...sig, fix: 'stripped-replacement-chars' });
      } else {
        unrepaired.push(sig);
      }
    } else if (sig.type === 'incomplete') {
      out = out.replace(/\s*$/, '') + '\n```';
      repaired.push({ ...sig, fix: 'closed-fence' });
    } else {
      unrepaired.push(sig);
    }
  }
  return { text: out, repaired, unrepaired };
}

/**
 * 主入口(文本):监听 → 修复 → 不可修则落错误日志(strict 还抛)。fail-soft:内部异常绝不
 * 反噬渲染路径(strict 抛的 OutputIntegrityError 除外,那是有意的硬失败信号)。
 * @returns {{ text:string, report:{ ok:boolean, repaired:Array, unrepaired:Array } }}
 */
function guardText(text, context = {}, env = process.env) {
  if (!isEnabled(env)) {
    return {
      text: String(text == null ? '' : text),
      report: { ok: true, repaired: [], unrepaired: [] },
    };
  }
  let strictThrow = null;
  try {
    const signals = inspectText(text);
    if (!signals.length) {
      return {
        text: String(text == null ? '' : text),
        report: { ok: true, repaired: [], unrepaired: [] },
      };
    }
    const { text: fixed, repaired, unrepaired } = repairText(text, signals, env);
    const at = _clock();
    for (const r of repaired) {
      _record({ type: r.type, severity: 'info', repaired: true, detail: r.fix || 'repaired', at });
    }
    for (const u of unrepaired) {
      const detail =
        u.type === 'mojibake'
          ? `garbled output unrepairable (replacement=${u.replacement}, misdecode=${u.misdecode}, len=${u.length})`
          : `incomplete output unrepairable (${u.reason || 'unknown'})`;
      _record({ type: u.type, severity: 'error', repaired: false, detail, at });
      _persist({ type: u.type, detail, source: context.source || 'unknown', at });
    }
    // strict:不可修复时抛(渲染路径除外——抛会把要保护的输出整屏弄没)。
    if (unrepaired.length && mode(env) === 'strict' && !context.render) {
      strictThrow = new OutputIntegrityError(
        unrepaired[0].type,
        unrepaired.length > 1 ? `${unrepaired.length} unrepairable signals` : null
      );
    }
    if (strictThrow) {
      throw strictThrow;
    }
    return { text: fixed, report: { ok: unrepaired.length === 0, repaired, unrepaired } };
  } catch (e) {
    if (e && e.isOutputIntegrity) {
      throw e;
    } // 有意的 strict 硬失败,照常抛
    return {
      text: String(text == null ? '' : text),
      report: { ok: true, repaired: [], unrepaired: [] },
    };
  }
}

/**
 * 输出不全(权威信号):截断恢复在 stop_reason=length 上的结局。文本层 detectIncomplete 只能
 * 凭未闭合围栏弱猜,真正可靠的「输出不全」信号在流/loop 层 —— 模型 stop_reason=length
 * (max_tokens)且续写恢复**耗尽/收益递减**仍未补全。loop 已做「简单修复」(累积 + 续写 +
 * 耗尽时贴可见截断提示),此处只补监听器侧的**可观测**:记一笔进 snapshot;**不可修复(未完全
 * 恢复)落错误日志**,对齐用户诉求「监听 → 能修就修 → 否则报错存日志」。纯记录,不抛、不改文本。
 * @param {{recovered?:boolean, continuations?:number, chars?:number, source?:string}} info
 * @returns {{type:'incomplete', recovered:boolean, continuations:number, chars:number}|null}
 */
function noteTruncation(info = {}, env = process.env) {
  if (!isEnabled(env)) {
    return null;
  }
  const recovered = !!info.recovered;
  const continuations = Number(info.continuations) || 0;
  const chars = Number(info.chars) || 0;
  const detail = recovered
    ? `incomplete output recovered after ${continuations} continuation(s), ${chars} chars accumulated`
    : `incomplete output: truncation recovery exhausted after ${continuations} attempt(s), ${chars} chars — finalized with truncation notice`;
  _record({
    type: 'incomplete',
    severity: recovered ? 'info' : 'error',
    repaired: recovered,
    detail,
    at: _clock(),
  });
  // 未完全恢复 = 不可修复的输出不全 → 落错误日志(已恢复仅记 snapshot,不刷错误日志)。
  if (!recovered) {
    _persist({
      type: 'incomplete',
      detail,
      source: info.source || 'truncation-recovery',
      at: _clock(),
    });
  }
  return { type: 'incomplete', recovered, continuations, chars };
}

/**
 * 主入口(缩放几何):判定 resize 重绘策略,规避「缩放丢行」。纯函数。
 *   - off:返回旧策略(shrink+有效rows→full-repaint;否则 incremental),不兜底、不记日志。
 *   - observe/strict:shrink 但 rows 测不出(0/NaN)时,用兜底 rows 仍强制全屏重绘(简单修复),
 *     并把这次「几何不可靠」记入错误日志(否则会落到 incremental 分支 under-erase 丢行)。
 * @param {{prevCols:number,curCols:number,rows:number,isTTY:boolean,fallbackRows?:number}} geom
 * @returns {{ action:'full-repaint'|'incremental', rows:number, riskLineLoss:boolean, detail:string }}
 */
function assessResize(geom = {}, env = process.env) {
  const prevCols = Number(geom.prevCols) || 0;
  const curCols = Number(geom.curCols) || 0;
  const rows = Number(geom.rows);
  const isTTY = geom.isTTY !== false;
  const shrunk = curCols > 0 && prevCols > 0 && curCols < prevCols;
  const grew = curCols > 0 && prevCols > 0 && curCols > prevCols;
  // 列宽任一方向变化都会让终端 reflow 已印行 → ink/log-update 行计数失真 → 增量重绘残线。
  const colsChanged = shrunk || grew;
  const validRows = Number.isFinite(rows) && rows > 0;

  if (!isEnabled(env)) {
    // 监听关 = 逐字节 legacy:仅缩小方向全屏重绘(今日行为),不含放大方向修复。
    return {
      action: shrunk && isTTY && validRows ? 'full-repaint' : 'incremental',
      rows: validRows ? rows : 0,
      riskLineLoss: false,
      detail: 'monitor-off',
    };
  }
  // 缩小(zoom-in)会 under-erase 丢行(ink 会 resync 但增量擦除不足);放大(zoom-out)ink
  // **直接跳过 resync**(见 inkRuntime.getInkInstance 注释)→ log-update 行计数与 reflow 后
  // 的物理行错位 → 残线/重复输入框(用户报「放大缩小后刷屏」)。两个方向都强制全屏重绘 →
  // ink 走 fullscreen 分支写 `clearTerminal + fullStaticOutput`。此处的「一帧干净、累积无关」
  // **依赖 scrollbackPreserve 的清屏归一化**才成立:非 win32 剥掉 3J(2J 本就是就地擦除,
  // 于是可视区被清而 scrollback 保全);win32 则把 ED2 清屏改写成「归位 + ED0」——因为
  // conhost / Windows Terminal 的 ED2 会把旧视口**滚进** scrollback 而非就地擦除,不改写的话
  // 每次全屏重绘反而在回滚里堆叠一份重复 transcript(「同一对话窗口重复显示」)。
  // 仅列宽不变(纯行数变化,无 reflow)才走增量。
  if (colsChanged && isTTY) {
    const dir = shrunk ? 'shrink' : 'grow';
    if (validRows) {
      return { action: 'full-repaint', rows, riskLineLoss: false, detail: `${dir}-valid-rows` };
    }
    const fb = Number(geom.fallbackRows);
    const safeRows = Number.isFinite(fb) && fb > 0 ? Math.floor(fb) : 24;
    const detail = `resize line-loss risk: ${dir} with unreadable rows — forcing full repaint at fallback ${safeRows}`;
    _record({ type: 'line-loss', severity: 'error', repaired: true, detail, at: _clock() });
    _persist({ type: 'line-loss', detail, source: geom.source || 'resize', at: _clock() });
    return { action: 'full-repaint', rows: safeRows, riskLineLoss: true, detail };
  }
  return {
    action: 'incremental',
    rows: validRows ? rows : 0,
    riskLineLoss: false,
    detail: colsChanged ? 'cols-changed-non-tty' : 'equal-cols',
  };
}

// ── 被动呈现契约(供 khy health / doctor) ──
/**
 * 当前状态快照。
 *
 * repaired / unrepaired / byType 是**窗口内**(默认 RECENT_WINDOW_MS)的计数,
 * 让 health 在问题停止发生后能自行转绿;进程生命周期累计值另放 lifetime 里,
 * 需要看历史总量的调用方读它。
 *
 * @param {object} [opts]
 * @param {number} [opts.windowMs] - 观察窗宽度,默认 RECENT_WINDOW_MS。
 */
function snapshot(opts = {}) {
  const windowMs =
    Number.isFinite(opts.windowMs) && opts.windowMs > 0 ? opts.windowMs : RECENT_WINDOW_MS;
  const since = _clock() - windowMs;
  const byType = {};
  let repaired = 0;
  let unrepaired = 0;
  for (const r of _records) {
    if (Number.isFinite(r.at) && r.at < since) {
      continue;
    }
    byType[r.type] = (byType[r.type] || 0) + 1;
    if (r.repaired) {
      repaired += 1;
    } else {
      unrepaired += 1;
    }
  }
  return {
    mode: mode(),
    windowMs,
    repaired,
    unrepaired,
    byType,
    lifetime: { repaired: _repairedCount, unrepaired: _unrepairedCount },
    recent: _records.slice(-10),
  };
}

// 进程生命周期语义:「本进程是否曾经出现过输出软 bug」。判「现在是否仍在发生」
// 请读 snapshot() 的窗口计数,别用这个。
function hasSignal() {
  return _repairedCount > 0 || _unrepairedCount > 0;
}

function reset() {
  _records.length = 0;
  _repairedCount = 0;
  _unrepairedCount = 0;
  _seen.clear();
}

module.exports = {
  mode,
  isEnabled,
  detectMojibake,
  detectIncomplete,
  inspectText,
  repairText,
  guardText,
  noteTruncation,
  assessResize,
  snapshot,
  hasSignal,
  reset,
  OutputIntegrityError,
  __setClock,
  __setSink,
};
