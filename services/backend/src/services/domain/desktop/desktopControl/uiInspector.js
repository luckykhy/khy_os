'use strict';

/**
 * desktopControl/uiInspector.js — 眼·结构化感知：把屏幕变成可操控的元素清单（DESIGN-ARCH-056 感知层）。
 *
 * 「让它看得更清，并把可点击按钮作为可点击结构化数据返回，让 AI 知道怎么操控」——
 * 截图只是像素，本模块进一步抓宿主**无障碍树**（macOS AX / Linux AT-SPI / Windows UIA），
 * 经 backendRegistry 的 inspect 后端跑出 JSON，再交 elementModel 规范成统一、可寻址、可点击
 * 的元素清单（带 id / 角色 / 标签 / 包围盒 / 中心点 / clickable / editable）。
 *
 * 【重构 · DESIGN-ARCH-056 感知层升级】平台选择 + 后端调用 + 规范化 + 截图/OCR 降级已统一
 * 收敛进 a11yTreeProvider.getTree()。本模块现为其**薄封装**：调 getTree() 拿规范元素数组
 * （及其非枚举 .meta 来源信息），再重建这里的对外契约。对外返回格式、resolveTarget 寻址、
 * 无后端时的 installHints 行为**完全不变**，现有调用方无感。
 *
 * 输出契约（成功）：
 *   { success:true, platform, backend, elements:[…规范元素…], marks:[…精简标记…],
 *     clickable:[…仅可点击…], count, clickableCount, source:'accessibility'|'ocr' }
 *
 * 降级铁律（由 a11yTreeProvider 兜底，语义保持不变）：
 *   - 没有任何无障碍后端时，若注入了「带框 OCR」(ocrWords) 则退化为 OCR 元素（标注 source:'ocr'，
 *     clickable=false——OCR 文本块不保证可点击，绝不臆造可点击性）；否则诚实返回 elements:[] +
 *     installHints，提示装无障碍后端，**绝不伪造**任何元素或坐标。
 *   - 无障碍树抓取失败/超时时，自动 fallback 到截图 + 全文 OCR（文本行元素，无坐标、clickable=false）。
 *
 * 本模块只负责「看清」，不负责「能不能看」——是否放行由 safetyGate 前置裁决（inspect 归 capture 类）。
 */

const a11yTreeProvider = require('./a11yTreeProvider');
const elementModel = require('./elementModel');

/**
 * 抓取并规范当前屏幕的可操控元素。
 * @param {object} [opts] { platform, clickableOnly:boolean, desktop:boolean }
 *   desktop:true 时在 Windows 上枚举桌面图标清单（SysListView32「FolderView」），
 *   用于回答「桌面上有什么」——不依赖截图/OCR/视觉。非 Windows 平台回退普通树。
 * @param {object} [deps] { detect, resolveBackend, execFile, ocrWords, screenCapture, ocrSnippet } 测试注入
 * @returns {Promise<object>} 见文件头输出契约
 */
async function inspect(opts = {}, deps = {}) {
  const tree = await a11yTreeProvider.getTree(opts, deps);
  const meta = (tree && tree.meta) || {};
  const platform = meta.platform || opts.platform;

  // 失败 / 诚实降级：无后端且无 OCR，或后端无法解析、抓取失败且兜底也失败。
  if (meta.success === false) {
    const out = {
      success: false,
      source: meta.source || 'none',
      platform,
      elements: [],
      marks: [],
      clickable: [],
      count: 0,
      clickableCount: 0,
      installHints: meta.installHints || [],
    };
    if (meta.backend) {
      out.backend = meta.backend;
    }
    if (meta.error) {
      out.error = meta.error;
    }
    if (meta.stderr) {
      out.stderr = meta.stderr;
    }
    return out;
  }

  // 成功（含 self-window 跳过 → 空树 + 警示，仍视为成功但无元素）。
  const base = {
    success: true,
    source: meta.source || 'accessibility',
    platform,
    backend: meta.backend,
    elements: tree.slice(),
    desktop: meta.desktop === true,
  };
  if (meta.note) {
    base.note = meta.note;
  }
  if (meta.selfWindowWarning) {
    base.selfWindowWarning = meta.selfWindowWarning;
  }
  if (meta.degradedFrom) {
    base.degradedFrom = meta.degradedFrom;
  }
  if (meta.a11yError) {
    base.a11yError = meta.a11yError;
  }
  if (meta.screenshot) {
    base.screenshot = meta.screenshot;
  }
  return _shape(base, opts);
}

/** 统一塑形：附 marks/clickable/计数，并按 clickableOnly 过滤。 */
function _shape(base, opts) {
  let elements = base.elements || [];
  if (opts && opts.clickableOnly) {
    elements = elementModel.filterClickable(elements);
  }
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

module.exports = { inspect, _internals: { _shape } };
