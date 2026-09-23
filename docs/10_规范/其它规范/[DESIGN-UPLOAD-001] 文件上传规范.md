# [DESIGN-UPLOAD-001] 文件上传规范

<!-- RULES-REGISTRY: UPLOAD-001 -->

> **用途**：定义 khy-os 文件上传标准，确保上传安全、可控、可审计。
> 当前 `aiUploadStore.js` 已有上传实现（大小限制、内容类型检查、16进制 ID），
> 本规范将其沉淀为标准并补充缺失部分。

---

## 1. 原则

1. **不信任客户端**：所有文件必须经过服务端验证
2. **最小权限**：上传文件不可执行、不可访问其他目录
3. **可追溯**：每个文件有唯一 ID 和完整元数据
4. **可清理**：文件有生命周期，自动清理过期文件
5. **类型安全**：严格的内容类型检查，防止伪装攻击

---

## 2. 文件 ID 规范

### 2.1 ID 格式

```
<32-hex-chars>.<extension>
```

| 属性 | 要求 |
|------|------|
| 长度 | 32 字符十六进制 |
| 生成 | `crypto.randomBytes(16).toString('hex')` |
| 可读性 | 不可读、不可猜测（无序号/时间戳） |
| 路径安全 | 只允许十六进制字符，拒绝路径遍历 |

```javascript
const ID_RE = /^[a-f0-9]{32}$/;
function validateId(id) {
  return ID_RE.test(String(id || ''));
}
```

### 2.2 扩展名处理

```javascript
function safeExt(originalName) {
  const ext = path.extname(String(originalName || '')).toLowerCase();
  // 只保留简短纯字母数字扩展名
  return /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : '';
}
```

**规则**：
- 最大 8 字符
- 只允许小写字母和数字
- 不合规则丢弃扩展名（文件以无扩展名存储）

---

## 3. 大小限制

### 3.1 按文件类型的限制

| 文件类型 | 扩展名 | 默认上限 | 环境变量 |
|----------|--------|----------|----------|
| 图片 | `.jpg`, `.png`, `.gif`, `.webp`, `.svg` | 50 MB | `KHY_AI_UPLOAD_IMAGE_MAX_BYTES` |
| 视频 | `.mp4`, `.webm`, `.mov`, `.avi` | 500 MB | `KHY_AI_UPLOAD_VIDEO_MAX_BYTES` |
| 音频 | `.mp3`, `.wav`, `.ogg`, `.m4a` | 100 MB | `KHY_AI_UPLOAD_AUDIO_MAX_BYTES` |
| 文档 | `.pdf`, `.docx`, `.xlsx`, `.pptx` | 50 MB | `KHY_AI_UPLOAD_DOC_MAX_BYTES` |
| 代码 | `.js`, `.py`, `.go`, `.rs`, 等 | 5 MB | `KHY_AI_UPLOAD_CODE_MAX_BYTES` |
| 文本 | `.txt`, `.md`, `.json`, `.csv` | 10 MB | `KHY_AI_UPLOAD_TEXT_MAX_BYTES` |
| 压缩包 | `.zip`, `.tar.gz`, `.rar` | 200 MB | `KHY_AI_UPLOAD_ARCHIVE_MAX_BYTES` |
| 通用 | 其他 | 100 MB | `KHY_AI_UPLOAD_MAX_BYTES` |

### 3.2 全局上限

```javascript
// 单文件上限（默认 100MB）
const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;
function maxFileBytes() {
  const raw = parseInt(process.env.KHY_AI_UPLOAD_MAX_BYTES || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_BYTES;
}
```

### 3.3 请求大小限制

| 参数 | 默认值 | 说明 |
|------|--------|------|
| 单文件上限 | 100 MB | 可通过环境变量调整 |
| 单请求文件数 | 10 | 多文件上传时限制 |
| 单请求总大小 | 500 MB | 多文件上传总上限 |

---

## 4. 内容类型检查

### 4.1 允许的类型

```javascript
const ALLOWED_MIME_TYPES = {
  image: ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml'],
  video: ['video/mp4', 'video/webm', 'video/quicktime', 'video/x-msvideo'],
  audio: ['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/mp4', 'audio/flac'],
  document: [
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ],
  text: ['text/plain', 'text/markdown', 'text/csv', 'application/json', 'application/xml'],
  code: ['text/plain', 'application/json', 'application/javascript', 'text/x-python'],
  archive: ['application/zip', 'application/gzip', 'application/x-tar', 'application/x-rar-compressed'],
};
```

### 4.2 检测策略

```javascript
function validateFileType(originalName, mimeType, buffer) {
  // 1. 检查 MIME 类型是否在允许列表
  if (!isAllowedMimeType(mimeType)) {
    throw new Error(`MIME type not allowed: ${mimeType}`);
  }

  // 2. 魔数检测（magic bytes）
  const detected = detectMimeType(buffer);
  if (detected && !isAllowedMimeType(detected)) {
    throw new Error(`File content type mismatch: declared=${mimeType}, detected=${detected}`);
  }

  // 3. 扩展名一致性检查
  const ext = path.extname(originalName).toLowerCase();
  if (!isConsistentWithExtension(detected || mimeType, ext)) {
    console.warn(`Extension mismatch: ${ext} with ${mimeType}`);
  }
}
```

**规则**：MIME 类型必须以魔数检测为准，不接受客户端声明的类型。

---

## 5. 内容检查

### 5.1 文本提取

| 文件类型 | 提取方式 | 上限 |
|----------|----------|------|
| `.txt`, `.md`, `.csv`, `.json` | 直接读取 | 32 KB（`KHY_AI_UPLOAD_EXCERPT_BYTES`） |
| `.js`, `.py`, `.go` 等代码文件 | 直接读取 | 32 KB |
| `.pdf` | `pdftotext` | 32 KB |
| `.docx` | Python docHelper | 32 KB |
| `.mp3`, `.wav` | Whisper 转录 | 可配置（`KHY_UPLOAD_TRANSCRIBE_TIMEOUT_MS`） |
| `.mp4`, `.webm` | Whisper 转录 | 可配置 |

### 5.2 病毒扫描

```javascript
// 上传后必须经过病毒扫描
async function scanFile(filePath) {
  // 方式 1：ClamAV
  const result = await clamav.scan(filePath);
  if (result.isInfected) {
    fs.unlinkSync(filePath);
    throw new Error(`File infected: ${result.viruses.join(', ')}`);
  }

  // 方式 2：第三方 API（备用）
  // await virusTotal.scan(filePath);
}
```

**规则**：
- 生产环境必须启用病毒扫描
- 检测到病毒必须立即删除文件
- 扫描超时视为通过（不阻塞上传流程）

---

## 6. 存储结构

### 6.1 目录布局

```
<data-dir>/ai-uploads/
├── <id32>.json          # 元数据清单
├── <id32><.ext>         # 实际文件
├── <id32>.extracted.txt # 提取的文本（可选）
└── .cleanup.json        # 清理记录
```

### 6.2 元数据清单

```javascript
{
  id: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4',
  originalName: 'report.pdf',
  storedName: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4.pdf',
  storedPath: '/data/ai-uploads/a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4.pdf',
  mimeType: 'application/pdf',
  size: 1048576,
  kind: 'document',           // image | video | audio | text | code | document | archive | other
  textExcerpt: '...',         // 提取的文本（如果有）
  textTruncated: false,       // 是否截断
  extracted: 'pdf:pdftotext', // 提取引擎
  virusScanResult: 'clean',   // clean | infected | skipped
  createdAt: '2026-09-10T12:00:00.000Z',
  expiresAt: '2026-09-17T12:00:00.000Z'  // 7 天后过期
}
```

---

## 7. 上传方式

### 7.1 标准上传（小文件 < 50MB）

```javascript
const multer = require('multer');
const { nanoid } = require('nanoid');

const storage = multer.diskStorage({
  destination: (req, _file, cb) => {
    cb(null, getDataDir('ai-uploads-temp'));
  },
  filename: (_req, file, cb) => {
    cb(null, `tmp-${nanoid()}`);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: parseInt(process.env.KHY_AI_UPLOAD_MAX_BYTES) || 100 * 1024 * 1024,
    files: 10,
  },
  fileFilter: (req, file, cb) => {
    if (!isAllowedMimeType(file.mimetype)) {
      return cb(new Error(`MIME type not allowed: ${file.mimetype}`), false);
    }
    cb(null, true);
  },
});

// POST /api/v1/upload
router.post('/', upload.array('files', 10), async (req, res) => {
  const manifests = [];
  for (const file of req.files) {
    const manifest = await commitUpload({
      tempPath: file.path,
      originalName: file.originalname,
      mimeType: file.mimetype,
      size: file.size,
    });
    manifests.push(manifest);
  }
  res.json({ success: true, data: manifests });
});
```

### 7.2 分片上传（大文件 > 50MB）

```javascript
// 初始化分片上传
POST /api/v1/upload/chunked/init
{
  "fileName": "large-video.mp4",
  "fileSize": 500000000,
  "mimeType": "video/mp4",
  "chunkSize": 10485760  // 10MB per chunk
}

// 响应
{
  "uploadId": "a1b2c3d4",
  "totalChunks": 50,
  "chunkSize": 10485760
}

// 上传分片
PUT /api/v1/upload/chunked/:uploadId/chunk/:chunkIndex
Content-Range: bytes 0-10485759/500000000

// 合并分片
POST /api/v1/upload/chunked/:uploadId/complete
```

**分片规则**：
- 分片大小：5-20 MB（客户端自选）
- 支持断点续传：丢失分片可单独重传
- 合并后验证 MD5：确保分片完整性
- 合并后删除临时分片

---

## 8. 生命周期

### 8.1 有效期

| 文件类型 | 默认有效期 | 说明 |
|----------|-----------|------|
| 聊天附件 | 7 天 | AI 对话附带的文件 |
| 用户上传 | 30 天 | 用户主动上传的文件 |
| 临时文件 | 1 天 | 处理中的临时文件 |

### 8.2 清理策略

```javascript
// 定期清理过期文件（每日）
async function cleanupExpiredUploads() {
  const cutoff = new Date(Date.now() - 7 * 24 * 3600 * 1000); // 7 天
  const manifests = await getExpiredManifests(cutoff);

  for (const manifest of manifests) {
    try {
      fs.unlinkSync(manifest.storedPath);
      fs.unlinkSync(manifestPath(manifest.id));
      console.log(`[upload] cleaned up: ${manifest.id}`);
    } catch (err) {
      console.error(`[upload] cleanup failed: ${manifest.id}`, err);
    }
  }
}
```

---

## 9. 安全要求

### 9.1 禁止事项

| 禁止 | 原因 |
|------|------|
| 上传 `.exe`, `.bat`, `.sh`, `.dll` 等可执行文件 | 防止恶意代码执行 |
| 使用原始文件名存储 | 防止路径遍历和覆盖 |
| 上传目录设置为可执行 | 防止上传后执行 |
| 信任客户端 MIME 类型 | 防止类型伪装 |
| 返回服务器绝对路径 | 防止信息泄露 |

### 9.2 路径安全

```javascript
// ✅ 正确：验证 ID 格式
function getUpload(id) {
  if (!validateId(id)) throw new Error('Invalid upload ID');
  return fs.readFileSync(path.join(uploadDir(), `${id}.json`));
}

// ❌ 错误：直接使用用户输入
function getUploadBad(id) {
  return fs.readFileSync(path.join(uploadDir(), id)); // 路径遍历风险
}
```

### 9.3 文件名消毒

```javascript
function sanitizeFileName(name) {
  return String(name || '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')  // 移除非法字符
    .replace(/\s+/g, '_')                      // 空格转下划线
    .slice(0, 200);                            // 截断过长名称
}
```

---

## 10. 响应格式

### 10.1 上传成功

```json
{
  "success": true,
  "data": [
    {
      "id": "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4",
      "originalName": "report.pdf",
      "mimeType": "application/pdf",
      "size": 1048576,
      "kind": "document",
      "url": "/api/v1/uploads/a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4",
      "expiresAt": "2026-09-17T12:00:00.000Z"
    }
  ]
}
```

### 10.2 错误响应

```json
{
  "success": false,
  "error": {
    "code": "UPLOAD_FILE_TOO_LARGE",
    "type": "USER_ERROR",
    "message": "文件大小超过限制（最大 100MB）",
    "details": {
      "fileName": "large.zip",
      "fileSize": 104857600,
      "maxSize": 104857600
    }
  }
}
```

---

## 11. 客户端要求

| 要求 | 说明 |
|------|------|
| 文件类型预检 | 上传前检查 `accept` 属性 |
| 文件大小预检 | 上传前检查 `maxSize` 限制 |
| 分片上传 | > 50MB 文件必须使用分片上传 |
| 断点续传 | 网络中断后可从断点恢复 |
| 进度显示 | 显示上传进度条 |
| 失败重试 | 自动重试失败的分片 |

---

## 12. 守卫

| 守卫 | 检查项 | 严重度 |
|------|--------|--------|
| `upload-safety-gate` | 上传文件 ID 必须为 32 位十六进制 | P0 |
| `upload-safety-gate` | 文件大小必须在上限内 | P0 |
| `upload-safety-gate` | MIME 类型必须经过魔数验证 | P0 |
| `upload-safety-gate` | 禁止可执行文件上传 | P0 |
| `upload-cleanup-gate` | 超过有效期的文件必须自动清理 | P2 |

---

## 13. 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0.0 | 2026-09-10 | 初始版本，定义文件上传规范 |

---

*本规范由 khy-os 平台团队维护*
