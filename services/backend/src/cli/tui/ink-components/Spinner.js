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
function buildSpinnerMeta(elapsedSec, tokens, env = process.env) {
  const sec = Number(elapsedSec) || 0;
  try {
    const sm = require('../../spinnerMeta');
    if (!sm.shouldShowTimerAndTokens({ elapsedMs: sec * 1000, gateEnabled: sm.isEnabled(env) })) {
      return '';
    }
  } catch { /* spinnerMeta leaf unavailable → fall through and show meta (legacy) */ }
  const v = String((env && env.KHY_SPINNER_CC_FORMAT) || '').trim().toLowerCase();
  const ccMode = !(v === '0' || v === 'false' || v === 'off' || v === 'no');
  let fmtDur = null;
  let fmtTok = null;
  if (ccMode) {
    try { const m = require('../../ccFormat'); fmtDur = m.ccFormatDuration; fmtTok = m.ccFormatTokens; }
    catch { fmtDur = null; fmtTok = null; }
  }
  const meta = [];
  if (sec > 0) {
    meta.push(typeof fmtDur === 'function' ? (fmtDur(sec * 1000) || `${sec}s`) : `${sec}s`);
  }
  const tok = Number(tokens) || 0;
  if (tok > 0) {
    meta.push(typeof fmtTok === 'function' ? `~${fmtTok(tok)} tok` : `~${tok} tok`);
  }
  return meta.length ? ` · ${meta.join(' · ')}` : '';
}

function Spinner({ label = '思考中…', color = 'yellow', elapsedSec = 0, tokens = 0, stalled = false, detail = '' }) {
  const { Text } = inkRuntime.get();
  const [frame, setFrame] = React.useState(0);
  const h = React.createElement;

  React.useEffect(() => {
    if (REDUCED_MOTION) return undefined;
    const id = setInterval(() => setFrame((f) => (f + 1) % FRAMES.length), 80);
    return () => clearInterval(id);
  }, []);

  const glyph = REDUCED_MOTION ? '●' : FRAMES[frame];
  // Stall feedback: when no new output has arrived for a few seconds the glyph
  // turns red and an explicit "等待响应…" tag answers "is it stuck?". When the
  // gateway reported a detail ("等待模型响应中" / "预热中…"), append it so the tag
  // says WHAT it is stuck on — not just that it is stuck.
  const glyphColor = stalled ? 'red' : color;
  const stallDetail = String(detail || '').replace(/\s+/g, ' ').trim();
  const stallTag = stallDetail ? `  ⏳ 等待响应… · ${stallDetail}` : '  ⏳ 等待响应…';
  // Progress metadata answers "how long has it run / how much has streamed?".
  // Time + token NUMBER formatting routes through the ccFormat SSOT (see
  // buildSpinnerMeta) so the live spinner matches CC's `formatDuration`/`formatNumber`.
  const metaStr = buildSpinnerMeta(elapsedSec, tokens);

  return h(Text, null,
    h(Text, { color: glyphColor }, glyph), ' ',
    h(Text, { color: glyphColor }, label),
    metaStr ? h(Text, { dimColor: true }, metaStr) : null,
    stalled ? h(Text, { color: 'yellow' }, stallTag) : null
  );
}

module.exports = Spinner;
module.exports.buildSpinnerMeta = buildSpinnerMeta;
