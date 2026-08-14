const { defineTool } = require('./_baseTool');
const fs = require('fs');
const path = require('path');

const LEGACY_MAX_SIZE = 500 * 1024; // 500 KB (historical hard cap)

// 文件读取上限的单一真源(纯叶子)。fail-soft:缺失则回退 legacy 常量 + 超限硬报错。
let _fileReadLimit;
try { _fileReadLimit = require('./fileReadLimit'); } catch { _fileReadLimit = null; }
function _maxBytes() {
  return _fileReadLimit ? _fileReadLimit.resolveMaxBytes(process.env, LEGACY_MAX_SIZE) : LEGACY_MAX_SIZE;
}
function _partialOnOversize() {
  return _fileReadLimit ? _fileReadLimit.partialOnOversizeEnabled(process.env) : false;
}

module.exports = defineTool({
  name: 'readFile',
  description: 'Read a file from the filesystem. Large files are read up to a bounded window with a pagination hint (use offset/limit to continue).',
  category: 'filesystem',
  risk: 'low',
  isReadOnly: true,
  isConcurrencySafe: true,

  // Chapter 5 additions
  aliases: ['read_file', 'cat'],
  searchHint: 'read file contents from filesystem',
  maxResultSizeChars: Infinity, // never persist to disk (prevents circular reads)

  inputSchema: {
    path: { type: 'string', required: true, description: 'File path (relative to CWD or absolute)' },
    encoding: { type: 'string', required: false, description: 'File encoding (default: utf-8)' },
    offset: { type: 'number', required: false, description: 'Line number to start reading from (1-based)' },
    limit: { type: 'number', required: false, description: 'Number of lines to read' },
  },

  async validateInput(input) {
    const { validateNotDevicePath, validateNotUNCPath, composeValidations } = require('./inputValidators');
    return composeValidations(
      validateNotDevicePath(input.path),
      validateNotUNCPath(input.path),
    );
  },

  getActivityDescription(input) {
    return `读取文件：${input.path || 'file'}`;
  },

  async execute(params, context) {
    try {
      const cwd = process.env.KHYQUANT_CWD || process.cwd();
      // Expand environment variables in path (%USERNAME%, $HOME, ~)
      let rawPath = params.path;
      if (process.platform === 'win32') {
        rawPath = rawPath.replace(/%([^%]+)%/g, (_, key) => process.env[key] || `%${key}%`);
      } else {
        rawPath = rawPath.replace(/\$\{?(\w+)\}?/g, (_, key) => process.env[key] || '');
      }
      if (rawPath.startsWith('~')) {
        rawPath = path.join(require('os').homedir(), rawPath.slice(1));
      }
      try { rawPath = require('./_userDirs').normalizeDesktopPath(rawPath); } catch { /* ignore */ }

      // [SAFE] Reads default to GLOBALLY READABLE (user requirement「全局可读」).
      // We still block UNC/device paths (NTLM-leak / device-handle hazards), but an
      // out-of-project read is NOT hard-failed here: the PreToolUse readBoundaryGuard
      // owns the approve-on-demand prompt and remembers granted dirs. Hard-failing at
      // this layer was the bug that made an already-approved Windows read still return
      // "Refused ... outside the project". Defense-in-depth confinement is still
      // available behind KHY_STRICT_READ_BOUNDARY=1 (then out-of-scope reads become an
      // *approvable* denial, never a silent dead-end). Re-run AFTER env-var/~ expansion
      // since validateInput() only saw the raw params.path.
      {
        const { validateNotUNCPath, validateReadAccess } = require('./inputValidators');
        const uncCheck = validateNotUNCPath(rawPath);
        if (!uncCheck.valid) return { success: false, error: uncCheck.message };
        const accessCheck = validateReadAccess(rawPath);
        if (!accessCheck.valid) return { success: false, error: accessCheck.message, approvable: accessCheck.approvable };
      }

      const filePath = path.resolve(cwd, rawPath);

      // Windows 保留设备名(CON/COM1/NUL/LPT1/\\.\…)读前防护:第五条卡死向量,按「路径名」拦。
      // 兄弟守卫(特殊文件/伪文件/二进制)都是 POSIX 语义或 Linux 专属,`isBlockedDevicePath`
      // 又只认 POSIX `/dev/*` 精确名单——对离机继任的 **Windows** 机毫无覆盖。读到 `COM1`/`CON`
      // 会永久等待设备输入而卡死。纯路径判定、零 IO,故必须排在 `fs.statSync` **触碰设备之前**。
      // 门控 KHY_READFILE_WIN_DEVICE_GUARD(默认开);关 → 逐字节回退历史行为(照旧 statSync→卡死)。
      // fail-soft:判定抛错 → 跳过,回退历史读取路径。
      try {
        const { winDeviceGuardEnabled, classifyWindowsDevice, buildWinDeviceRefusal } = require('./winDeviceReadGuard');
        if (winDeviceGuardEnabled(process.env)) {
          const _wkind = classifyWindowsDevice(filePath);
          if (_wkind) {
            return {
              success: false,
              error: buildWinDeviceRefusal({ kind: _wkind, path: filePath }),
              winDevice: _wkind,
            };
          }
        }
      } catch { /* 判定失败 → 回退历史读取行为 */ }

      const stat = fs.statSync(filePath);
      // Directory read would throw a raw `EISDIR: illegal operation on a
      // directory, read`. Return a friendly message instead of surfacing the
      // bare "illegal operation" string. Gated KHY_FS_ERROR_HUMANIZE (default
      // on); off → message is null and we fall through to the historical throw.
      if (stat.isDirectory()) {
        let _dirMsg = null;
        try { _dirMsg = require('../services/fsReadErrorGuard').directoryReadMessage(filePath, process.env); } catch { _dirMsg = null; }
        if (_dirMsg) return { success: false, error: _dirMsg };
      }

      // 特殊文件(FIFO/套接字/字符或块设备)读前防护:必须在 detectFile / 二进制守卫 /
      // readTextFileSmart 之前拦下——因为读这些非常规文件的第一个字节就会**永久阻塞**
      // (等写端/无尽输入),连 detectFile 探 magic 字节都会先卡死。它们 size=0 且非二进制
      // 格式,故会溜过 OPS-121/OPS-123 的所有守卫。`fs.statSync` 对 FIFO/设备只读元数据、
      // 瞬时返回不阻塞(已实测 0ms),故此处用已算好的 stat 的类型谓词安全判定。
      // 门控 KHY_READFILE_SPECIAL_GUARD(默认开);关 → 逐字节回退历史行为(对特殊文件照旧
      // 走 detectFile/解码 → 卡死)。fail-soft:抛错 → 跳过,回退历史读取路径。
      try {
        const { specialReadGuardEnabled, classifySpecialFile, buildSpecialFileRefusal } = require('./specialFileReadGuard');
        if (specialReadGuardEnabled(process.env)) {
          const _kind = classifySpecialFile(stat);
          if (_kind) {
            return {
              success: false,
              error: buildSpecialFileRefusal({ kind: _kind, path: filePath, size: stat.size }),
              specialFile: _kind,
              size: stat.size,
            };
          }
        }
      } catch { /* 判定失败 → 回退历史读取行为 */ }

      // 伪文件系统(/proc·/sys)阻塞文件读前防护:第四条卡死向量,按「文件位置」拦。
      // Linux `/proc`·`/sys` 下是**常规文件**(isFile=true)、size=0、内容读时现生成——其中
      // 一部分(/proc/kmsg 等)读第一个字节就**永久阻塞**。它们溜过特殊文件守卫(类型谓词全
      // false)、溜过超限检查(0>maxBytes 恒 false),随后 detectFile 探 magic 字节就卡死。
      // 承 OPS-123 教训「路由到有界读,别一律拒绝」:把阻塞读搬进子进程 `head -c N`,用
      // spawnSync 的 timeout 保底杀掉——有限伪文件(cpuinfo)秒回内容,阻塞伪文件到点被杀→
      // 有界返回绝不挂起(同步阻塞读无法在进程内超时,故必须搬进可被杀的子进程)。
      // 门控 KHY_READFILE_PSEUDO_GUARD(默认开);关 → 逐字节回退历史行为(照旧 detectFile→卡死)。
      // fail-soft:handled:false / 抛错 → 跳过,回退历史读取路径。
      try {
        const { shouldBoundedRead, readPseudoFileBounded } = require('./pseudoFileReadGuard');
        const _pkind = shouldBoundedRead({ absPath: filePath, stat, env: process.env });
        if (_pkind) {
          const routed = readPseudoFileBounded({ filePath, kind: _pkind, env: process.env });
          if (routed && routed.handled) return routed.result;
        }
      } catch { /* 判定/有界读失败 → 回退历史读取行为 */ }

      // 二进制/压缩文件读前处理:把已存在的 fileFormatDetector.isBinary 能力接进读工具
      // (写工具 replaceAtLocation / inspectDocument 早已消费,读工具历史上漏接)。命中二进制后:
      //   1) 先尝试「按格式路由到已存在提取器」(PDF/图片/压缩包/docx),真正读出可读内容;
      //   2) 无提取器 / 提取失败 → 落 OPS-121 的信息性拒绝(绝不把二进制字节解码成乱码注入
      //      模型上下文,会拖垮模型请求)。
      // 三层可逐级回退:格式路由(KHY_READFILE_FORMAT_ROUTE,默认开)→ OPS-121 拒绝
      //   (KHY_READFILE_BINARY_GUARD,默认开)→ 更旧的解码注入(两门都关)。
      // fail-soft:任一步抛错 → 跳过,回退历史文本读取行为。
      try {
        const { binaryReadGuardEnabled, isBinaryForRead, buildBinaryReadRefusal } = require('./readBinaryGuard');
        if (binaryReadGuardEnabled(process.env)) {
          const { detectFile } = require('../services/formatInspect/fileFormatDetector');
          const fmt = detectFile(filePath);
          if (isBinaryForRead(fmt)) {
            // 1) 先试按格式路由到提取器,真正读出内容(提取器全有界,故不会卡死)。
            try {
              const { routeFormatRead } = require('./readFileFormatRouter');
              const routed = await routeFormatRead({ filePath, fmt, size: stat.size, env: process.env });
              if (routed && routed.handled) return routed.result;
            } catch { /* 路由失败 → 落 OPS-121 拒绝兜底 */ }
            // 2) 无提取器 / 提取失败 → OPS-121 信息性拒绝(兜底地板,行为不变)。
            return {
              success: false,
              error: buildBinaryReadRefusal({
                format: fmt.format,
                magicFormat: fmt.magicFormat,
                category: fmt.category,
                size: stat.size,
              }),
              binary: true,
              format: fmt.magicFormat || fmt.format || null,
              size: stat.size,
            };
          }
        }
      } catch { /* 探测失败 → 回退历史文本读取行为 */ }

      const maxBytes = _maxBytes();
      let oversize = false;
      if (stat.size > maxBytes) {
        // 门控关 → 逐字节回退历史「超限硬报错」;门控开 → 读有界窗口 + 诚实分页提示。
        if (!_partialOnOversize()) {
          return { success: false, error: `File too large: ${stat.size} bytes (max ${maxBytes}). Use offset/limit or a shell command to read portions.` };
        }
        oversize = true;
      }

      // 编码自适应：未显式指定 encoding 时探测 GBK/Shift-JIS/Big5 等遗留编码，
      // 合法 UTF-8 文件恒判为 utf-8，行为与旧默认一致。超限时只读前 maxBytes 字节。
      const { readTextFileSmart } = require('../utils/fileEncoding');
      const { text: raw } = readTextFileSmart(filePath, {
        encoding: params.encoding,
        maxBytes: oversize ? maxBytes : undefined,
      });
      const _notice = oversize && _fileReadLimit
        ? _fileReadLimit.buildOversizeNotice({ totalBytes: stat.size, maxBytes })
        : '';

      // Apply offset/limit for line-range reading
      if (params.offset || params.limit) {
        const lines = raw.split('\n');
        const start = Math.max(0, (params.offset || 1) - 1);
        const end = params.limit ? start + params.limit : lines.length;
        const sliced = lines.slice(start, end);

        // Add line numbers
        const numbered = sliced.map((line, i) => `${start + i + 1}\t${line}`).join('\n');
        return { success: true, content: numbered + _notice, size: stat.size, lines: sliced.length, truncated: oversize };
      }

      return { success: true, content: raw + _notice, size: stat.size, truncated: oversize };
    } catch (err) {
      // Humanize common fs errno (EISDIR/EACCES/ENOENT/...) instead of leaking
      // the raw "illegal operation" style message. Gated KHY_FS_ERROR_HUMANIZE
      // (default on); off / unknown errno → byte-identical to `err.message`.
      let _msg;
      try { _msg = require('../services/fsReadErrorGuard').humanizeReadError(err, params && params.path, process.env); }
      catch { _msg = err.message; }
      return { success: false, error: _msg };
    }
  },
});
