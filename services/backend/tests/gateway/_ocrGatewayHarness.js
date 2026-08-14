'use strict';

/**
 * _ocrGatewayHarness.js — OCR 网关测试族(services/backend/tests/gateway/ 下 ~20 个 .test.js)的
 * **共享测试脚手架**,统一维护此前逐文件复制粘贴的一套 harness(记录/拒绝适配器、gateway 接线、
 * 真图 OCR 提取、tesseract/python 探针、PIL 渲图、env 存还原、runner)。
 *
 * 设计要点:
 *   - 下划线前缀文件名 → 不被 `*.test.js` 选中,不会被当成测试文件跑。
 *   - **参数化工厂**:一处实现吸收各文件差异(最终 content 串、单/级联适配器形态、是否捕获图、
 *     describe 分支、prompt 文案、env key 列表、渲染文字)。行为与各文件原地 harness **逐字节等价**。
 *   - 本文件**确有 IO**(spawnSync / fs / imageService 落盘),故**不是**纯叶子,头注释不作零-IO 声明。
 *
 * 迁移契约(各测试文件读法从 module 变量改为句柄字段):
 *   - `let _finalPrompt/_finalImages` → `const rec = makeRecordingAdapter(...); rec.finalPrompt/rec.finalImages`
 *   - `_wireGateway(a)` → `wireSingle(rec)`;`_wireGateway(reject, rec)` → `wireCascade(reject, rec)`
 *   - `_makeRejectAdapter()` → `makeRejectAdapter()`;`_run(...)` → `makeRunner({...}).run(...)`
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const BE = path.resolve(__dirname, '..', '..'); // services/backend
const gw = require(BE + '/src/services/gateway/aiGateway');
const imageService = require(BE + '/src/services/imageService');
const ocrSnippet = require(BE + '/src/services/ocrSnippetService');

// 各测试统一使用的占位单图(内容无关;真实 OCR 由 DI 桩或真 tesseract 决定)。
const DEFAULT_IMG = [{ base64: 'ZmFrZQ==', mimeType: 'image/png' }];

// ── 记录型作答适配器 ────────────────────────────────────────────────────────────────
// 返回**句柄对象**:handle.adapter 是适配器,handle.finalPrompt/finalImages 为每次作答调用后
// 实时写入的观测值(取代 20 处 `let _finalPrompt`)。
//   opts.content        最终作答 content:字符串,或 `() => 字符串`(覆盖 footnote 逐测可变内容)
//   opts.captureImages  是否记录最终 options.images(单适配器组要,级联组不要)
//   opts.describe       是否包含 `_visionDescribePass` 视觉描述分支(单适配器组要)
//   opts.describeFails  该分支返回 404 拒图(而非成功描述)
//   opts.describeContent/name/provider/activeModel  其余可选覆盖
function makeRecordingAdapter(opts = {}) {
  const {
    content = '已作答',
    captureImages = false,
    describe = false,
    describeFails = false,
    describeContent = '图片描述文本',
    name = 'textonly',
    provider = 'textonly',
    activeModel = 'text-only-model',
  } = opts;

  const handle = {
    adapter: null,
    finalPrompt: null,
    finalImages: captureImages ? 'UNSET' : undefined,
  };

  handle.adapter = {
    detect: () => true,
    generate: async (prompt, o) => {
      // 探针调用:直接应答,不参与观测。
      if (/khy_probe_echo/.test(String(prompt || ''))) {
        return { success: true, content: 'yes', provider: 't', adapter: 't', model: 'm' };
      }
      // 视觉描述透传(仅单适配器组启用):按场景决定成功/失败。
      if (describe && o && o._visionDescribePass) {
        if (describeFails) {
          return { success: false, error: 'OpenAI: 404 model_not_found', errorType: 'model_not_found', provider: 't', adapter: 't' };
        }
        return { success: true, content: describeContent, provider: 't', adapter: 't', model: 'vision' };
      }
      // 最终作答调用:记录它到底收到了什么。
      handle.finalPrompt = prompt;
      if (captureImages) handle.finalImages = o && o.images;
      const c = typeof content === 'function' ? content() : content;
      return { success: true, content: c, provider, adapter: provider, model: o && o.model };
    },
    getStatus: () => ({ name, available: true, activeModel }),
    listModels: async () => [],
  };
  return handle;
}

// ── 拒图适配器(404 model_not_found;级联组置于视觉位) ─────────────────────────────────
function makeRejectAdapter(opts = {}) {
  const {
    name = 'visionpool',
    provider = 'visionpool',
    activeModel = 'gpt-4o',
    error = 'OpenAI: 404 model_not_found',
    errorType = 'model_not_found',
  } = opts;
  return {
    detect: () => true,
    generate: async (prompt, o) => {
      if (/khy_probe_echo/.test(String(prompt || ''))) {
        return { success: true, content: 'yes', provider: 'v', adapter: 'v', model: 'm' };
      }
      return { success: false, error, errorType, provider, adapter: provider, model: o && o.model };
    },
    getStatus: () => ({ name, available: true, activeModel }),
    listModels: async () => [],
  };
}

// ── gateway 接线(entries 化核心 + 便捷包装) ─────────────────────────────────────────
function _norm(x) {
  return x && x.adapter ? x.adapter : x; // 兼容句柄或裸适配器
}

function wireGateway(entries, activeAdapter) {
  gw._initialized = true;
  gw._adapters = entries.map((e, i) => ({
    key: e.key, adapter: _norm(e.adapter), priority: e.priority == null ? i : e.priority, enabled: true, available: true,
  }));
  gw._adapterQueue = (_k, fn) => fn();
  gw._generateWithAdapterIsolation = async (entry, prompt, opts) => entry.adapter.generate(prompt, opts);
  gw._getRecentFastFail = () => null;
  gw._enforceRateLimit = async () => {};
  gw._shouldSerializeAdapter = () => false;
  gw.refreshAdapters = async () => {};
  gw.getActiveAdapter = () => activeAdapter;
}

// 单适配器(形态 A / prep 变体 C):默认 textonly / text-only-model。
function wireSingle(recordHandleOrAdapter, { key = 'textonly', activeModel = 'text-only-model' } = {}) {
  wireGateway([{ key, adapter: recordHandleOrAdapter, priority: 0 }], { key, activeModel });
}

// reject + record 级联(形态 B):视觉位拒图,文本位承接。
function wireCascade(rejectAdapter, recordHandleOrAdapter, { activeModel = 'gpt-4o' } = {}) {
  wireGateway(
    [
      { key: 'visionpool', adapter: rejectAdapter, priority: 0 },
      { key: 'textonly', adapter: recordHandleOrAdapter, priority: 1 },
    ],
    { key: 'visionpool', activeModel },
  );
}

// ── 生产镜像:真图 base64 → 临时落盘 → 真 tesseract(镜像 aiGateway.extractImageOcrDetails base64 分支) ──
// 真 tesseract 在并行 `node --test` 下会与其他 OCR 用例争抢 CPU:默认 4s spawn 超时被
// 饿死进程触发 → 空 stdout,让 RealImage 断言(如 /INVOICE/)间歇假失败。两道吸收瞬态:
//   1) 显式放宽 timeoutMs(仅测试侧,生产默认 4000ms 不变)——给争抢中的 tesseract 足够墙钟;
//   2) 仅当上一次读出**空/失败**时才再读(稳态首读即成功 → 零额外开销、行为不变)。
// tesseract 是确定性纯函数,重试与放宽超时都绝不改变「真读得出才通过」的不变量,只消除争抢噪声。
const _OCR_TEST_TIMEOUT_MS = 30000;
function _ocrWithRetry(filePath, mimeType, maxChars, attempts = 3) {
  let last = null;
  for (let i = 0; i < attempts; i++) {
    last = ocrSnippet.extractImageOcrSnippet(filePath, mimeType, { lang: 'eng', maxChars, cache: false, timeoutMs: _OCR_TEST_TIMEOUT_MS });
    if (last && last.success && last.text) return last; // 读到即返(常见:一次成功)
  }
  return last;
}

function realExtractImageOcrDetails(images, { maxImages = 3, maxChars = 1200 } = {}) {
  const details = [];
  if (!Array.isArray(images)) return details;
  for (const img of images.slice(0, maxImages)) {
    let r = null;
    if (img && img._filePath) {
      r = _ocrWithRetry(img._filePath, img.mimeType || 'image/png', maxChars);
    } else if (img && (img.base64 || img.dataUrl)) {
      const tmp = imageService.saveBase64ToTemp(img.base64 || img.dataUrl, img.mimeType || 'image/png');
      if (tmp) {
        r = _ocrWithRetry(tmp, img.mimeType || 'image/png', maxChars);
        try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      }
    }
    if (r && r.success && r.text) {
      details.push({ text: r.text, confidence: Number(r.confidence) || 0, needsAiFallback: r.needsAiFallback === true, truncated: r.truncated === true, lang: r.lang || '', requestedLang: r.requestedLang || '', orientationCorrected: Number(r.orientationCorrected) || 0, upscaledFactor: Number(r.upscaledFactor) || 0 });
    }
  }
  return details;
}

// ── 环境探针 ──────────────────────────────────────────────────────────────────────
function haveTesseractLang(lang = 'eng') {
  try {
    const r = spawnSync('tesseract', ['--list-langs'], { encoding: 'utf8' });
    return r.status === 0 && new RegExp('\\b' + lang + '\\b').test(String(r.stdout) + String(r.stderr));
  } catch { return false; }
}

function tesseractPresent() {
  try { return spawnSync('tesseract', ['--version'], { encoding: 'utf8' }).status === 0; } catch { return false; }
}

function findPython() {
  for (const c of ['python3', 'python']) {
    try { if (spawnSync(c, ['--version'], { encoding: 'utf8' }).status === 0) return c; } catch { /* next */ }
  }
  return null;
}

function findPythonWithPil() {
  const py = findPython();
  if (!py) return null;
  const r = spawnSync(py, ['-c', 'import sys\ntry:\n    import PIL\nexcept Exception:\n    sys.exit(42)'], { encoding: 'utf8' });
  return r && r.status === 0 ? py : null;
}

// ── PIL PNG 渲染器(单渲染器覆盖各文字/尺寸/无字彩块变体) ────────────────────────────
// texts: [{ xy:[x,y], text, fill=[0,0,0] }];texts=[] + 彩色 bg → 故意无字块。
// 返回 { status, missingPil, path, exists };missingPil=true 表示本机缺 Pillow(sys.exit(42))。
function renderPng(py, { outPath, size = [520, 180], bg = [255, 255, 255], texts = [], fontSize = 72 } = {}) {
  const FONTS = ['/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'];
  const lines = [
    'import sys',
    'try:',
    '    from PIL import Image, ImageDraw, ImageFont',
    'except Exception:',
    '    sys.exit(42)',
    `img = Image.new('RGB', (${size[0]}, ${size[1]}), (${bg.join(', ')}))`,
    'd = ImageDraw.Draw(img)',
    'font = None',
    `for p in [${FONTS.map((f) => 'r"' + f + '"').join(', ')}]:`,
    '    try:',
    `        font = ImageFont.truetype(p, ${fontSize}); break`,
    '    except Exception:',
    '        font = None',
    'if font is None:',
    '    font = ImageFont.load_default()',
    ...texts.map((t) => `d.text((${t.xy[0]}, ${t.xy[1]}), ${JSON.stringify(t.text)}, fill=(${(t.fill || [0, 0, 0]).join(', ')}), font=font)`),
    `img.save(r'${outPath}')`,
  ];
  const r = spawnSync(py, ['-c', lines.join('\n')], { encoding: 'utf8' });
  return { status: r.status, missingPil: r.status === 42, path: outPath, exists: fs.existsSync(outPath) };
}

// ── runner:统一 gw.generate 调用(唯一 prompt 去重 + 可选 onChunk 状态捕获) ──────────────
function makeRunner({ prompt = '请描述图片中的关键信息', model = 'text-only-model', tag = 'ocr', images = DEFAULT_IMG } = {}) {
  let seq = 0;
  const uniq = () => `${tag}-${process.pid}-${(seq += 1)}`;
  return {
    uniq,
    run: (extra) => gw.generate(`${prompt} ${uniq()}`, Object.assign({ model, images }, extra)),
    runCapture: async (extra) => {
      const statuses = [];
      const res = await gw.generate(`${prompt} ${uniq()}`, Object.assign(
        { model, images, onChunk: (c) => { if (c && c.type === 'status' && c.text) statuses.push(c.text); } },
        extra,
      ));
      return { res, statuses };
    },
  };
}

// ── env 沙箱(统一两种 save/restore 惯用法;key 列表各测试自带) ───────────────────────
function envSandbox(keys) {
  const saved = {};
  return {
    save: () => { for (const k of keys) saved[k] = process.env[k]; },
    restore: () => { for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } },
    set: (map) => { for (const k of Object.keys(map)) { const v = map[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; } },
  };
}

// 图是否被剥空(非视觉模型永不收到裸图的不变量)。
function imagesStripped(finalImages) {
  return Array.isArray(finalImages) ? finalImages.length === 0 : !finalImages;
}

module.exports = {
  gw,
  DEFAULT_IMG,
  makeRecordingAdapter,
  makeRejectAdapter,
  wireGateway,
  wireSingle,
  wireCascade,
  realExtractImageOcrDetails,
  haveTesseractLang,
  tesseractPresent,
  findPython,
  findPythonWithPil,
  renderPng,
  makeRunner,
  envSandbox,
  imagesStripped,
  os,
  fs,
  path,
  spawnSync,
};
