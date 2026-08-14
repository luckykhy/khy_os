'use strict';

/**
 * glmVisionImageDownscale — 把「过大导致 GLM 视觉端 400 code 1210」的图片,在发送前
 * 无依赖地降采样到 token 预算内。
 *
 * 背景 / 实测根因(「识图 HTTP 400 code 1210」的第二种形态):
 *   0.1.180 修掉的是 `max_tokens > 1024`(单参数上限)。0.1.181 加诊断后暴露出另一种
 *   1210:GLM 视觉端有一条**合并预算**约束——
 *       `inputs tokens + max_new_tokens <= 16384`
 *   一张高分辨率截图光图片本身就编码成 18287 个 input token(实测),已超 16384,无论
 *   输出多小都必然 400。文本对话无图片故无此上限,识图恒挂。
 *
 * GLM-4V 系列把图片按分辨率切成视觉 token,token 数≈与像素面积成正比。故只要把图片
 * 等比缩小到目标面积以内,input token 就随之落回预算。本叶子:
 *   1) 无依赖读出宽高(imageMetadataProbe,解析 PNG/JPEG/GIF/BMP/WebP 文件头);
 *   2) 用线性模型估算当前 input token,若已在预算内 → 原样透传(绝不无谓重编码);
 *   3) 超预算 → 计算等比缩放系数,调平台自带图像工具做一次降采样
 *      (Windows: PowerShell System.Drawing;macOS: sips;Linux: ImageMagick/ffmpeg),
 *      产出新的 base64;任何一步失败 → fail-soft 原样透传(把决定权交回既有 OCR 兜底)。
 *
 * 设计红线:
 *   - **仅** GLM 视觉模型触发(判定复用 glmVisionApiPin 单一真源),其它模型零影响;
 *   - **仅** 估算超预算才重编码,预算内的图 0 成本透传;
 *   - 无第三方依赖(sharp/jimp/canvas 均未安装),只用平台自带 CLI;
 *   - 绝不抛:任何异常 → 返回原图,让下游 OCR 兜底与错误诊断继续工作。
 *
 * 门控 KHY_GLM_VISION_IMAGE_DOWNSCALE(parent = KHY_GLM_VISION_MODEL,默认开;
 * 0/false/off/no → 关)。关门 / 异常 → 原样透传(逐字节回退今日行为)。
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// GLM 视觉端合并预算上限(inputs + max_new_tokens)。留出输出与安全余量后,把图片
// 目标 token 压到 TARGET_IMAGE_TOKENS 以内。16384 - 1024(输出) - 保守余量 ≈ 12000。
const COMBINED_TOKEN_BUDGET = 16384;
const TARGET_IMAGE_TOKENS = 12000;

// GLM-4V 视觉 token ≈ 像素面积 / PIXELS_PER_TOKEN。该系数由实测标定:一次识图失败回报
// 「18287 inputs tokens」对应典型高清截图;因不知其确切分辨率,取**偏小**值(≈ 每 100 像素
// 1 token)以**高估** token —— 宁可多缩一点也不要缩不够又撞 1210(硬 400 全败 vs 分辨率略降
// 但仍可用)。仅用于「要不要缩、缩多少」的启发,非精确计费。
const PIXELS_PER_TOKEN = 100;

// 缩放后再乘一个安全系数,进一步远离预算边界(应对估算误差)。
const SAFETY_SHRINK = 0.92;

// 「统一归一化所有输入图」的最大边上限(px)。所有 GLM 视觉输入图都等比收敛到最大边 ≤ 此值:
// 既稳稳避开 token 上限,又给识别一个清晰稳定的分辨率(1512px 在 GLM-4V 上兼顾清晰度与预算)。
const DEFAULT_MAX_EDGE = 1512;
const MIN_MAX_EDGE = 512;
const MAX_MAX_EDGE = 4096;

// 平台图像 CLI 单次超时。
const DOWNSCALE_TIMEOUT_MS = 15000;

/**
 * 环境布尔门:缺省/空 → true;0/false/off/no → false。异常 → false。
 * @param {*} raw
 * @param {boolean} [dflt]
 */
// 收敛到 utils/onValueOr 单一真源(逐字节委托,调用点不变)
const _envOn = require('../../utils/onValueOr');

/**
 * 「统一归一化所有输入图」门 KHY_GLM_VISION_NORMALIZE_ALL(默认开)。
 * @param {object} [env]
 * @returns {boolean}
 */
function normalizeAllEnabled(env = process.env) {
  return _envOn(env && env.KHY_GLM_VISION_NORMALIZE_ALL, true);
}

/**
 * 最大边上限(px),可经 KHY_GLM_VISION_MAX_EDGE 覆盖,夹在 [512, 4096]。
 * @param {object} [env]
 * @returns {number}
 */
function getMaxEdge(env = process.env) {
  try {
    const parsed = parseInt(String((env && env.KHY_GLM_VISION_MAX_EDGE) ?? ''), 10);
    if (!Number.isFinite(parsed)) return DEFAULT_MAX_EDGE;
    return Math.max(MIN_MAX_EDGE, Math.min(MAX_MAX_EDGE, parsed));
  } catch {
    return DEFAULT_MAX_EDGE;
  }
}

/**
 * 可观测诊断:默认**开**(与 relay 错误体诊断同期,便于用户复现读日志定位)。
 * 关门 KHY_GLM_VISION_DOWNSCALE_DIAG=0/false/off/no。写 stderr,前缀便于 grep。
 * 绝不抛。
 * @param {string} msg
 */
function _diag(msg) {
  try {
    const raw = process.env.KHY_GLM_VISION_DOWNSCALE_DIAG;
    const v = raw == null || String(raw).trim() === '' ? '' : String(raw).trim().toLowerCase();
    if (v === '0' || v === 'false' || v === 'off' || v === 'no') return;
    process.stderr.write(`[glm_vision_downscale] ${msg}\n`);
  } catch { /* ignore */ }
}

/**
 * 门控 KHY_GLM_VISION_IMAGE_DOWNSCALE:默认开;0/false/off/no → 关。异常 → 关门(false)。
 * @param {object} [env]
 * @returns {boolean}
 */
function downscaleEnabled(env = process.env) {
  try {
    const raw = env && env.KHY_GLM_VISION_IMAGE_DOWNSCALE;
    if (raw == null || String(raw).trim() === '') return true; // 缺省 → 默认开
    const v = String(raw).trim().toLowerCase();
    return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
  } catch {
    return false;
  }
}

/**
 * 由宽高估算 GLM 视觉 input token(线性面积模型)。
 * @param {number} width
 * @param {number} height
 * @returns {number}
 */
function estimateVisionTokens(width, height) {
  const w = Number(width);
  const h = Number(height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return 0;
  return Math.ceil((w * h) / PIXELS_PER_TOKEN);
}

/**
 * 给定当前宽高,算出等比缩放系数(0,1]。综合两条约束,取**更强的收缩**(min):
 *   ① 预算约束:token∝面积∝scale²,超 TARGET_IMAGE_TOKENS 时 scale=sqrt(target/tokens)*SAFETY_SHRINK;
 *   ② 统一归一化(KHY_GLM_VISION_NORMALIZE_ALL 开):最大边收敛到 getMaxEdge 上限,
 *      scale_edge = maxEdge / max(w,h)(超上限才 <1)。
 * 两者都不触发 → 返回 1(不缩)。env 缺省时二者皆默认开。
 * @param {number} width
 * @param {number} height
 * @param {object} [env]
 * @returns {number}
 */
function computeScaleFactor(width, height, env = process.env) {
  const w = Number(width);
  const h = Number(height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return 1;

  // ① 预算约束。
  let budgetScale = 1;
  const tokens = estimateVisionTokens(w, h);
  if (tokens > TARGET_IMAGE_TOKENS) {
    budgetScale = Math.sqrt(TARGET_IMAGE_TOKENS / tokens) * SAFETY_SHRINK;
  }

  // ② 统一最大边归一化(默认开)。
  let edgeScale = 1;
  if (normalizeAllEnabled(env)) {
    const maxEdge = getMaxEdge(env);
    const longEdge = Math.max(w, h);
    if (longEdge > maxEdge) edgeScale = maxEdge / longEdge;
  }

  const scale = Math.min(budgetScale, edgeScale);
  // 夹在 (0,1];极端超大图也别缩到 0。
  return Math.max(0.05, Math.min(1, scale));
}

/**
 * 用平台自带 CLI 把 PNG buffer 等比缩放到 (targetW × targetH),返回新 PNG buffer。
 * 找不到可用工具 / 失败 → 返回 null(调用方 fail-soft 用原图)。
 * @param {Buffer} buf
 * @param {number} targetW
 * @param {number} targetH
 * @returns {Buffer|null}
 */
function _downscaleBufferViaPlatform(buf, targetW, targetH) {
  const tmpDir = path.join(os.tmpdir(), 'khy-vision-downscale');
  let inFile;
  let outFile;
  try {
    fs.mkdirSync(tmpDir, { recursive: true });
    const stamp = `${process.pid}_${buf.length}`;
    inFile = path.join(tmpDir, `in_${stamp}.png`);
    outFile = path.join(tmpDir, `out_${stamp}.png`);
    fs.writeFileSync(inFile, buf);

    const ran = _runPlatformResize(inFile, outFile, targetW, targetH);
    if (!ran) return null;
    if (!fs.existsSync(outFile)) return null;
    const out = fs.readFileSync(outFile);
    return out && out.length > 0 ? out : null;
  } catch {
    return null;
  } finally {
    try { if (inFile) fs.unlinkSync(inFile); } catch { /* ignore */ }
    try { if (outFile) fs.unlinkSync(outFile); } catch { /* ignore */ }
  }
}

/**
 * 按平台派发到具体的图像缩放 CLI。成功执行(命令未抛)→ true。
 * @param {string} inFile
 * @param {string} outFile
 * @param {number} w
 * @param {number} h
 * @returns {boolean}
 */
function _runPlatformResize(inFile, outFile, w, h) {
  const platform = process.platform;
  const opts = { timeout: DOWNSCALE_TIMEOUT_MS, stdio: 'pipe' };

  if (platform === 'win32') {
    // Windows 无第三方依赖:用 .NET System.Drawing 高质量双三次缩放,存回 PNG。
    // 注意:此处**不用** -sta(STA 单线程套间仅剪贴板互操作需要,纯图片缩放不需要,
    // 且 pwsh 7 会拒绝 -sta 报错 → 之前静默 fail-soft 原图)。改用兼容 5.1/7 的最小参数。
    const ps = [
      'Add-Type -AssemblyName System.Drawing;',
      `$src = [System.Drawing.Image]::FromFile('${_psQuote(inFile)}');`,
      `$bmp = New-Object System.Drawing.Bitmap(${w}, ${h});`,
      '$g = [System.Drawing.Graphics]::FromImage($bmp);',
      '$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic;',
      `$g.DrawImage($src, 0, 0, ${w}, ${h});`,
      `$bmp.Save('${_psQuote(outFile)}', [System.Drawing.Imaging.ImageFormat]::Png);`,
      '$g.Dispose(); $bmp.Dispose(); $src.Dispose();',
    ].join(' ');
    const shells = ['powershell', 'pwsh']; // 优先 5.1(必带 System.Drawing),再退 7
    let lastErr = '';
    for (const shell of shells) {
      try {
        execFileSync(shell, ['-NoProfile', '-NonInteractive', '-Command', ps], opts);
        if (fs.existsSync(outFile)) return true;
      } catch (e) {
        lastErr = (e && (e.stderr ? String(e.stderr) : e.message)) || String(e);
      }
    }
    _diag(`windows resize failed (all shells): ${lastErr.slice(0, 300)}`);
    // System.Drawing 失败(如 Nano Server / .NET 缺 GDI+)→ 退 Python+Pillow(khy 自带 Python)。
    if (_resizeViaPython(inFile, outFile, w, h)) return true;
    return false;
  }

  if (platform === 'darwin') {
    // macOS 自带 sips:按最大边等比缩放(-Z 保持宽高比,给较大边)。
    try {
      execFileSync('sips', ['-Z', String(Math.max(w, h)), inFile, '--out', outFile], opts);
      if (fs.existsSync(outFile)) return true;
    } catch (e) {
      _diag(`macOS sips resize failed: ${(e && e.message) || e}`);
    }
    if (_resizeViaPython(inFile, outFile, w, h)) return true;
    return false;
  }

  // Linux / 其它:优先 ImageMagick(magick/convert),再退 ffmpeg,最后退 Python+Pillow。
  const attempts = [
    ['magick', [inFile, '-resize', `${w}x${h}!`, outFile]],
    ['convert', [inFile, '-resize', `${w}x${h}!`, outFile]],
    ['ffmpeg', ['-y', '-i', inFile, '-vf', `scale=${w}:${h}`, outFile]],
  ];
  for (const [cmd, args] of attempts) {
    try {
      execFileSync(cmd, args, opts);
      if (fs.existsSync(outFile)) return true;
    } catch { /* try next tool */ }
  }
  if (_resizeViaPython(inFile, outFile, w, h)) return true;
  return false;
}

/**
 * 跨平台兜底:Python + Pillow 缩放(Pillow 比 ImageMagick 普及得多,khy 本身即
 * Python 启动器,Windows 上通常有 python)。逐个候选解释器尝试;Pillow 缺失/无解释器
 * → 返 false(继续原图 fail-soft)。绝不抛。
 */
function _resizeViaPython(inFile, outFile, w, h) {
  const code = [
    'import sys',
    'from PIL import Image',
    'im = Image.open(sys.argv[1]).convert("RGB")',
    'im = im.resize((int(sys.argv[3]), int(sys.argv[4])), Image.LANCZOS)',
    'im.save(sys.argv[2], "PNG")',
  ].join('; ');
  const pythons = process.platform === 'win32'
    ? ['python', 'py', 'python3']
    : ['python3', 'python'];
  const opts = { timeout: DOWNSCALE_TIMEOUT_MS, stdio: 'pipe' };
  let lastErr = '';
  for (const py of pythons) {
    try {
      execFileSync(py, ['-c', code, inFile, outFile, String(w), String(h)], opts);
      if (fs.existsSync(outFile)) return true;
    } catch (e) {
      lastErr = (e && (e.stderr ? String(e.stderr) : e.message)) || String(e);
    }
  }
  if (lastErr) _diag(`python+Pillow resize failed: ${lastErr.slice(0, 200)}`);
  return false;
}

/** PowerShell 单引号字面量转义(把 ' 变成 '')。 */
function _psQuote(s) {
  return String(s).replace(/'/g, "''");
}

/**
 * 若模型是 GLM 视觉模型且门控开:对每张图片估算 token,超预算者等比降采样。
 * 返回**新的 images 数组**(未改动的图片对象原样复用)。任何情况都不抛。
 *
 * images 项沿用 _imageCompat.normalizeImages 的形状:{ base64, mimeType, dataUrl }。
 * 缩放后同步刷新 base64 与 dataUrl。
 *
 * @param {string} model
 * @param {object[]} images
 * @param {object} [env]
 * @returns {object[]} 处理后的 images(不命中/失败 → 原数组引用)
 */
function downscaleGlmVisionImages(model, images, env = process.env) {
  try {
    if (!downscaleEnabled(env)) return images;
    if (!Array.isArray(images) || images.length === 0) return images;
    const { isGlmVisionModelName } = require('./glmVisionApiPin');
    if (!isGlmVisionModelName(model)) return images;

    let changed = false;
    const out = images.map((img) => {
      try {
        const base64 = img && img.base64;
        if (!base64 || typeof base64 !== 'string') return img;
        const res = _downscaleOneBase64(base64, env);
        if (!res) return img; // 预算内/探针失败/缩放失败 → 原图
        changed = true;
        return { ...img, base64: res.base64, mimeType: res.mimeType, dataUrl: `data:${res.mimeType};base64,${res.base64}` };
      } catch (e) {
        _diag(`per-image downscale threw: ${(e && e.message) || e}; passing through original`);
        return img; // 单图失败不影响其它
      }
    });

    return changed ? out : images;
  } catch {
    return images;
  }
}

/**
 * 核心单图降采样:输入 raw base64(无 data: 前缀),返回 { base64, mimeType } 或 null。
 * null 表示不需要/无法缩(预算内、探针失败、平台工具失败)——调用方应保留原图。
 * @param {string} base64
 * @param {object} [env]
 * @returns {{base64: string, mimeType: string}|null}
 */
function _downscaleOneBase64(base64, env = process.env) {
  const { probeImageMetadata } = require('../imageMetadataProbe');
  const buf = Buffer.from(base64, 'base64');
  if (buf.length < 64) return null;

  const meta = probeImageMetadata(buf);
  const w = meta && Number(meta.width);
  const h = meta && Number(meta.height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    _diag(`probe failed to read dimensions (bytes=${buf.length}, format=${meta && meta.format}); passing through original`);
    return null;
  }

  const est = estimateVisionTokens(w, h);
  const scale = computeScaleFactor(w, h, env);
  if (scale >= 1) {
    _diag(`image ${w}x${h} est=${est}tok within budget (target=${TARGET_IMAGE_TOKENS}, maxEdge=${getMaxEdge(env)}); no downscale`);
    return null; // 预算内且未超最大边,不缩
  }

  const targetW = Math.max(16, Math.round(w * scale));
  const targetH = Math.max(16, Math.round(h * scale));
  const shrunk = _downscaleBufferViaPlatform(buf, targetW, targetH);
  if (!shrunk) {
    _diag(`WANTED to downscale ${w}x${h} (est=${est}tok) -> ${targetW}x${targetH} but platform resize FAILED on ${process.platform}; shipping ORIGINAL (will still 400)`);
    return null; // fail-soft:平台工具缺失/失败 → 原图
  }

  const newBase64 = shrunk.toString('base64');
  _diag(`downscaled ${w}x${h} (est=${est}tok) -> ${targetW}x${targetH} (~${estimateVisionTokens(targetW, targetH)}tok), bytes ${buf.length}->${shrunk.length}`);
  return { base64: newBase64, mimeType: 'image/png' }; // 平台缩放统一存回 PNG
}

/**
 * 从形如 `data:<mime>;base64,<payload>` 或裸 base64 的字符串里抽出 raw base64。
 * 抽不出 → null。
 * @param {string} url
 * @returns {{ mimeType: string|null, base64: string }|null}
 */
function _extractBase64FromUrl(url) {
  if (typeof url !== 'string' || !url) return null;
  const m = /^data:([^;,]*);base64,([\s\S]+)$/i.exec(url);
  if (m) return { mimeType: m[1] || null, base64: m[2].replace(/\s+/g, '') };
  // 裸 base64(无前缀)——保守判定:仅 base64 字符集且足够长。
  if (/^[A-Za-z0-9+/=\r\n]+$/.test(url) && url.replace(/\s+/g, '').length > 128) {
    return { mimeType: null, base64: url.replace(/\s+/g, '') };
  }
  return null;
}

/**
 * **真正命中相关路径的接线**:走已构建好的 OpenAI/ChatML `messages`,就地把每个
 * `image_url`(data URL 内联 base64)块降采样。图片经 rawMessages/messages 内联到达
 * 时(_messageBuilder 以 rawMessages 为最高保真源,options.images 为空),此函数是唯一
 * 能看到图的地方。原地 mutate messages 数组内的 image_url.url(仅当确有收缩)。绝不抛。
 *
 * 支持的块形状:
 *   { type:'image_url', image_url:{ url:'data:...;base64,...' } }         (OpenAI chat)
 *   { type:'image_url', image_url:'data:...;base64,...' }                  (宽松变体)
 *   { type:'image', source:{ type:'base64', media_type, data } }          (Anthropic 内联)
 *
 * @param {string} model
 * @param {object[]} messages
 * @param {object} [env]
 * @returns {number} 实际收缩的图片数(0 = 未命中/未缩)
 */
function downscaleImageBlocksInMessages(model, messages, env = process.env) {
  try {
    if (!downscaleEnabled(env)) return 0;
    if (!Array.isArray(messages) || messages.length === 0) return 0;
    const { isGlmVisionModelName } = require('./glmVisionApiPin');
    if (!isGlmVisionModelName(model)) return 0;

    let shrunkCount = 0;
    for (const msg of messages) {
      const content = msg && msg.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        try {
          if (!block || typeof block !== 'object') continue;

          // ── OpenAI/ChatML image_url 块 + Responses API input_image 块 ──
          if ((block.type === 'image_url' || block.type === 'input_image') && block.image_url != null) {
            const iu = block.image_url;
            const url = typeof iu === 'string' ? iu : (iu && iu.url);
            const parsed = _extractBase64FromUrl(url);
            if (!parsed) continue;
            const res = _downscaleOneBase64(parsed.base64, env);
            if (!res) continue;
            const newUrl = `data:${res.mimeType};base64,${res.base64}`;
            if (typeof iu === 'string') block.image_url = newUrl;
            else block.image_url.url = newUrl;
            shrunkCount += 1;
            continue;
          }

          // ── Anthropic 内联 image 块 ──
          if (block.type === 'image' && block.source && block.source.type === 'base64'
              && typeof block.source.data === 'string') {
            const res = _downscaleOneBase64(block.source.data, env);
            if (!res) continue;
            block.source.media_type = res.mimeType;
            block.source.data = res.base64;
            shrunkCount += 1;
            continue;
          }
        } catch (e) {
          _diag(`per-block downscale threw: ${(e && e.message) || e}; leaving block unchanged`);
        }
      }
    }
    if (shrunkCount > 0) _diag(`downscaled ${shrunkCount} image block(s) in messages`);
    return shrunkCount;
  } catch {
    return 0;
  }
}

module.exports = {
  downscaleGlmVisionImages,
  downscaleImageBlocksInMessages,
  _downscaleOneBase64,
  _extractBase64FromUrl,
  downscaleEnabled,
  normalizeAllEnabled,
  getMaxEdge,
  estimateVisionTokens,
  computeScaleFactor,
  COMBINED_TOKEN_BUDGET,
  TARGET_IMAGE_TOKENS,
  DEFAULT_MAX_EDGE,
};
