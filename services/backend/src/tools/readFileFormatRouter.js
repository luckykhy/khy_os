'use strict';

/**
 * readFile 的「按格式路由到已存在提取器」编排器 —— async · DI 可测 · 绝不抛。
 *
 * ── 补的缺口：让读工具真正「读」各种格式,而不是拒绝/卡死 ──────────────────────
 * 上一轮 OPS-121 给 readFile 接了「读前二进制探测 → 快速拒绝」,止住了把 tar.gz 当文本
 * 注入模型导致的 1h+ 卡死。但用户反馈「各种格式 khy 都要能阅读」——拒绝不是终态。
 *
 * 仓库里 PDF/图片/压缩包/docx 的**提取器早已存在且有界**(自带超时/体积上限,故路由天然
 * 不会卡死),但读工具 readFile.js 一个都没接线:
 *   - PDF   → documentSnippetService.extractDocumentSnippetAsync (pdftotext→pypdf→strings)
 *   - 图片  → ocrSnippetService.extractImageOcrSnippetAsync (docHelper.py tesseract)
 *   - 压缩包 → archiveInspectService.inspectArchive (只列目录零解压 + 文本 peek)
 *             + archiveManifestPolicy.buildArchiveManifest (渲染清单+抽读文本条目)
 *   - docx  → docHelper.py docx_to_text (python-docx,写 .txt)
 *
 * 本编排器按 detectFile 的结果路由到对应提取器,成功则返回可读内容;任一提取器缺依赖/
 * 超时/失败/抛错,或格式无提取器(ELF/PE/xlsx/pptx/未知)→ 返回 { handled:false },由调用方
 * (readFile) 落 OPS-121 的信息性拒绝兜底。三层可逐级回退:
 *   本路由(默认开) → OPS-121 拒绝(KHY_READFILE_BINARY_GUARD) → 更旧的解码注入(两门都关)。
 *
 * ── 门控 / fail-soft ────────────────────────────────────────────────────────
 * 门 KHY_READFILE_FORMAT_ROUTE(默认开;env ∈ {0,false,off,no} 归一后关):关 → 立即
 * { handled:false },逐字节回退 OPS-121 拒绝。整体 try/catch,绝不抛。真正的提取器调用经
 * deps(DI)注入,默认 lazy-require 真实 service,故本叶单测无需真跑 python/pdftotext。
 */

const path = require('path');

const OFF_VALUES = ['0', 'false', 'off', 'no'];

function _isOff(raw) {
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return OFF_VALUES.includes(v);
}

/** 门控 KHY_READFILE_FORMAT_ROUTE（默认开）。 */
function formatRouteEnabled(env = process.env) {
  return !_isOff(env && env.KHY_READFILE_FORMAT_ROUTE);
}

/** 纯路径判断:是否像压缩包(.zip/.tar/.tar.gz/.tgz)——tar.gz magic 检测不到,靠扩展名。 */
function _looksArchivePath(filePath) {
  const p = String(filePath || '').toLowerCase();
  return /\.(zip|tar|tgz)$/.test(p) || /\.tar\.gz$/.test(p);
}

/** DI:未注入则 lazy-require 真实 service(每个都自带超时/体积上限,故有界不卡死)。 */
function _resolveDeps(deps) {
  const defaults = {
    extractImageOcr: (fp, mime) =>
      require('../services/ocrSnippetService').extractImageOcrSnippetAsync(fp, mime, {}),
    extractPdf: (fp, mime) =>
      require('../services/documentSnippetService').extractDocumentSnippetAsync(fp, mime, {}),
    inspectArchive: (fp, mime) =>
      require('../services/archiveInspectService').inspectArchive(fp, mime, {}),
    buildArchiveManifest: (res) =>
      require('../services/archiveManifestPolicy').buildArchiveManifest(res),
    extractDocx: (fp) => _extractDocxViaPython(fp),
  };
  if (!deps || typeof deps !== 'object') return defaults;
  return { ...defaults, ...deps };
}

/**
 * docx → 文本:spawn python docHelper.py docx_to_text <in> <tmp.txt>,读回 tmp,清理临时文件。
 * 镜像 ocrSnippetService 的 spawn 模式;有界(超时);绝不抛(异常 → {success:false})。
 */
function _extractDocxViaPython(filePath) {
  return new Promise((resolve) => {
    let tmpOut = '';
    try {
      const { spawn } = require('child_process');
      const fs = require('fs');
      const os = require('os');
      const DOC_HELPER = path.join(__dirname, '..', 'services', 'docHelper.py');
      const pyBin = process.platform === 'win32' ? 'python' : 'python3';
      tmpOut = path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), 'khy-docx-')),
        'out.txt',
      );
      const timeoutMs = Math.max(
        1000,
        parseInt(String(process.env.KHY_READFILE_DOCX_TIMEOUT_MS || '8000'), 10) || 8000,
      );
      let done = false;
      let stdout = '';
      const finish = (val) => {
        if (done) return;
        done = true;
        // 清理临时文件/目录(用后即删,不落盘残留)。
        try {
          const dir = path.dirname(tmpOut);
          if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut);
          if (dir && dir.includes('khy-docx-')) fs.rmdirSync(dir);
        } catch { /* ignore cleanup */ }
        resolve(val);
      };
      const child = spawn(pyBin, [DOC_HELPER, 'docx_to_text', filePath, tmpOut], {
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* */ } finish({ success: false, error: 'docx extract timeout' }); }, timeoutMs);
      child.stdout.on('data', (b) => { stdout += String(b); });
      child.on('error', () => { clearTimeout(timer); finish({ success: false, error: 'python spawn failed' }); });
      child.on('close', () => {
        clearTimeout(timer);
        try {
          let ok = false;
          try { ok = !!(JSON.parse(stdout.trim() || '{}').success); } catch { ok = false; }
          const text = ok && fs.existsSync(tmpOut) ? fs.readFileSync(tmpOut, 'utf8') : '';
          if (ok && text && text.trim()) finish({ success: true, engine: 'python-docx', text });
          else finish({ success: false, error: 'docx extract empty' });
        } catch { finish({ success: false, error: 'docx read failed' }); }
      });
    } catch { resolve({ success: false, error: 'docx extract unavailable' }); }
  });
}

/** 渲染成功的提取结果为读工具返回体;不成功/空 → null。 */
function _renderImageOcr(r, size) {
  if (!r || !r.success || !r.text || !String(r.text).trim()) return null;
  const engine = r.engine || 'tesseract';
  return {
    success: true,
    content: `【图片 OCR · ${engine}】\n${String(r.text)}`,
    format: 'image',
    extractedBy: engine,
    size,
    truncated: !!r.truncated,
  };
}

function _renderPdf(r, size) {
  if (!r || !r.success || !r.text || !String(r.text).trim()) return null;
  const engine = r.engine || 'pdf';
  const pages = Number.isFinite(r.pageCount) ? r.pageCount : null;
  const used = Number.isFinite(r.pagesUsed) ? r.pagesUsed : null;
  const pageTag = pages != null ? ` · 取${used != null ? used : '?'}/共${pages}页` : '';
  return {
    success: true,
    content: `【PDF 文本 · ${engine}${pageTag}】\n${String(r.text)}`,
    format: 'pdf',
    extractedBy: engine,
    size,
    truncated: !!r.truncated,
  };
}

function _renderDocx(r, size) {
  if (!r || !r.success || !r.text || !String(r.text).trim()) return null;
  const engine = r.engine || 'python-docx';
  return {
    success: true,
    content: `【DOCX 文本 · ${engine}】\n${String(r.text)}`,
    format: 'docx',
    extractedBy: engine,
    size,
    truncated: !!r.truncated,
  };
}

function _renderArchive(manifest, r, size) {
  if (!manifest || !String(manifest).trim()) return null;
  return {
    success: true,
    content: String(manifest),
    format: 'archive',
    extractedBy: r && r.kindToken ? r.kindToken : 'archive',
    size,
    truncated: !!(r && r.truncated),
  };
}

/**
 * 按格式路由读取。命中 → { handled:true, result:{success:true, content, ...} };
 * 未命中 / 门关 / 失败 / 抛错 → { handled:false }(调用方落 OPS-121 拒绝)。绝不抛。
 * @param {object} args {filePath, fmt(detectFile 结果), size, env, deps}
 * @returns {Promise<{handled:boolean, result?:object}>}
 */
async function routeFormatRead(args) {
  try {
    const { filePath, fmt, size } = args || {};
    const env = (args && args.env) || process.env;
    if (!formatRouteEnabled(env)) return { handled: false };
    if (!fmt || typeof fmt !== 'object' || !filePath) return { handled: false };

    const d = _resolveDeps(args && args.deps);
    const mime = fmt.mime || '';
    const fmtName = String(fmt.magicFormat || fmt.format || '').toLowerCase();
    const category = String(fmt.category || '').toLowerCase();

    // 图片 → OCR
    if (category === 'image') {
      const r = await d.extractImageOcr(filePath, mime);
      const rendered = _renderImageOcr(r, size);
      return rendered ? { handled: true, result: rendered } : { handled: false };
    }
    // PDF → 文本
    if (fmtName === 'pdf') {
      const r = await d.extractPdf(filePath, mime);
      const rendered = _renderPdf(r, size);
      return rendered ? { handled: true, result: rendered } : { handled: false };
    }
    // docx → 文本
    if (fmtName === 'docx') {
      const r = await d.extractDocx(filePath);
      const rendered = _renderDocx(r, size);
      return rendered ? { handled: true, result: rendered } : { handled: false };
    }
    // 压缩包(zip/tar/tar.gz)→ 清单 + 抽读文本条目
    if (category === 'archive' || _looksArchivePath(filePath)) {
      const r = await d.inspectArchive(filePath, mime);
      if (r && r.success) {
        const manifest = d.buildArchiveManifest({ ...r, env });
        const rendered = _renderArchive(manifest, r, size);
        if (rendered) return { handled: true, result: rendered };
      }
      return { handled: false };
    }

    return { handled: false };
  } catch {
    return { handled: false };
  }
}

module.exports = {
  routeFormatRead,
  formatRouteEnabled,
  // 导出内部件便于单测(纯函数,零副作用)。
  _looksArchivePath,
  _renderImageOcr,
  _renderPdf,
  _renderDocx,
  _renderArchive,
};
