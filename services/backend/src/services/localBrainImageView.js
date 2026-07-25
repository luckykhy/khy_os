'use strict';

/**
 * localBrainImageView.js — Tier-1 本地「图片识别 / 看图」处理器,从 localBrainFileLookup 的
 * 文件查看能力延伸而来,专治**无模型本地模式(/local)下的图片输入**(沿用 localBrainCalc /
 * localBrainTextOps / localBrainFileLookup 的抽取-再导出谱系)。
 *
 * 背景(用户目标 2026-07「为了验证 OCR,给本地模式也做一个图片识别——即使没有任何模型,
 * 也能正确地简单『看图』并给出简单描述」):无模型时 file_view 会把 PNG/JPEG 当 utf8 读成
 * 乱码,用户「看不到」图。本处理器补上确定性的两拍:
 *   1)**看形**:imageMetadataProbe 直接解析文件头 → 格式/尺寸/比例/朝向/色彩(无模型也成立);
 *   2)**验字**:本仓既有本地 Tesseract OCR(ocrSnippetService)best-effort 读出图中文字。
 * 即使 OCR 引擎缺失或图中无字,第 1 拍仍给出有用的简单描述,绝不空手而归、绝不臆测图片内容。
 *
 * 契约与 file_view 一致:match(isImageViewIntent) → detect → execute → format 三拍。
 * 门控 KHY_LOCAL_IMAGE_VIEW(与 imageMetadataProbe 共用)默认开;关 → isImageViewIntent 恒
 * false → 字节回退(图片路径落回 file_view / 兜底菜单)。**同步执行**(与 file_view 同款,
 * 避免 async 执行器在未 await 的 quickTaskService 调用点上撕裂)。
 *
 * 单一职责:只读——读图头 + 只读 OCR,不写盘、不删改、无网络、不调模型。
 */

const fs = require('fs');
const path = require('path');

const probe = require('./imageMetadataProbe');

let _fmt = null;
try { _fmt = require('./localFormat'); } catch { /* degrade to plain text */ }

// 头部探测只需读前若干字节(JPEG 的 SOF 可能在 EXIF 之后,给足 512KB 兜底);
// OCR 由 Tesseract 直接读原文件,不经此缓冲。
const _HEADER_READ_BYTES = 512 * 1024;
const _OCR_MAX_CHARS = 1200;

const _IMAGE_EXT_RE = /\.(?:png|jpe?g|gif|webp|bmp|tiff?)\b/i;
// 识图动词(中英):看/识别/识图/看图/描述/分析/查看/打开/显示 + recognize/describe/...
const _IMG_VERB_RE = /(?:识别|识图|看图|看看|查看|描述|分析|读取|打开|显示|认一下|这是什么|recogni[sz]e|describe|analy[sz]e|\bview\b|\bshow\b|\bread\b|\bocr\b)/i;

/** 展开 ~ 家目录前缀(与 localBrainFileLookup 一致)。 */
function _expandHome(p) {
  if (!p) return p;
  if (p.startsWith('~/') || p === '~') {
    return path.join(require('os').homedir(), p.slice(1));
  }
  return p;
}

/**
 * 意图判定:文本里含图片扩展名路径,且(带识图动词 或 整段基本就是一个图片路径)。
 * 严格锚定**图片扩展名**,故绝不抢占普通 file_view(非图片文件)或其他意图。
 * @param {string} text
 * @returns {boolean}
 */
function isImageViewIntent(text) {
  if (!probe.isEnabled(process.env)) return false;
  if (typeof text !== 'string' || text.length === 0 || text.length > 300) return false;
  if (!_IMAGE_EXT_RE.test(text)) return false;
  if (_IMG_VERB_RE.test(text)) return true;
  // 无动词时:仅当整段去引号后本身就是一个图片路径(如直接粘贴 "~/a.png" / "/tmp/my shot.png")。
  const bare = text.replace(/["'""'`]/g, '').trim();
  if (!/\.(?:png|jpe?g|gif|webp|bmp|tiff?)$/i.test(bare)) return false;
  // 单 token(无空白)即路径;或含路径分隔符时允许路径内空格(引号内带空格的路径)。
  return !/\s/.test(bare) || /[/\\~]/.test(bare);
}

/**
 * 从文本抽取图片路径(优先带引号的可含空格路径,否则取以图片扩展名结尾的非空白 token)。
 * @param {string} text
 * @param {object} [opts]
 * @returns {{type:string, category:string, label:string, filePath:string}|null}
 */
function detectImageView(text, opts) {
  const cwd = opts?.cwd || process.cwd();
  let raw = null;

  // 1) 引号内含图片扩展名的路径(允许空格)。
  const quoted = text.match(/["'""'`]([^"'""'`]*\.(?:png|jpe?g|gif|webp|bmp|tiff?))["'""'`]/i);
  if (quoted) {
    raw = quoted[1];
  } else {
    // 2) 非空白 token,以图片扩展名结尾。
    const bareMatch = text.match(/(\S+\.(?:png|jpe?g|gif|webp|bmp|tiff?))\b/i);
    if (!bareMatch) return null;
    raw = bareMatch[1];
  }

  raw = _expandHome(String(raw).trim());
  if (!raw) return null;
  const filePath = path.resolve(cwd, raw);
  return { type: 'image_view', category: '图片识别', label: path.basename(filePath), filePath };
}

const _MIME_BY_FORMAT = {
  png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', tiff: 'image/tiff',
};

/** 把可能多行/冗长的 OCR 失败原因收敛成一句(取首行、去多余空白、限长)。 */
function _tidyReason(msg) {
  const first = String(msg || '').split('\n')[0].trim().replace(/\s+/g, ' ');
  if (!first) return '未提取到文字';
  return first.length > 120 ? `${first.slice(0, 117)}...` : first;
}

/**
 * 读图头 → 探测元数据 → best-effort 本地 OCR。同步、只读、绝不抛。
 * @param {object} plan  detectImageView 的返回。
 * @returns {object} { type:'image_view', success, filePath, meta, sizeBytes, description, ocr }
 */
function executeImageView(plan) {
  const { filePath } = plan || {};
  if (!filePath || !fs.existsSync(filePath)) {
    return { type: 'image_view', success: false, error: `图片不存在: ${filePath || '(空路径)'}` };
  }

  let stat;
  try { stat = fs.statSync(filePath); } catch (e) {
    return { type: 'image_view', success: false, error: `无法读取: ${e.message}` };
  }
  if (stat.isDirectory()) {
    return { type: 'image_view', success: false, error: `这是目录,不是图片: ${filePath}` };
  }

  // 只读文件头用于探测尺寸(有界读取,大图不整读入内存)。
  let head;
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const cap = Math.min(_HEADER_READ_BYTES, stat.size);
      head = Buffer.alloc(cap);
      fs.readSync(fd, head, 0, cap, 0);
    } finally { fs.closeSync(fd); }
  } catch (e) {
    return { type: 'image_view', success: false, error: `读取图片头失败: ${e.message}` };
  }

  const meta = probe.probeImageMetadata(head);
  const description = probe.describeImageMetadata(meta, { sizeBytes: stat.size, env: process.env });

  // 非图片(魔数无法识别)→ 如实告知,不假装识别。
  if (!meta || meta.format === 'unknown') {
    return {
      type: 'image_view',
      success: false,
      error: `无法识别为图片(文件头不匹配 PNG/JPEG/GIF/WebP/BMP/TIFF): ${filePath}`,
      filePath,
    };
  }

  // best-effort 本地 OCR(验证 OCR 通道)。缺 Tesseract / 读不出字 → 静默降级,仍返回视觉描述。
  let ocr = null;
  try {
    const mime = _MIME_BY_FORMAT[meta.format] || '';
    const ocrSvc = require('./ocrSnippetService');
    const res = ocrSvc.extractImageOcrSnippet(filePath, mime, { maxChars: _OCR_MAX_CHARS });
    if (res && res.success && res.text && res.text.trim()) {
      ocr = { available: true, text: res.text.trim(), engine: res.engine || 'tesseract', confidence: res.confidence || 0 };
    } else {
      ocr = { available: false, reason: _tidyReason((res && res.error) ? res.error : '未提取到文字') };
    }
  } catch (e) {
    ocr = { available: false, reason: _tidyReason(e && e.message ? e.message : 'OCR 不可用') };
  }

  return {
    type: 'image_view',
    success: true,
    filePath,
    meta,
    sizeBytes: stat.size,
    description,
    ocr,
  };
}

/**
 * 渲染:视觉简单描述 +(若有)OCR 文字。诚实标注「本地识别,未使用模型」。
 * @param {object} result  executeImageView 的返回。
 * @returns {string}
 */
function formatImageView(result) {
  if (!result || !result.success) return `图片识别失败: ${result?.error || '未知错误'}`;

  const desc = result.description || '(无法生成描述)';
  const ocr = result.ocr || {};
  const ocrLines = [];
  if (ocr.available && ocr.text) {
    ocrLines.push('识别到的文字(本地 OCR):');
    ocrLines.push(ocr.text);
  } else {
    ocrLines.push(`文字识别:未提取到文字(${ocr.reason || '本地 OCR 不可用或图中无文字'})。`);
  }

  if (_fmt && _fmt.isEnabled()) {
    const sections = [{ heading: '简单描述', lines: [desc] }];
    if (ocr.available && ocr.text) {
      sections.push({ heading: '识别到的文字(本地 OCR)', lines: ['```', ...String(ocr.text).split('\n'), '```'] });
    } else {
      sections.push({ heading: '文字识别', lines: [`未提取到文字(${ocr.reason || '本地 OCR 不可用或图中无文字'})`] });
    }
    return _fmt.compose({
      title: `图片识别:${path.basename(result.filePath)}`,
      sections,
      meta: ['本地识别 · 未使用模型'],
    });
  }

  const header = `图片识别:${result.filePath}(本地识别,未使用模型)`;
  return [header, '─'.repeat(Math.min(60, header.length)), desc, '', ...ocrLines].join('\n');
}

module.exports = {
  isImageViewIntent,
  detectImageView,
  executeImageView,
  formatImageView,
};
