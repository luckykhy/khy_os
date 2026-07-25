/**
 * AI chat attachment store.
 *
 * Persists user-uploaded attachments (images / video / audio / documents /
 * archives) under getDataDir('ai-uploads') and exposes structured descriptors
 * the chat pipeline can consume WITHOUT pushing megabytes of base64 through the
 * 1 MB JSON body cap on /api/ai/chat. The chat request carries only opaque ids;
 * the server resolves each id back to its file here and injects:
 *   - images   → dataUrl into gateway options.images (vision + OCR fallback)
 *   - text/doc → extracted text into the prompt
 *   - other    → a name/type/size reference line into the prompt
 *
 * Ids are 32-char hex; getUpload() rejects anything else so a crafted id can
 * never escape the upload directory (no path traversal).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getDataDir } = require('../utils/dataHome');

const ID_RE = /^[a-f0-9]{32}$/;

// Per-file ceiling. Generous by default (videos/projects are large) but bounded
// so a single upload can't exhaust the disk. Env-tunable, no magic constant.
function maxFileBytes() {
  const raw = parseInt(process.env.KHY_AI_UPLOAD_MAX_BYTES || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 100 * 1024 * 1024; // 100 MB
}

// How much text we lift out of a text-like attachment for the prompt. Bounded
// so a huge log/CSV can't blow the model's context. Env-tunable.
function maxExcerptBytes() {
  const raw = parseInt(process.env.KHY_AI_UPLOAD_EXCERPT_BYTES || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 32 * 1024; // 32 KB
}

// Images small enough to inline as base64 for true multimodal vision. Larger
// images still upload and download fine; they just fall back to OCR (which the
// gateway already does from base64) rather than being sent inline.
function maxInlineImageBytes() {
  const raw = parseInt(process.env.KHY_AI_UPLOAD_IMAGE_INLINE_BYTES || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 8 * 1024 * 1024; // 8 MB
}

function uploadDir() {
  return getDataDir('ai-uploads');
}

// Whether to extract document text / transcribe media at upload time. On by
// default; set KHY_UPLOAD_ENRICH=0 to skip all enrichment (fast uploads, the
// model then sees only a reference line for non-text attachments).
function enrichEnabled() {
  return process.env.KHY_UPLOAD_ENRICH !== '0';
}

// Upper bound on how long a single transcription may run inside the synchronous
// upload request. The underlying service defaults to 120s; we cap tighter here
// so a large video can't hang the upload response. Env-tunable, no magic value.
function transcribeTimeoutMs() {
  const raw = parseInt(process.env.KHY_UPLOAD_TRANSCRIBE_TIMEOUT_MS || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 60 * 1000;
}

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.jsonl', '.yaml', '.yml',
  '.xml', '.html', '.htm', '.log', '.ini', '.conf', '.env', '.toml',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.vue', '.py', '.go', '.rs',
  '.java', '.c', '.h', '.cpp', '.hpp', '.cc', '.cs', '.rb', '.php', '.sh',
  '.bash', '.zsh', '.sql', '.css', '.scss', '.less',
]);

const ARCHIVE_EXTENSIONS = new Set(['.zip', '.tar', '.gz', '.tgz', '.rar', '.7z', '.bz2', '.xz']);

/**
 * Classify an attachment into a coarse kind the chat pipeline branches on.
 * mimeType wins; extension is the fallback for the many cases browsers send
 * application/octet-stream.
 */
function classifyKind(mimeType, originalName) {
  const mime = String(mimeType || '').toLowerCase();
  const ext = path.extname(String(originalName || '')).toLowerCase();

  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';

  if (TEXT_EXTENSIONS.has(ext)) return ext.match(/\.(js|mjs|cjs|ts|tsx|jsx|vue|py|go|rs|java|c|h|cpp|hpp|cc|cs|rb|php|sh|bash|zsh|sql|css|scss|less)$/) ? 'code' : 'text';
  if (mime.startsWith('text/')) return 'text';
  if (mime === 'application/json' || mime === 'application/xml') return 'text';

  if (ARCHIVE_EXTENSIONS.has(ext) || mime === 'application/zip' || mime === 'application/x-tar' || mime === 'application/gzip') return 'archive';

  if (
    ext === '.pdf' || mime === 'application/pdf' ||
    /word|excel|powerpoint|officedocument|opendocument|msword|ms-excel|ms-powerpoint/.test(mime) ||
    ['.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods', '.odp'].includes(ext)
  ) {
    return 'document';
  }

  return 'other';
}

function isTextLike(kind) {
  return kind === 'text' || kind === 'code';
}

function safeExt(originalName) {
  const ext = path.extname(String(originalName || '')).toLowerCase();
  // Only keep a short, plain alphanumeric extension; everything else loses its ext.
  return /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : '';
}

function manifestPath(id) {
  return path.join(uploadDir(), `${id}.json`);
}

/**
 * Persist an already-on-disk temp file (multer diskStorage) as a managed
 * attachment: move it to <id><ext>, extract a text excerpt for text-like files,
 * write an <id>.json manifest, and return the public descriptor.
 */
function commitUpload({ tempPath, originalName, mimeType, size }) {
  const dir = uploadDir();
  fs.mkdirSync(dir, { recursive: true });

  const id = crypto.randomBytes(16).toString('hex');
  const ext = safeExt(originalName);
  const storedName = `${id}${ext}`;
  const storedPath = path.join(dir, storedName);

  fs.renameSync(tempPath, storedPath);

  const realSize = Number.isFinite(size) ? size : (() => {
    try { return fs.statSync(storedPath).size; } catch { return 0; }
  })();

  const kind = classifyKind(mimeType, originalName);

  let textExcerpt = null;
  let truncated = false;
  if (isTextLike(kind)) {
    try {
      const cap = maxExcerptBytes();
      const fd = fs.openSync(storedPath, 'r');
      try {
        const buf = Buffer.alloc(Math.min(cap, realSize || cap));
        const read = fs.readSync(fd, buf, 0, buf.length, 0);
        textExcerpt = buf.slice(0, read).toString('utf8');
        truncated = realSize > read;
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      textExcerpt = null;
    }
  }

  const manifest = {
    id,
    originalName: String(originalName || storedName),
    storedName,
    storedPath,
    mimeType: String(mimeType || 'application/octet-stream'),
    size: realSize,
    kind,
    textExcerpt,
    textTruncated: truncated,
    createdAt: new Date().toISOString(),
  };

  fs.writeFileSync(manifestPath(id), JSON.stringify(manifest), 'utf8');
  return manifest;
}

/**
 * Store extracted/transcribed text onto a manifest, bounded by the excerpt cap
 * so a long PDF or transcript can't blow the model's context. `engine` records
 * the provenance (e.g. "pdf:pdftotext", "transcript:whisper") for transparency.
 */
function _applyExtractedText(manifest, text, engine) {
  const cap = maxExcerptBytes();
  let t = String(text || '').trim();
  if (!t) return false;
  let truncated = false;
  if (Buffer.byteLength(t, 'utf8') > cap) {
    // Char slice is an over-approximation of the byte cap (multibyte chars),
    // which only makes the result smaller than the cap — safe.
    t = t.slice(0, cap);
    truncated = true;
  }
  manifest.textExcerpt = t;
  manifest.textTruncated = truncated;
  manifest.extracted = engine;
  return true;
}

/**
 * docx → text via the shared `runConvert` core (Python docHelper). Writes a
 * sibling .txt inside the upload dir, reads it back, then removes it. Returns
 * '' on any failure (missing Python, helper error) — caller falls back to the
 * reference line.
 */
async function _extractDocxText(manifest, deps = {}) {
  const outPath = path.join(uploadDir(), `${manifest.id}.extracted.txt`);
  try {
    const convert = deps.convert || require('../cli/handlers/convert');
    const r = await convert.runConvert({ input: manifest.storedPath, to: 'txt', output: outPath });
    if (r && r.success) {
      const produced = r.output || outPath;
      const txt = fs.readFileSync(produced, 'utf8');
      try { fs.unlinkSync(produced); } catch { /* best-effort cleanup */ }
      return txt;
    }
  } catch { /* fall through to reference line */ }
  try { fs.unlinkSync(outPath); } catch { /* may not exist */ }
  return '';
}

/**
 * Enrich a freshly committed manifest IN PLACE by extracting model-usable text:
 *   - PDF documents      → documentSnippetService.extractDocumentSnippetAsync
 *   - .docx documents    → runConvert docx→txt
 *   - audio / video      → mediaTranscriptionService.transcribeMediaFileAsync
 * Results are cached onto manifest.textExcerpt and re-persisted so resolveForChat
 * (and every later turn) reads them for free — extraction runs exactly once.
 *
 * Fail-soft by contract: any missing tool / error is recorded on
 * manifest.extractError and the manifest is returned unchanged otherwise. Never
 * throws. `deps` allows tests to inject the extraction services.
 *
 * xlsx / pptx / legacy .doc have no extraction path in the ecosystem and are
 * intentionally left to the reference-line fallback.
 */
async function enrichManifest(manifest, deps = {}) {
  if (!manifest || !enrichEnabled()) return manifest;
  // Text-like files already carry their excerpt from commitUpload.
  if (manifest.textExcerpt) return manifest;

  const kind = manifest.kind;
  const mime = String(manifest.mimeType || '').toLowerCase();
  const ext = path.extname(String(manifest.originalName || '')).toLowerCase();
  let changed = false;

  try {
    if (kind === 'document') {
      const isPdf = mime === 'application/pdf' || ext === '.pdf';
      if (isPdf) {
        const docSvc = deps.documentSnippetService || require('./documentSnippetService');
        const r = await docSvc.extractDocumentSnippetAsync(manifest.storedPath, manifest.mimeType, {});
        if (r && r.success && r.text) {
          changed = _applyExtractedText(manifest, r.text, `pdf:${r.engine || 'pdf'}`);
        } else if (r && r.error) {
          manifest.extractError = String(r.error);
        }
      } else if (ext === '.docx') {
        const txt = await _extractDocxText(manifest, deps);
        if (txt) changed = _applyExtractedText(manifest, txt, 'docx');
      }
      // xls/ppt/odt/legacy .doc: no extractor — reference line.
    } else if (kind === 'audio' || kind === 'video') {
      const mediaSvc = deps.mediaTranscriptionService || require('./mediaTranscriptionService');
      const r = await mediaSvc.transcribeMediaFileAsync(manifest.storedPath, manifest.mimeType, {
        timeoutMs: transcribeTimeoutMs(),
      });
      if (r && r.success && r.text) {
        changed = _applyExtractedText(manifest, r.text, `transcript:${r.engine || 'whisper'}`);
        if (changed) manifest.transcript = r.engine || 'whisper';
      } else if (r && r.error) {
        manifest.extractError = String(r.error);
      }
    }
  } catch (err) {
    manifest.extractError = String((err && err.message) || err);
  }

  // Persist whatever we learned (extracted text and/or extractError) so the
  // work is never repeated on later turns.
  if (changed || manifest.extractError) {
    try { fs.writeFileSync(manifestPath(manifest.id), JSON.stringify(manifest), 'utf8'); } catch { /* ignore */ }
  }
  return manifest;
}

/**
 * commitUpload + enrichManifest, for upload routes that want the document text
 * / transcript ready before they answer the client. Always resolves.
 */
async function commitAndEnrich(args, deps = {}) {
  const manifest = commitUpload(args);
  await enrichManifest(manifest, deps);
  return manifest;
}
function getUpload(id) {
  const clean = String(id || '').trim().toLowerCase();
  if (!ID_RE.test(clean)) return null;
  try {
    const raw = fs.readFileSync(manifestPath(clean), 'utf8');
    const manifest = JSON.parse(raw);
    // Defence in depth: the stored path must still live inside the upload dir.
    const dir = uploadDir();
    if (!path.resolve(manifest.storedPath || '').startsWith(path.resolve(dir))) return null;
    return manifest;
  } catch {
    return null;
  }
}

/** Public descriptor returned to the browser (never leaks the absolute path). */
function toDescriptor(manifest) {
  if (!manifest) return null;
  return {
    id: manifest.id,
    name: manifest.originalName,
    mimeType: manifest.mimeType,
    size: manifest.size,
    kind: manifest.kind,
    url: `/api/ai/upload/${manifest.id}`,
    textTruncated: !!manifest.textTruncated,
    // Enrichment signals so the UI can show "已提取正文 / 已转写" on the chip.
    extracted: manifest.extracted || null,
    transcript: manifest.transcript || null,
  };
}

function humanSize(bytes, env = process.env) {
  // 字节→人类可读单一真源:门控 KHY_CC_FORMAT 开 → 走 CC `formatFileSize` 同口径
  // (与 health/storage/multimodal/archive 等所有展示面统一);关 → 逐字节回退本地旧口径。
  try {
    const { ccFormatEnabled, ccFormatFileSize } = require('../cli/ccFormat');
    if (ccFormatEnabled(env)) {
      const out = ccFormatFileSize(Number(bytes) || 0);
      if (out) return out;
    }
  } catch { /* fall through to legacy */ }
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Resolve an array of attachment ids into structured material for gateway.generate():
 *   { images: [dataUrl...], promptBlocks: [text...], descriptors: [public...], missing: [id...] }
 * Images become inline base64 dataUrls (vision + OCR fallback). Text-like files
 * inject their excerpt. Everything else injects a reference line so the model is
 * aware of the attachment even when it can't read the bytes.
 */
function resolveForChat(ids) {
  const list = Array.isArray(ids) ? ids : [];
  const images = [];
  const promptBlocks = [];
  const descriptors = [];
  const missing = [];

  for (const entry of list) {
    const id = typeof entry === 'string' ? entry : (entry && entry.id);
    const manifest = getUpload(id);
    if (!manifest) { if (id) missing.push(String(id)); continue; }
    descriptors.push(toDescriptor(manifest));

    if (manifest.kind === 'image') {
      let inlined = false;
      try {
        if ((manifest.size || 0) <= maxInlineImageBytes()) {
          const b64 = fs.readFileSync(manifest.storedPath).toString('base64');
          images.push(`data:${manifest.mimeType || 'image/png'};base64,${b64}`);
          inlined = true;
        }
      } catch { inlined = false; }
      if (!inlined) {
        promptBlocks.push(`【图片附件：${manifest.originalName}（${humanSize(manifest.size)}）— 体积较大，未内联，可在对话中描述需求】`);
      }
      continue;
    }

    if (isTextLike(manifest.kind) && manifest.textExcerpt) {
      const tail = manifest.textTruncated ? '\n…（内容已截断）' : '';
      promptBlocks.push(`【附件：${manifest.originalName}（${manifest.kind}）】\n\`\`\`\n${manifest.textExcerpt}${tail}\n\`\`\``);
      continue;
    }

    // Documents / media enriched at upload time (PDF/Office body text, audio
    // transcript) carry their content in textExcerpt — inject it as real text
    // the model can read, instead of just a reference line.
    if (
      (manifest.kind === 'document' || manifest.kind === 'audio' || manifest.kind === 'video') &&
      manifest.textExcerpt
    ) {
      const head = manifest.kind === 'document' ? '文档正文' : '音轨转写';
      const tail = manifest.textTruncated ? '\n…（内容已截断）' : '';
      promptBlocks.push(`【${head}：${manifest.originalName}】\n\`\`\`\n${manifest.textExcerpt}${tail}\n\`\`\``);
      continue;
    }

    const label = {
      video: '视频', audio: '音频', document: '文档', archive: '压缩包/项目', text: '文本', code: '代码', other: '文件',
    }[manifest.kind] || '文件';
    promptBlocks.push(`【${label}附件：${manifest.originalName}，类型 ${manifest.mimeType}，大小 ${humanSize(manifest.size)}（二进制内容无法直接解析，请据文件名与上下文回应）】`);
  }

  return { images, promptBlocks, descriptors, missing };
}

module.exports = {
  uploadDir,
  classifyKind,
  commitUpload,
  commitAndEnrich,
  enrichManifest,
  getUpload,
  toDescriptor,
  resolveForChat,
  maxFileBytes,
  humanSize,
  _ID_RE: ID_RE,
};
