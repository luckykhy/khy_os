'use strict';

/**
 * desktopControl/a11yTreeProvider.js — 可访问性树【统一抽象层】（DESIGN-ARCH-056 感知层）。
 *
 * 「优先用无障碍树结构化定位，信息不足才回退截图/OCR」——本模块把「怎么拿到一份
 * 规范化元素清单」这件事收敛成单一入口 getTree()，屏蔽平台差异：
 *   - Windows → UI Automation（backendRegistry 的 windows-uia 后端 + win-uia-tree.ps1）
 *   - macOS   → AX（预留分支，复用 macos-ax 后端）
 *   - Linux   → AT-SPI（预留分支，复用 linux-atspi 后端）
 * 平台选择只是选 backendRegistry 里对应的 inspect 后端，元素规范化统一交 elementModel。
 *
 * 降级铁律（截图/OCR 兜底）：
 *   - 无任何无障碍后端：若注入了「带框 OCR」(ocrWords) 则退化为 OCR 元素，否则诚实返回
 *     空树 + installHints（提示装无障碍后端），**绝不伪造**元素或坐标。
 *   - 无障碍树抓取失败 / 超时：try/catch 捕获后自动 fallback 到 screenCapture +
 *     ocrSnippetService 全文 OCR（文本行元素）。OCR 元素一律 clickable=false（文本块不保证
 *     可点击，绝不臆造可点击性）。
 *
 * 返回契约：Promise<NormalizedElement[]>——一个规范化元素数组，并在其**非枚举** meta
 * 属性上携带来源/后端/平台/降级信息（{ success, source, platform, backend, installHints,
 * error, note, selfWindowWarning, degradedFrom }），供 uiInspector 薄封装重建对外格式。
 */

const { execFile } = require('child_process');

const detector = require('./backendDetector');
const elementModel = require('./elementModel');
const screenCapture = require('./screenCapture');

const DEFAULT_TIMEOUT_MS = 15000;
const OCR_FULLTEXT_MAX_LINES = 50;

/**
 * 把普通数组标注（非枚举）元数据：既满足 `NormalizedElement[]` 契约（可直接迭代），
 * 又让上层拿到来源/后端等信息。meta 不参与 JSON 序列化 / for..of。
 */
function _result(elements, meta) {
  const arr = Array.isArray(elements) ? elements.slice() : [];
  Object.defineProperty(arr, 'meta', {
    value: meta || {},
    enumerable: false,
    writable: true,
    configurable: true,
  });
  return arr;
}

function _run(cmd, args, deps, timeoutMs) {
  const runner = deps.execFile || execFile;
  return new Promise((resolve) => {
    runner(
      cmd,
      args,
      { timeout: timeoutMs || DEFAULT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          resolve({
            ok: false,
            error: (err && err.message) || String(err),
            stderr: String(stderr || ''),
            stdout: String(stdout || ''),
          });
        } else {
          resolve({ ok: true, stdout: String(stdout || '') });
        }
      }
    );
  });
}

/** khy 终端自身 PID（当前进程 + 父进程），供 Windows UIA 脚本做窗口过滤。 */
function _selfPids() {
  const pids = [];
  try {
    if (Number.isFinite(process.pid)) {
      pids.push(process.pid);
    }
  } catch {
    /* ignore */
  }
  try {
    if (Number.isFinite(process.ppid)) {
      pids.push(process.ppid);
    }
  } catch {
    /* ignore */
  }
  return pids.join(',');
}

/**
 * 选无障碍 inspect 后端：Windows 桌面图标清单用专用后端（windows-desktop-icons），
 * 其余用平台首选（detect 选出的 perception.backend）。
 */
function _selectBackend(resolve, platform, caps, opts) {
  if (opts.desktop && platform === 'win32') {
    return (
      resolve(platform, 'inspect', 'windows-desktop-icons') ||
      resolve(platform, 'inspect', caps.perception.backend)
    );
  }
  return resolve(platform, 'inspect', caps.perception.backend);
}

/**
 * 抓取并规范当前屏幕的可操控元素清单。
 * @param {object} [opts] { platform, clickableOnly, desktop, region, selfPids, timeoutMs, ocrOptions }
 * @param {object} [deps] { detect, resolveBackend, execFile, ocrWords, screenCapture, ocrSnippet } 测试注入
 * @returns {Promise<Array>} NormalizedElement[]（带非枚举 .meta 元数据）
 */
async function getTree(opts = {}, deps = {}) {
  const detectFn = deps.detect || detector.detect;
  const caps = detectFn(deps.detectDeps || {});
  const platform = opts.platform || caps.platform;

  // ── 无无障碍后端 → 仅注入式 OCR 兜底，否则诚实降级（保留 installHints，绝不伪造）。──
  if (!caps.perception || !caps.perception.available) {
    const fb = await _ocrWordsFallback(opts, deps, platform);
    if (fb) {
      return fb;
    }
    return _result([], {
      success: false,
      source: 'none',
      platform,
      error:
        '本机没有可用的无障碍(结构化感知)后端——无法把屏幕解析成可点击元素清单。' +
        '可装无障碍后端，或改用截图 + 多模态视觉。',
      installHints: (caps.perception && caps.perception.installHints) || [],
    });
  }

  const resolve = deps.resolveBackend || detector.resolveBackend;
  const backend = _selectBackend(resolve, platform, caps, opts);
  if (!backend || !backend.ops || typeof backend.ops.tree !== 'function') {
    return _result([], {
      success: false,
      source: 'none',
      platform,
      error: `感知后端 ${caps.perception.backend} 无法解析。`,
    });
  }

  try {
    // Windows 普通树：注入 self-pid 让 UIA 脚本过滤 khy 终端自身窗口（桌面图标模式不需要）。
    const treeOpts =
      platform === 'win32' && !opts.desktop && opts.selfPids == null
        ? { ...opts, selfPids: _selfPids() }
        : opts;
    const built = backend.ops.tree(treeOpts);
    const res = await _run(built.cmd, built.args, deps, opts.timeoutMs);
    if (!res.ok) {
      const e = new Error(res.error || '无障碍树抓取失败');
      e.stderr = res.stderr;
      throw e;
    }

    const parse =
      backend.parse ||
      ((s) => {
        try {
          return JSON.parse(s);
        } catch {
          return [];
        }
      });
    let raw;
    try {
      raw = parse(res.stdout);
    } catch {
      raw = [];
    }
    raw = Array.isArray(raw) ? raw : [];

    // 窗口过滤命中：焦点是 khy 终端自身 → 空树 + 警示（不返回终端元素，也不做 OCR）。
    if (raw.length && raw[0] && raw[0].__khySelfWindow) {
      return _result([], {
        success: true,
        source: 'accessibility',
        platform,
        backend: backend.id,
        selfWindowWarning: `前台焦点为 khy 终端自身（窗口「${raw[0].name || ''}」），已跳过以避免抓取终端自身元素。`,
      });
    }

    raw = raw.map((r) => ({ ...r, source: backend.id }));
    const elements = elementModel.normalizeAll(raw);
    return _result(elements, {
      success: true,
      source: 'accessibility',
      platform,
      backend: backend.id,
      desktop: opts.desktop === true,
    });
  } catch (err) {
    // ── UIA 失败 / 超时 → 自动 fallback：注入词块优先，其次截图 + 全文 OCR。──
    const fb =
      (await _ocrWordsFallback(opts, deps, platform)) ||
      (await _screenshotOcrFallback(opts, deps, platform));
    if (fb) {
      if (fb.meta) {
        fb.meta.degradedFrom = 'accessibility';
        fb.meta.a11yError = (err && err.message) || String(err);
      }
      return fb;
    }
    return _result([], {
      success: false,
      source: 'accessibility',
      platform,
      backend: backend.id,
      error: `无障碍树抓取失败：${(err && err.message) || String(err)}`,
      ...(err && err.stderr ? { stderr: err.stderr } : {}),
    });
  }
}

/**
 * 注入式 OCR 兜底：把「带包围盒的 OCR 词块」(deps.ocrWords) 当作文本元素（仅文本定位，
 * clickable=false）。未注入或无词块时返回 null（交由上层决定诚实降级或截图 OCR）。
 */
async function _ocrWordsFallback(opts, deps, platform) {
  const ocrWords = deps.ocrWords;
  if (typeof ocrWords !== 'function') {
    return null;
  }
  let words;
  try {
    words = await ocrWords(opts);
  } catch {
    return null;
  }
  if (!Array.isArray(words) || words.length === 0) {
    return null;
  }
  const raw = words
    .filter((w) => w && w.bbox && w.text)
    .map((w) => ({
      role: 'text',
      name: String(w.text),
      x: w.bbox.x,
      y: w.bbox.y,
      w: w.bbox.w,
      h: w.bbox.h,
      enabled: true,
      source: 'ocr',
    }));
  const elements = elementModel.normalizeAll(raw);
  return _result(elements, {
    success: true,
    source: 'ocr',
    platform,
    backend: 'ocr-words',
    note: 'OCR 兜底：文本块仅供定位参考，未必可点击。',
  });
}

/**
 * 截图 + 全文 OCR 兜底：无词级包围盒 → 产出「文本行元素」（无坐标、clickable=false），
 * 仅作语义补充，绝不臆造坐标/可点击性。仅在无障碍树抓取失败/超时的 catch 分支触发。
 * 截图/OCR 任一步失败 → 返回 null（交由上层诚实报错）。
 */
async function _screenshotOcrFallback(opts, deps, platform) {
  const cap = deps.screenCapture || screenCapture;
  let shot;
  try {
    shot = await cap.capture({ region: opts.region, platform }, deps.captureDeps || {});
  } catch {
    return null;
  }
  if (!shot || shot.success === false || !shot.path) {
    return null;
  }

  let text = '';
  try {
    const ocrFn = deps.ocrSnippet || _defaultOcrSnippet;
    const r = await ocrFn(shot.path, opts.ocrOptions || {});
    text = r && r.text ? String(r.text) : '';
  } catch {
    return null;
  }
  if (!text.trim()) {
    return null;
  }

  const lines = text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, OCR_FULLTEXT_MAX_LINES);
  const raw = lines.map((line) => ({ role: 'text', name: line, enabled: true, source: 'ocr' }));
  const elements = elementModel.normalizeAll(raw);
  return _result(elements, {
    success: true,
    source: 'ocr',
    platform,
    backend: 'ocr-fulltext',
    screenshot: shot.path,
    note: 'OCR 全文兜底：无坐标、不可点击，仅供文本语义参考。',
  });
}

/** 默认全文 OCR：复用既有 ocrSnippetService（延迟 require，避免加载期循环依赖）。 */
async function _defaultOcrSnippet(imagePath, options = {}) {
  const svc = require('../../../ocrSnippetService');
  if (svc && typeof svc.extractImageOcrSnippetAsync === 'function') {
    const r = await svc.extractImageOcrSnippetAsync(imagePath, '', options);
    if (r && r.success) {
      return { text: r.text };
    }
  }
  return { text: '' };
}

module.exports = {
  getTree,
  _internals: { _selfPids, _selectBackend, _ocrWordsFallback, _screenshotOcrFallback, _result },
};
