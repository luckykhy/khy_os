'use strict';

/**
 * desktopControl/uiInspector.js — 眼·结构化感知：把屏幕变成可操控的元素清单（DESIGN-ARCH-056 感知层）。
 *
 * 「让它看得更清，并把可点击按钮作为可点击结构化数据返回，让 AI 知道怎么操控」——
 * 截图只是像素，本模块进一步抓宿主**无障碍树**（macOS AX / Linux AT-SPI / Windows UIA），
 * 经 backendRegistry 的 inspect 后端跑出 JSON，再交 elementModel 规范成统一、可寻址、可点击
 * 的元素清单（带 id / 角色 / 标签 / 包围盒 / 中心点 / clickable / editable）。
 *
 * 输出契约（成功）：
 *   { success:true, platform, backend, elements:[…规范元素…], marks:[…精简标记…],
 *     clickable:[…仅可点击…], count, clickableCount, source:'accessibility' }
 *
 * 降级铁律：
 *   - 没有任何无障碍后端时，若注入了「带框 OCR」(ocrWords) 则退化为 OCR 元素（标注 source:'ocr'，
 *     clickable=false——OCR 文本块不保证可点击，绝不臆造可点击性）；否则诚实返回 elements:[] +
 *     installHints，提示装无障碍后端，**绝不伪造**任何元素或坐标。
 *
 * 本模块只负责「看清」，不负责「能不能看」——是否放行由 safetyGate 前置裁决（inspect 归 capture 类）。
 */

const { execFile } = require('child_process');
const detector = require('./backendDetector');
const elementModel = require('./elementModel');

function _run(cmd, args, deps, timeoutMs = 15000) {
  const runner = deps.execFile || execFile;
  return new Promise((resolve) => {
    runner(cmd, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) resolve({ ok: false, error: (err && err.message) || String(err), stderr: String(stderr || ''), stdout: String(stdout || '') });
      else resolve({ ok: true, stdout: String(stdout || '') });
    });
  });
}

/**
 * 抓取并规范当前屏幕的可操控元素。
 * @param {object} [opts] { platform, clickableOnly:boolean }
 * @param {object} [deps] { detect, resolveBackend, execFile, ocrWords } 测试注入
 * @returns {Promise<object>} 见文件头输出契约
 */
async function inspect(opts = {}, deps = {}) {
  const detectFn = deps.detect || detector.detect;
  const caps = detectFn(deps.detectDeps || {});
  const platform = opts.platform || caps.platform;

  // 无无障碍后端 → 尝试 OCR 兜底，否则诚实降级。
  if (!caps.perception || !caps.perception.available) {
    const fallback = await _ocrFallback(opts, deps, platform);
    if (fallback) return fallback;
    return {
      success: false,
      source: 'none',
      platform,
      error: '本机没有可用的无障碍(结构化感知)后端——无法把屏幕解析成可点击元素清单。'
        + '可装无障碍后端，或改用截图 + 多模态视觉。',
      installHints: (caps.perception && caps.perception.installHints) || [],
      elements: [],
      marks: [],
      clickable: [],
      count: 0,
      clickableCount: 0,
    };
  }

  const resolve = deps.resolveBackend || detector.resolveBackend;
  const backend = resolve(platform, 'inspect', caps.perception.backend);
  if (!backend || !backend.ops || typeof backend.ops.tree !== 'function') {
    return { success: false, source: 'none', platform, error: `感知后端 ${caps.perception.backend} 无法解析。`, elements: [], marks: [], clickable: [], count: 0, clickableCount: 0 };
  }

  const built = backend.ops.tree(opts);
  const res = await _run(built.cmd, built.args, deps);
  if (!res.ok) {
    return { success: false, source: 'accessibility', platform, backend: backend.id, error: `无障碍树抓取失败：${res.error}`, stderr: res.stderr, elements: [], marks: [], clickable: [], count: 0, clickableCount: 0 };
  }

  const parse = backend.parse || ((s) => { try { return JSON.parse(s); } catch { return []; } });
  let raw;
  try { raw = parse(res.stdout); } catch { raw = []; }
  raw = (Array.isArray(raw) ? raw : []).map((r) => ({ ...r, source: backend.id }));

  const elements = elementModel.normalizeAll(raw);
  return _shape({ success: true, source: 'accessibility', platform, backend: backend.id, elements }, opts);
}

/** OCR 兜底：把「带包围盒的 OCR 词块」当作元素（仅文本定位，不保证可点击）。 */
async function _ocrFallback(opts, deps, platform) {
  const ocrWords = deps.ocrWords;
  if (typeof ocrWords !== 'function') return null;
  let words;
  try { words = await ocrWords(opts); } catch { return null; }
  if (!Array.isArray(words) || words.length === 0) return null;
  const raw = words
    .filter((w) => w && w.bbox && w.text)
    .map((w) => ({
      role: 'text',
      name: String(w.text),
      x: w.bbox.x, y: w.bbox.y, w: w.bbox.w, h: w.bbox.h,
      enabled: true,
      source: 'ocr',
    }));
  const elements = elementModel.normalizeAll(raw);
  return _shape({ success: true, source: 'ocr', platform, backend: 'ocr-words', elements, note: 'OCR 兜底：文本块仅供定位参考，未必可点击。' }, opts);
}

/** 统一塑形：附 marks/clickable/计数，并按 clickableOnly 过滤。 */
function _shape(base, opts) {
  let elements = base.elements || [];
  if (opts && opts.clickableOnly) elements = elementModel.filterClickable(elements);
  const clickable = elementModel.filterClickable(elements);
  return {
    ...base,
    elements,
    marks: elementModel.toMarks(elements),
    clickable,
    count: elements.length,
    clickableCount: clickable.length,
  };
}

module.exports = { inspect, _internals: { _ocrFallback, _shape } };
