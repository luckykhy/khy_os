/**
 * FileReadTool — structured file reading, aligned with Claude Code's Read tool.
 *
 * Delegates to the existing readFile tool's logic for actual file I/O,
 * but exposes the Claude Code-compatible name, prompt, and input schema.
 */
const { BaseTool } = require('../_baseTool');
const fs = require('fs');
const path = require('path');

const LEGACY_MAX_LINES_TO_READ = 2000;
const LEGACY_MAX_FILE_SIZE = 500 * 1024; // 500 KB (historical hard cap)

// 图片扩展名判定集(Ch2「不要每轮重建可复用结构」）：Read 工具 call() 每次调用都重建这个
// 字面量 Set 仅为 `.has(ext)` 一次成员测试。提升到模块作用域,构造一次、只读消费,不 mutate、
// 不逃逸,逐字节等价。注意与 ocrSnippetService 的同名集刻意不同(此处含 .gif/.webp/.svg),
// 故不跨文件共享,只在本文件内提升。
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff', '.tif', '.svg']);

// 文件读取上限的单一真源(纯叶子)。fail-soft:缺失则回退 legacy 常量 + 超限硬报错。
let _fileReadLimit;
try { _fileReadLimit = require('../fileReadLimit'); } catch { _fileReadLimit = null; }
function _maxBytes() {
  return _fileReadLimit ? _fileReadLimit.resolveMaxBytes(process.env, LEGACY_MAX_FILE_SIZE) : LEGACY_MAX_FILE_SIZE;
}
function _maxLines() {
  return _fileReadLimit ? _fileReadLimit.resolveMaxLines(process.env, LEGACY_MAX_LINES_TO_READ) : LEGACY_MAX_LINES_TO_READ;
}
function _partialOnOversize() {
  return _fileReadLimit ? _fileReadLimit.partialOnOversizeEnabled(process.env) : false;
}

// 接缝2(闭环 goal「文件太多抓不住重点」):把「读到目录」的提示从「用 Bash ls」改为引导专用
// ListDir 工具(它自带 fileSalience 抓重点摘要,ls 裸 dump 则会淹没重点)。门控
// KHY_FILEREAD_LISTDIR_HINT 默认开;关 → 逐字节回退旧「ls command」文案。绝不抛。
function _listDirHintEnabled(env) {
  try {
    const e = env || process.env;
    let flagRegistry;
    try { flagRegistry = require('../../services/flagRegistry'); } catch { flagRegistry = null; }
    if (flagRegistry) return flagRegistry.isFlagEnabled('KHY_FILEREAD_LISTDIR_HINT', e);
    return !['0', 'false', 'off', 'no'].includes(String(e.KHY_FILEREAD_LISTDIR_HINT || '').trim().toLowerCase());
  } catch {
    return true;
  }
}

class FileReadTool extends BaseTool {
  static toolName = 'Read';
  static category = 'filesystem';
  static risk = 'low';
  static aliases = ['readFile', 'read_file', 'cat'];
  static searchHint = 'read file contents from filesystem';
  static alwaysLoad = true;
  static maxResultSizeChars = Infinity; // never truncate reads

  isReadOnly() { return true; }
  isConcurrencySafe() { return true; }

  prompt() {
    const maxLines = _maxLines();
    const dirLine = _listDirHintEnabled(process.env)
      ? '- This tool can only read files, not directories. To list a directory, use the ListDir tool — it surfaces the key files instead of dumping everything.'
      : '- This tool can only read files, not directories. To read a directory, use an ls command via the Bash tool.';
    return `Reads a file from the local filesystem. You can access any file directly by using this tool.
Assume this tool is able to read all files on the machine. If the User provides a path to a file assume that path is valid. It is okay to read a file that does not exist; an error will be returned.

Usage:
- The file_path parameter must be an absolute path, not a relative path
- By default, it reads up to ${maxLines} lines starting from the beginning of the file
- Prefer the smallest useful read. If you already know the relevant area, use offset/limit instead of rereading the whole file
- You can optionally specify a line offset and limit (especially handy for long files), but only read the whole file when the task truly needs full-file context
- For large files, prefer a targeted read with offset/limit or narrow the target with Grep first instead of blindly reading the entire file
- Once the affected slice is identified, avoid reading unrelated files or unrelated regions just to "be safe"
- When a task will modify multiple files, gather the relevant reads first before starting writes; independent file reads can happen in parallel
- Results are returned using cat -n format, with line numbers starting at 1
- This tool can read Jupyter notebooks (.ipynb files) and returns all cells with their outputs, combining code, text, and visualizations.
- This tool can read image files (PNG, JPG, GIF, WebP, BMP, TIFF, SVG). When reading an image, the contents are returned as base64 for visual analysis. If vision is unavailable, OCR text is returned instead.
${dirLine}
- You will regularly be asked to read screenshots. If the user provides a path to a screenshot, ALWAYS use this tool to view the file at the path. This tool will work with all image file paths.
- If you read a file that exists but has empty contents you will receive a system reminder warning in place of file contents.`;
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'The absolute path to the file to read',
        },
        offset: {
          type: 'number',
          description: 'The line number to start reading from (1-based). Only provide if the file is too large to read at once.',
        },
        limit: {
          type: 'number',
          description: 'The number of lines to read. Only provide if the file is too large to read at once.',
        },
      },
      required: ['file_path'],
    };
  }

  async validateInput(params) {
    try {
      const { validateNotDevicePath, validateNotUNCPath, composeValidations } = require('../inputValidators');
      return composeValidations(
        validateNotDevicePath(params.file_path),
        validateNotUNCPath(params.file_path),
      );
    } catch {
      return { valid: true };
    }
  }

  getActivityDescription(input) {
    return `读取文件：${input.file_path || 'file'}`;
  }

  getToolUseSummary(input) {
    if (!input.file_path) return null;
    return `读取 ${path.basename(input.file_path)}`;
  }

  async execute(params, _context) {
    try {
      const cwd = process.env.KHYQUANT_CWD || process.cwd();
      let rawPath = params.file_path;

      // Expand environment variables and tilde
      if (process.platform === 'win32') {
        rawPath = rawPath.replace(/%([^%]+)%/g, (_, key) => process.env[key] || `%${key}%`);
      } else {
        rawPath = rawPath.replace(/\$\{?(\w+)\}?/g, (_, key) => process.env[key] || '');
      }
      if (rawPath.startsWith('~')) {
        rawPath = path.join(require('os').homedir(), rawPath.slice(1));
      }

      const filePath = path.resolve(cwd, rawPath);

      // Windows 保留设备名(CON/PRN/AUX/NUL/COM1-9/LPT1-9、`\\.\…`、`\\?\GLOBALROOT\…`)读前防护:
      // 第五条卡死向量,按「路径名」拦(纯路径判定、零 IO)。这是**面向模型的主读工具**(`Read`),
      // 其 validateInput 只有 validateNotDevicePath(POSIX /dev/* 精确集)+ validateNotUNCPath(`\\` 前缀),
      // 都拦不住裸保留名(`CON`/`C:\tmp\COM1.log`/`sub/LPT1.bin`)。Windows 会把任意目录任意扩展名下的
      // 保留名解析为设备,`fs.statSync`/读取会永久等待设备输入而卡死,故必须排在 `fs.existsSync`/
      // `fs.statSync` **触碰设备之前**。门控 KHY_READFILE_WIN_DEVICE_GUARD(默认开、与 readFile.js 同门);
      // 关 → 逐字节回退历史行为(照旧走 statSync)。非 win32 平台 classify 恒返 null → 零影响。
      try {
        const { winDeviceGuardEnabled, classifyWindowsDevice, buildWinDeviceRefusal } = require('../winDeviceReadGuard');
        if (winDeviceGuardEnabled(process.env)) {
          const _wkind = classifyWindowsDevice(filePath);
          if (_wkind) {
            return { success: false, error: buildWinDeviceRefusal({ kind: _wkind, path: filePath }), winDevice: _wkind };
          }
        }
      } catch { /* 判定失败 → 回退历史读取行为 */ }

      if (!fs.existsSync(filePath)) {
        return { success: false, error: `File not found: ${filePath}` };
      }

      const stat = fs.statSync(filePath);

      if (stat.isDirectory()) {
        const dirHint = _listDirHintEnabled(process.env)
          ? `Cannot read a directory. Use the ListDir tool to list its contents (it surfaces the key files instead of dumping everything): ${filePath}`
          : `Cannot read a directory. Use ls command instead: ${filePath}`;
        return { success: false, error: dirHint };
      }

      // 特殊文件(FIFO/套接字/字符或块设备)读前防护(与 readFile.js 同门 KHY_READFILE_SPECIAL_GUARD)。
      // 必须在 image/编码/readTextFileSmart 之前拦下:读这些非常规文件的第一个字节会**永久阻塞**
      // (等写端/无尽输入)。它们 size=0 且非二进制格式,会溜过后续所有守卫。`fs.statSync` 对
      // FIFO/设备只读元数据、瞬时返回不阻塞,故此处用已算好的 stat 类型谓词安全判定。fail-soft。
      try {
        const { specialReadGuardEnabled, classifySpecialFile, buildSpecialFileRefusal } = require('../specialFileReadGuard');
        if (specialReadGuardEnabled(process.env)) {
          const _kind = classifySpecialFile(stat);
          if (_kind) {
            return { success: false, error: buildSpecialFileRefusal({ kind: _kind, path: filePath, size: stat.size }), specialFile: _kind, size: stat.size };
          }
        }
      } catch { /* 判定失败 → 回退历史读取行为 */ }

      // 伪文件系统(/proc·/sys)阻塞文件读前防护(与 readFile.js 同门 KHY_READFILE_PSEUDO_GUARD)。
      // Linux `/proc`·`/sys` 下是常规文件(isFile=true)、size=0、内容读时现生成,其中一部分
      // (/proc/kmsg 等)读第一个字节就**永久阻塞**,会溜过特殊文件守卫(类型谓词全 false)与
      // 超限检查(0>maxBytes 恒 false)。把阻塞读搬进可被 timeout 杀掉的子进程 `head -c N`:
      // 有限伪文件秒回、阻塞伪文件到点被杀 → 有界返回绝不挂起。handled:false / 抛错 → 回退历史。
      try {
        const { shouldBoundedRead, readPseudoFileBounded } = require('../pseudoFileReadGuard');
        const _pkind = shouldBoundedRead({ absPath: filePath, stat, env: process.env });
        if (_pkind) {
          const routed = readPseudoFileBounded({ filePath, kind: _pkind, env: process.env });
          if (routed && routed.handled) return routed.result;
        }
      } catch { /* 判定/有界读失败 → 回退历史读取行为 */ }

      // Image detection — return base64 for vision or OCR fallback
      const ext = path.extname(filePath).toLowerCase();
      const isImage = IMAGE_EXTS.has(ext);

      // 二进制/压缩文件读前处理(仅非图片;图片走下方 base64/OCR 专路,不得被此拦截)。
      // 与 readFile.js 同门:格式路由 KHY_READFILE_FORMAT_ROUTE(默认开)→ 命中二进制先按格式
      // 路由到已存在提取器(PDF/压缩包/docx),真正读出可读内容(提取器全有界不卡死);
      // 无提取器/失败 → OPS-121 信息性拒绝 KHY_READFILE_BINARY_GUARD(默认开),绝不把二进制字节
      // 解码成乱码注入模型上下文(会拖垮模型请求)。两门都关 → 逐字节回退历史文本读取。fail-soft。
      if (!isImage) {
        try {
          const { binaryReadGuardEnabled, isBinaryForRead, buildBinaryReadRefusal } = require('../readBinaryGuard');
          if (binaryReadGuardEnabled(process.env)) {
            const { detectFile } = require('../../services/formatInspect/fileFormatDetector');
            const fmt = detectFile(filePath);
            if (isBinaryForRead(fmt)) {
              try {
                const { routeFormatRead } = require('../readFileFormatRouter');
                const routed = await routeFormatRead({ filePath, fmt, size: stat.size, env: process.env });
                if (routed && routed.handled) return routed.result;
              } catch { /* 路由失败 → 落 OPS-121 拒绝兜底 */ }
              return {
                success: false,
                error: buildBinaryReadRefusal({ format: fmt.format, magicFormat: fmt.magicFormat, category: fmt.category, size: stat.size }),
                binary: true,
                format: fmt.magicFormat || fmt.format || null,
                size: stat.size,
              };
            }
          }
        } catch { /* 探测失败 → 回退历史文本读取行为 */ }
      }

      const maxSize = isImage ? 5 * 1024 * 1024 : _maxBytes();
      let oversize = false;
      if (stat.size > maxSize) {
        // 图片仍硬报错(需先缩放);文本超限:门控开 → 读有界窗口 + 诚实分页提示,
        // 门控关 → 逐字节回退历史硬报错(导向 offset/limit 或 shell)。
        if (isImage || !_partialOnOversize()) {
          return {
            success: false,
            error: `File too large: ${stat.size} bytes (max ${maxSize}). ${isImage ? 'Resize the image first.' : 'Use offset/limit parameters or a shell command to read portions.'}`,
          };
        }
        oversize = true;
      }

      if (isImage) {
        try {
          const imageService = require('../../services/imageService');
          const img = imageService.readImageFromFile(filePath);
          return {
            success: true,
            type: 'image',
            mimeType: img.mimeType,
            base64: img.base64,
            size: stat.size,
            format: img.format,
            file: filePath,
          };
        } catch (imgErr) {
          // OCR fallback for unsupported formats or read errors
          try {
            const ocr = require('../../services/ocrSnippetService');
            const text = ocr.extractImageOcrSnippet(filePath);
            if (text) {
              return {
                success: true,
                content: `[Image OCR — ${path.basename(filePath)}]\n${text}`,
                size: stat.size,
                lines: text.split('\n').length,
                _ocrFallback: true,
              };
            }
          } catch { /* OCR not available */ }
          return { success: false, error: `Cannot read image: ${imgErr.message}` };
        }
      }

      if (stat.size === 0) {
        return {
          success: true,
          content: '[File exists but is empty]',
          size: 0,
          lines: 0,
        };
      }

      // 编码自适应：合法 UTF-8 恒判 utf-8（行为不变），非 UTF-8 文本探测后经
      // iconv 解码，避免 GBK/Shift-JIS/Big5 等遗留编码源码整篇乱码。超限时只读前 maxSize 字节。
      const { readTextFileSmart } = require('../../utils/fileEncoding');
      const { text: raw } = readTextFileSmart(filePath, { maxBytes: oversize ? maxSize : undefined });
      const allLines = raw.split('\n');

      // Apply offset/limit
      const offset = params.offset || 1;
      const limit = params.limit || _maxLines();
      const start = Math.max(0, offset - 1);
      const end = Math.min(allLines.length, start + limit);
      const sliced = allLines.slice(start, end);

      // Format with line numbers (cat -n style)
      let numbered = sliced.map((line, i) => `${start + i + 1}\t${line}`).join('\n');
      if (oversize && _fileReadLimit) {
        numbered += _fileReadLimit.buildOversizeNotice({ totalBytes: stat.size, maxBytes: maxSize });
      }

      // 记录已读路径 + mtime，供 FileEditTool/FileWriteTool 写前检查
      try { require('../_readTracker').markRead(filePath, stat.mtimeMs); } catch { /* best-effort */ }

      return {
        success: true,
        content: numbered,
        size: stat.size,
        lines: sliced.length,
        totalLines: allLines.length,
        truncated: oversize,
      };
    } catch (err) {
      // Humanize fs errno (EISDIR/EACCES/ENOENT/...) — gated KHY_FS_ERROR_HUMANIZE
      // (default on); off / unknown errno → byte-identical to `err.message`.
      let _msg;
      try { _msg = require('../../services/fsReadErrorGuard').humanizeReadError(err, params && params.file_path, process.env); }
      catch { _msg = err.message; }
      return { success: false, error: _msg };
    }
  }
}

module.exports = new FileReadTool();
module.exports.FileReadTool = FileReadTool;
