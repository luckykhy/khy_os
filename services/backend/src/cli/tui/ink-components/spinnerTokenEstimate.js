'use strict';

// spinnerTokenEstimate.js — pure-ish leaf (single-slot incremental state, deterministic
// per (resetKey, append-sequence), never throws).
//
// 目的:消除 spinner「~N tok」实时提示对**整条累积流式回答**每帧的全串 CJK 正则扫描。
//
// 背景(承 [[project_stream_norm_cache_per_frame_oquad_memo]] 同族):App.js `_spinnerProgress`
// 在**每次 render**(流式 ~25fps)调 `_estimateTok(streaming.text)` → `tokenUsageService.estimateTokens`,
// 后者对整条 text 跑 `text.match(/[CJK]/g)`(全串正则 + 分配匹配数组)。回答增长到 N 字符时
// = 每帧 O(N) → **O(N²)/turn** + 每帧数组分配 = 长回答时 spinner/打字发卡。
//
// 关键取证:estimateTokens 的启发式**可精确增量分解**:
//   estimateTokens(s) = ceil( cjk(s)/1.5 + (len(s)-cjk(s))/4 )
// cjk()(逐字符 CJK 类,无跨边界模式)与 len() 对字符串**拼接严格可加**,末尾仅一次 Math.ceil。
// 故文本追加时只需扫描**新增后缀**的 CJK 数并累加 → 与全量 estimateTokens **逐字节等价**。
//
// 前缀稳定性:流式 `streaming.text` 在一个 turn 内只增长(append)或重置为 ''(见 useQueryBridge:
// `text: s.text + chunk.text` / 起手 `text:''`)。用 turn 级 resetKey(turnStartedAt)锚定单槽:
// key 不变且长度不减 → 视为 append,扫 delta;key 变(新 turn)或长度回落 → 全量重扫。调用方仅在
// CC-tokens 路径(text = 纯 streaming.text)启用增量;legacy 复合 text+thinking 非前缀稳定 → 全量。
//
// 门控 KHY_SPINNER_TOKEN_INCREMENTAL default-on;关/异常 → 直接调 fullFn(逐字节回退)。绝不抛。

const OFF_VALUES = ['0', 'false', 'off', 'no'];

function isEnabled(env = process.env) {
  const raw = env && env.KHY_SPINNER_TOKEN_INCREMENTAL;
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return !OFF_VALUES.includes(v);
}

// 与 estimateTokens **完全一致**的 CJK 字符类(逐字符匹配,拼接可加)。
const CJK_RE = /[一-鿿㐀-䶿]/g;
function _countCjk(s) { const m = s.match(CJK_RE); return m ? m.length : 0; }

// 与 estimateTokens **完全一致**的最终折算(单次 Math.ceil)。
function _estimate(cjk, len) { const nonCjk = len - cjk; return Math.ceil(cjk / 1.5 + nonCjk / 4); }

// 单槽:{ key, len, cjk }。key = 本 turn 的 resetKey(通常 turnStartedAt)。
let _last = null;

/**
 * 增量 CJK-aware token 估算(与 estimateTokens 逐字节等价)。
 * @param {string} text - 当前累积文本(CC-tokens 路径下 = streaming.text,turn 内 append-only)
 * @param {Function} fullFn - 全量估算真源(tokenUsageService.estimateTokens),门控关时逐字节回退
 * @param {*} resetKey - turn 级锚(turnStartedAt);变化 → 全量重扫,防跨 turn 串味
 * @param {object} [env]
 * @returns {number}
 */
function estimateIncremental(text, fullFn, resetKey, env = process.env) {
  try {
    if (typeof text !== 'string' || !text) { _last = { key: resetKey, len: 0, cjk: 0 }; return 0; }
    if (!isEnabled(env)) { _last = null; return typeof fullFn === 'function' ? fullFn(text) : _estimate(_countCjk(text), text.length); }
    const len = text.length;
    let cjk;
    if (_last && _last.key === resetKey && len >= _last.len) {
      // 同 turn + 长度不减 → append:仅扫新增后缀(_last.len===0 时整串即 delta)。
      const delta = _last.len === 0 ? text : text.slice(_last.len);
      cjk = _last.cjk + (delta ? _countCjk(delta) : 0);
    } else {
      // 新 turn(key 变)/ 长度回落 / 冷启 → 全量重扫。
      cjk = _countCjk(text);
    }
    _last = { key: resetKey, len, cjk };
    return _estimate(cjk, len);
  } catch {
    try { return typeof fullFn === 'function' ? fullFn(text) : 0; } catch { return 0; }
  }
}

// 测试辅助:复位单槽。
function _reset() { _last = null; }

module.exports = { isEnabled, estimateIncremental, _countCjk, _estimate, _reset, OFF_VALUES };
