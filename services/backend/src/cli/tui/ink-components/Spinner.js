'use strict';

/**
 * Spinner — palindrome braille animation indicator (CC-aligned).
 *
 * Uses ink (official) via inkRuntime. Honours reduced-motion by falling back to
 * a static dot when animation is disabled.
 */
const React = require('react');

const inkRuntime = require('../inkRuntime');

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
// Braille rotation cadence — stable, decoupled from the elapsed heartbeat
// (App.js nowTick) and from label/detail prop churn. Routed through the
// perfTunables leaf (single source: default 160ms, env KHY_SPINNER_FRAME_MS /
// KHY_TUI_LOW_POWER override). Fail-soft require, same style as the ccFormat
// require above: leaf unavailable → legacy hard-coded 80ms (~12.5fps).
let FRAME_MS = 80;
try {
  FRAME_MS = require('../perfTunables').spinnerFrameMs(process.env);
} catch {
  FRAME_MS = 80;
}
const REDUCED_MOTION = process.env.KHY_REDUCED_MOTION === '1';

// CC 后端口径对齐:live spinner 的「已用时长 / 已流式 token 数」走与页脚/回合统计同一套
// ccFormat SSOT。CC 的 SpinnerAnimationRow(src/components/Spinner/SpinnerAnimationRow.tsx:170,178)
// 渲的是 `formatDuration(elapsedMs)`(≥60s → "1m 30s")+ `formatNumber(tokens)`(紧凑 → "1.2k"),
// 不是原始秒数 / 原始整数。Khy 原 `${elapsedSec}s` 在 ≥60s 时显 "90s"(而非 "1m 30s")、
// `~${tokens} tok` 显原始整数 "~1234 tok"(而非 "~1.2k tok")。
//   早先 memory 误判「紧凑格式是 CC 的已提交风格、live 提示用途不同」——读 CC **live** spinner 源后
//   否决:CC 的 live spinner 本身就用 formatNumber 紧凑渲染。这里保留 Khy 的「~N tok」「Ns」措辞
//   结构(approximate 提示),只把其中的**数**与**时长**路由进 ccFormat SSOT。
//   门控 KHY_SPINNER_CC_FORMAT(默认开)→ 走 ccFormat;关 → 逐字节回退旧的原始秒 / 原始整数。
//   ccFormat require 包在 try 里,任何异常静默回退,绝不让 spinner 渲染抛错。
//
// CC 另把「计时 + token 计数」整体压在一个 30s 阈值之后才显示(SHOW_TOKENS_AFTER_MS = 30_000,
// `wantsTimerAndTokens = verbose || hasRunningTeammates || effectiveElapsedMs > 30000`)——短回合
// spinner 保持干净,只有拖过 30s 才浮出进度 meta。这条 reveal 判据**早有纯叶子 SSOT**
// `cli/spinnerMeta.js`(经典 REPL spinner `cli/spinner.js` 已消费,门控 KHY_SPINNER_META_GATE)。
// ink TUI 这条 `buildSpinnerMeta` 路径此前**从第 1 秒即显**(无阈值)= 与 CC 及 khy 自己的经典
// spinner 双双不一致。这里**复用同一个叶子 + 同一个门控**收敛,绝不另起一套阈值/门控(SSOT)。
// khy 这条路径无 verbose / running-teammates 概念 → 仅 30s 钟生效(诚实映射,绝不伪造旁路)。
// require 包在 try 里:叶子不可用 → 跌穿到「照常显示」(绝不因加载失败而静默吞掉 meta)。
// 进度 meta 的组装。opts.skipDuration 供**停滞行**使用:那一行已经用实际停滞秒数写了
// 「（已 Ns）」，若 meta 再拼一次同样的时长,用户会看到两个数。只跳过时长那段,不动
// tokens —— tokens 是另一件事,没有重复问题。
// 顺带记一笔:此前调用点把 Date.now() 当 elapsedSec 传进来,meta 里渲染出
// 「 · 20719231d」这种天文数字(实测值)。阈值门拦住的是「秒数太小」,拦不住「秒数离谱」,
// 所以修的是源头(改走 _spinnerProgress),不是在这里夹一个上限。
function buildSpinnerMeta(elapsedSec, tokens, env = process.env, opts = {}) {
  const sec = Number(elapsedSec) || 0;
  try {
    const sm = require('../../spinnerMeta');
    if (!sm.shouldShowTimerAndTokens({ elapsedMs: sec * 1000, gateEnabled: sm.isEnabled(env) })) {
      return '';
    }
  } catch {
    /* spinnerMeta leaf unavailable → fall through and show meta (legacy) */
  }
  const v = String((env && env.KHY_SPINNER_CC_FORMAT) || '')
    .trim()
    .toLowerCase();
  const ccMode = !(v === '0' || v === 'false' || v === 'off' || v === 'no');
  let fmtDur = null;
  let fmtTok = null;
  if (ccMode) {
    try {
      const m = require('../../ccFormat');
      // Use mostSignificantOnly: avoid redundant "1m 1s", "1h 1m 1s"
      // Under 60s → "12s", 1-60min → "5m", over 1h → "1h"
      fmtDur = (ms) => m.ccFormatDuration(ms, { mostSignificantOnly: true });
      fmtTok = m.ccFormatTokens;
    } catch {
      fmtDur = null;
      fmtTok = null;
    }
  }
  const meta = [];
  if (sec > 0 && opts.skipDuration !== true) {
    meta.push(typeof fmtDur === 'function' ? fmtDur(sec * 1000) || `${sec}s` : `${sec}s`);
  }
  const tok = Number(tokens) || 0;
  if (tok > 0) {
    meta.push(typeof fmtTok === 'function' ? `~${fmtTok(tok)} tok` : `~${tok} tok`);
  }
  return meta.length ? ` · ${meta.join(' · ')}` : '';
}

/**
 * 等待行的组装(纯函数 → 无条件可单测,不必等 ink 渲染环境就位)。
 *
 * 规则 2.5 的形状是 `⏳ 等待中 · <在等什么>（已 <Ns>）`:指示词固定,它后面的**全部**是实际数据
 * —— 目标是网关自报的 detail 或相位链 label,秒数是 stalledSec(lastActivity 到现在的真实间隔)。
 * 红线是「只写 ⏳ 等待中 不说在等什么、等多久」,所以有秒数就必须带上;没有目标时也不能退化成
 * 光秃秃一句「⏳ 等待中」而不带任何数(那正是规则里的 ❌ 反例)。
 * @param {string} displayText 目标(detail 优先,否则 label)
 * @param {number} stalledSec 实际停滞秒数(0 = 未停滞/未知 → 不加后缀)
 * @param {string} [indicator] 固定指示词,便于测试与将来换语种
 * @returns {string}
 */
function buildStallLine(displayText, stalledSec, indicator = '⏳ 等待中') {
  const text = String(displayText || '')
    .replace(/\s+/g, ' ')
    .trim();
  const secs = Number(stalledSec) || 0;
  const suffix = secs > 0 ? `（已 ${secs}s）` : '';
  return text ? `${indicator} · ${text}${suffix}` : `${indicator}${suffix}`;
}

function Spinner({
  label = '',
  color = 'yellow',
  elapsedSec = 0,
  tokens = 0,
  stalled = false,
  stalledSec = 0,
  detail = '',
}) {
  const { Text } = inkRuntime.get();
  const [frame, setFrame] = React.useState(0);
  const [stallPulse, setStallPulse] = React.useState(false);
  const h = React.createElement;

  React.useEffect(() => {
    if (REDUCED_MOTION) {
      return undefined;
    }
    const startedAt = Date.now();
    const id = setInterval(() => {
      setFrame(Math.floor((Date.now() - startedAt) / FRAME_MS) % FRAMES.length);
    }, FRAME_MS);
    return () => clearInterval(id);
  }, []);

  // Stall pulse: when stalled, alternate the indicator brightness every 600ms
  // so "⏳ 等待响应…" breathes rather than sitting static — draws the eye without
  // being distracting.
  React.useEffect(() => {
    if (!stalled || REDUCED_MOTION) {
      setStallPulse(false);
      return;
    }
    const id = setInterval(() => setStallPulse((p) => !p), 600);
    return () => clearInterval(id);
  }, [stalled]);

  const glyph = REDUCED_MOTION ? '●' : FRAMES[frame];
  const glyphColor = stalled ? 'red' : color;

  // Detail from gateway carries action+target+progress (e.g. "读取 src/index.js").
  // Label is the fallback phase description (e.g. "分析约束与计划").
  // Always prefer detail when available — it's more specific.
  const detailText = String(detail || '').replace(/\s+/g, ' ').trim();
  const labelText = String(label || '').replace(/\s+/g, ' ').trim();
  const displayText = detailText || labelText;

  // When stalled: show "⏳ 等待中 · <what we're waiting for>（已 Ns）".
  // 组装走 buildStallLine(纯函数,文案契约在 tests/cli/spinnerStallLine.test.js 锁着),
  // 组件只负责把实际数据喂进去。
  const showStallIndicator = stalled;
  const stallSecs = Number(stalledSec) || 0;
  const stallLine = buildStallLine(displayText, stallSecs);

  // Pulse the stall indicator so user can see it's waiting, not frozen.
  const stallTextColor = stalled && stallPulse ? 'yellow' : 'gray';

  // Progress metadata: elapsed time + token count.
  // 停滞时跳过时长段 —— 等待行已经用（已 Ns）表达了它,再拼一次就是同一个数出现两遍。
  const metaStr = buildSpinnerMeta(elapsedSec, tokens, process.env, {
    skipDuration: showStallIndicator && stallSecs > 0,
  });

  return h(
    Text,
    null,
    h(Text, { color: glyphColor }, glyph),
    ' ',
    showStallIndicator
      ? h(Text, { color: stallTextColor }, stallLine)
      : h(Text, { color: glyphColor }, displayText),
    metaStr ? h(Text, { dimColor: true }, metaStr) : null
  );
}

// Re-render narrowing: memoize so App's keystroke re-renders stop re-rendering
// the spinner row when nothing it shows has changed. Props AUDIT (callers in
// App.js): label/color/detail are strings, elapsedSec/tokens are numbers,
// stalled is a boolean — all primitives, so React.memo's default shallow
// compare is naturally effective; no custom areEqual needed. The braille
// animation itself is internal state (setInterval → setFrame) and is untouched
// by memoization. Gate KHY_TUI_COMPONENT_MEMO, DEFAULT ON;
// '0'/'false'/'off'/'no' restores the plain export.
function _componentMemoOff(env) {
  const v = String((env && env.KHY_TUI_COMPONENT_MEMO) || '')
    .trim()
    .toLowerCase();
  return v === '0' || v === 'false' || v === 'off' || v === 'no';
}
module.exports = _componentMemoOff(process.env) ? Spinner : React.memo(Spinner);
// Static helper attaches to the EXPORTED object (memo or plain) so tests keep
// reaching it via require('./Spinner').buildSpinnerMeta either way.
module.exports.buildSpinnerMeta = buildSpinnerMeta;
// 等待行文案的纯组装函数:导出是为了让「⏳ 等待中 · 目标（已 Ns）」这条规则 2.5 契约
// 能在任何环境下单测(ink 渲染环境在 CI/本机可能缺席,那正是这类文案缺陷长期没被测到的原因)。
module.exports.buildStallLine = buildStallLine;
