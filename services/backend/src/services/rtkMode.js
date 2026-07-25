'use strict';

/**
 * rtkMode —— khy 的「RTK 省 token 模式」单一真源。
 *
 * RTK(Rust Token Killer)是一个把命令输出过滤/压缩 60–90% 后再喂给 LLM 的 CLI 代理。
 * 本模块把「是否启用 / 如何定位二进制 / 如何把一条 shell 命令改写成 rtk 等价命令 /
 * 如何为 grep 构造 rtk argv / 如何剥离 rtk 元信息 / 如何解析 rtk gain」收敛成单一真源,
 * 供 shellCommand / grep / RtkGainTool / CLI 复用。
 *
 * 纯/IO 分层(本模块**不是**零 IO 叶子,刻意如此):改写/解析(rewriteShellCommand /
 * buildGrepArgs / parseGrepOutput / stripRtkMeta / parseGain)是确定性纯函数可单测;
 * 定位二进制读盘(fs.accessSync)与执行(spawnSync,经 __setSpawn 可注入)是真实 IO。
 *
 * 设计红线:
 *   · 默认开启,经 KHY_RTK_MODE / KHY_RTK_FILE_TOOLS / KHY_RTK_AUTO_INSTALL 一键关闭
 *     (关 ∈ {0,false,off,no}),关掉即字节回到原生命令——零破坏。
 *   · 绝不抛:任何异常/缺二进制/退出码非改写态 → 返回 null,调用方静默回落原生路径。
 *   · 不在此模块做安装:resolveBinary 只「定位」;安装由 rtkInstaller 负责,由接缝在
 *     缺失且 autoInstallEnabled() 时 fire-and-forget 触发,绝不阻塞回合。
 */

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const cmdAvail = require('./gateway/adapters/_commandAvailability');
// 数据家单一真源:本地二进制落 ~/.khy/bin/rtk,与 backend 同根(见 ../utils/dataHome)。
const { getAppDataDir } = require('../utils/dataHome');

// ── 门控(遵循 khy _enabled() 惯例,默认 on,关 ∈ {0,false,off,no})────────────
const _FALSY = new Set(['0', 'false', 'off', 'no']);
function _truthyEnv(name, dflt = 'true') {
  const raw = process.env[name];
  const v = String(raw === undefined || raw === null ? dflt : raw).trim().toLowerCase();
  return !_FALSY.has(v);
}

/** 主开关。关 = 完全回到现状(smartTruncation 仍在)。 */
function modeEnabled() { return _truthyEnv('KHY_RTK_MODE'); }
/** 子开关:dedicated 文件工具(grep content)路由。受主开关约束。 */
function fileToolsEnabled() { return modeEnabled() && _truthyEnv('KHY_RTK_FILE_TOOLS'); }
/** 首次缺失时是否允许自动安装(联网/编译)。关 = 只在 rtk 已存在时启用。 */
function autoInstallEnabled() { return _truthyEnv('KHY_RTK_AUTO_INSTALL'); }

// ── 可注入 spawn(测试入口)────────────────────────────────────────────────
let _spawnImpl = null; // (file, args, opts) => { status, stdout, stderr, error? }
function __setSpawn(fn) { _spawnImpl = fn; }
function __clearSpawn() { _spawnImpl = null; }

function _runSync(file, args, opts = {}) {
  if (typeof _spawnImpl === 'function') return _spawnImpl(file, args, opts);
  const r = spawnSync(file, args, {
    encoding: 'utf8',
    timeout: opts.timeout || 8000,
    cwd: opts.cwd,
    windowsHide: true,
    maxBuffer: opts.maxBuffer || 8 * 1024 * 1024,
  });
  return {
    status: r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    error: r.error || null,
  };
}

// ── 二进制定位(缓存,TTL)──────────────────────────────────────────────────
let _binCache = { value: undefined, at: 0 };
const _BIN_TTL_MS = 30000;

function _binName() { return process.platform === 'win32' ? 'rtk.exe' : 'rtk'; }
/** 本地二进制路径 ~/.khy/bin/rtk(经 dataHome 单一真源)。 */
function localBinPath() {
  try { return path.join(getAppDataDir('bin'), _binName()); } catch { return null; }
}

/**
 * 定位可用的 rtk 二进制:优先 ~/.khy/bin/rtk(自动安装落点),再回落 PATH 上的 rtk。
 * 返回可执行的二进制路径字符串,或 null(未安装)。结果缓存 TTL 内复用。
 * 不触发安装——安装由调用方按 autoInstallEnabled() 决定。
 */
async function resolveBinary({ force = false } = {}) {
  const now = Date.now();
  if (!force && _binCache.value !== undefined && (now - _binCache.at) < _BIN_TTL_MS) {
    return _binCache.value;
  }

  let resolved = null;

  // 1) 本地 ~/.khy/bin/rtk(自动安装落点,优先)
  const local = localBinPath();
  if (local) {
    try {
      fs.accessSync(local, fs.constants.X_OK);
      resolved = local;
    } catch { /* 本地不存在,继续 */ }
  }

  // 2) PATH 上的 rtk(非阻塞探测,共享 _commandAvailability 缓存)
  if (!resolved) {
    try {
      const probe = await cmdAvail.checkAsync('rtk');
      if (probe && probe.ok) resolved = 'rtk';
    } catch { /* 探测失败 = 不可用 */ }
  }

  _binCache = { value: resolved, at: Date.now() };
  return resolved;
}

// ── rtk 元信息剥离 ──────────────────────────────────────────────────────────
/**
 * 去除 rtk 向 stderr 打印的 `[rtk] ...` 噪声行(如 untrusted project filters 警告),
 * 避免污染模型上下文。仅删整行以 `[rtk]` 开头者,其余文本逐字保留。
 */
function stripRtkMeta(text) {
  if (typeof text !== 'string' || text.length === 0) return text || '';
  return text
    .split('\n')
    .filter((line) => !/^\s*\[rtk\]/i.test(line))
    .join('\n');
}

// ── shell 命令改写(rtk rewrite 退出码协议)─────────────────────────────────
/**
 * 把一条 shell 命令交给 `rtk rewrite` 翻译成 rtk 等价命令。
 *
 * rtk rewrite 退出码协议:
 *   0 = allow/rewritten   → stdout 为 rtk 等价命令,采用
 *   3 = ask/rewritten     → 同上(khy 自身已有审批闸,这里只取改写结果)
 *   1 = passthrough(无等价) / 2 = deny → 返回 null,交回 khy 原生路径与自身 gate
 *
 * @param {string} cmd 原始 shell 命令
 * @param {{bin?:string}} [opts] bin:resolveBinary() 得到的二进制路径
 * @returns {{run:string, code:number}|null} 改写结果或 null(无改写/失败)
 */
function rewriteShellCommand(cmd, opts = {}) {
  if (!cmd || typeof cmd !== 'string') return null;
  const bin = opts.bin || 'rtk';

  let r;
  try {
    r = _runSync(bin, ['rewrite', cmd], { timeout: 5000 });
  } catch { return null; }
  if (!r || r.error) return null;

  const code = r.status;
  if (code !== 0 && code !== 3) return null; // 1 passthrough / 2 deny / 其他

  let run = stripRtkMeta(String(r.stdout || '')).trim();
  if (!run || run === cmd) return null; // 空 / 无变化 → 视作无改写

  // rtk rewrite 的 stdout 以裸 `rtk` 开头;当二进制是本地绝对路径(不在 PATH)时,
  // 把首个 `rtk` 令牌替换为实际路径,否则改写后的命令在 PATH 无 rtk 时会执行失败。
  if (bin && bin !== 'rtk' && /^rtk(\s|$)/.test(run)) {
    const q = /\s/.test(bin) ? `"${bin}"` : bin;
    run = run.replace(/^rtk/, q);
  }

  return { run, code };
}

// ── grep argv 构造 + 输出解析 ───────────────────────────────────────────────
/**
 * khy grep params → `rtk grep` argv。
 * rtk grep 签名:`rtk grep [OPTIONS] <PATTERN> [PATH] [EXTRA_ARGS]...`
 * case_insensitive / glob 作为透传 ripgrep 参数附在末尾。
 */
function buildGrepArgs(params = {}) {
  const args = ['grep', String(params.pattern == null ? '' : params.pattern)];
  args.push(params.path ? String(params.path) : '.');
  if (params.case_insensitive) args.push('-i');
  if (params.glob) args.push('--glob', String(params.glob));
  return args;
}

/**
 * 解析 `rtk grep` 输出为结构化 matches(与原生 grep content 模式同形)。
 * rtk grep 输出形如:
 *   `N matches in M files:`(头,跳过)
 *   `<file>:<line>:<content>`(逐行,content 已被 rtk 截断)
 * 返回 [{ file(相对 cwd), line, content }]。
 */
function parseGrepOutput(raw, opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const maxResults = Number.isFinite(opts.maxResults) ? opts.maxResults : 50;
  const text = stripRtkMeta(String(raw == null ? '' : raw));
  const matches = [];

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // 头行 `8 matches in 1 files:` 跳过
    if (/^\d+\s+matches?\s+in\s+\d+\s+files?:?$/i.test(trimmed)) continue;

    const firstColon = line.indexOf(':');
    const secondColon = firstColon >= 0 ? line.indexOf(':', firstColon + 1) : -1;
    if (firstColon > 0 && secondColon > firstColon) {
      const file = line.slice(0, firstColon);
      const lineNo = parseInt(line.slice(firstColon + 1, secondColon), 10);
      if (Number.isFinite(lineNo)) {
        const abs = path.resolve(cwd, file);
        matches.push({
          file: path.relative(cwd, abs),
          line: lineNo,
          content: line.slice(secondColon + 1),
        });
        if (matches.length >= maxResults) break;
      }
    }
  }
  return matches;
}

// ── rtk gain 解析 + 便捷运行 ────────────────────────────────────────────────
/**
 * 解析 `rtk gain` 文本输出为结构化统计。best-effort,字段缺失为 null。
 * @returns {{totalCommands:number|null, inputTokens:string|null, outputTokens:string|null,
 *            tokensSaved:string|null, savedPercent:number|null,
 *            perCommand:Array<{rank,command,count,saved,avgPercent}>}}
 */
function parseGain(raw) {
  const text = stripRtkMeta(String(raw == null ? '' : raw));
  const out = {
    totalCommands: null,
    inputTokens: null,
    outputTokens: null,
    tokensSaved: null,
    savedPercent: null,
    perCommand: [],
  };

  const mCmd = text.match(/Total commands:\s*([\d.,]+)/i);
  if (mCmd) {
    const n = Number(mCmd[1].replace(/,/g, ''));
    if (Number.isFinite(n)) out.totalCommands = n;
  }
  const mIn = text.match(/Input tokens:\s*([\d.]+[KMB]?)/i);
  if (mIn) out.inputTokens = mIn[1];
  const mOut = text.match(/Output tokens:\s*([\d.]+[KMB]?)/i);
  if (mOut) out.outputTokens = mOut[1];
  const mSaved = text.match(/Tokens saved:\s*([\d.]+[KMB]?)\s*\(([\d.]+)%\)/i);
  if (mSaved) {
    out.tokensSaved = mSaved[1];
    const pct = Number(mSaved[2]);
    if (Number.isFinite(pct)) out.savedPercent = pct;
  }

  // 表格行:" 1.  rtk read                   2094    7.6M   26.0%   ..."
  const rowRe = /^\s*(\d+)\.\s+(.+?)\s{2,}(\d+)\s+([\d.]+[KMB]?)\s+([\d.]+)%/;
  for (const line of text.split('\n')) {
    const m = line.match(rowRe);
    if (m) {
      out.perCommand.push({
        rank: Number(m[1]),
        command: m[2].trim(),
        count: Number(m[3]),
        saved: m[4],
        avgPercent: Number(m[5]),
      });
    }
  }
  return out;
}

/**
 * 运行 `rtk gain [--project]` 并返回解析后的统计(+ raw)。失败返回 { error }。
 */
function runGain(opts = {}) {
  const bin = opts.bin || 'rtk';
  const args = ['gain'];
  if (opts.project) args.push('--project');
  let r;
  try {
    r = _runSync(bin, args, { timeout: 8000, cwd: opts.cwd });
  } catch (err) {
    return { error: String((err && err.message) || err || 'rtk gain failed') };
  }
  if (!r || r.error || (r.status !== 0 && r.status !== null)) {
    return { error: stripRtkMeta(String((r && r.stderr) || '')).trim() || 'rtk gain failed', status: r ? r.status : null };
  }
  const raw = stripRtkMeta(String(r.stdout || ''));
  return { raw, stats: parseGain(raw) };
}

/**
 * 探测 rtk 版本字符串(如 "rtk 0.39.0"),失败返回 null。
 */
function probeVersion(opts = {}) {
  const bin = opts.bin || 'rtk';
  let r;
  try {
    r = _runSync(bin, ['--version'], { timeout: 5000 });
  } catch { return null; }
  if (!r || r.error) return null;
  const out = stripRtkMeta(String(r.stdout || r.stderr || '')).trim();
  return out || null;
}

// ── 测试入口 ────────────────────────────────────────────────────────────────
function __clearCache() {
  _binCache = { value: undefined, at: 0 };
}

module.exports = {
  // gating
  modeEnabled,
  fileToolsEnabled,
  autoInstallEnabled,
  // binary
  resolveBinary,
  localBinPath,
  // shell
  rewriteShellCommand,
  // grep
  buildGrepArgs,
  parseGrepOutput,
  // meta / stats
  stripRtkMeta,
  parseGain,
  runGain,
  probeVersion,
  // test entry points
  __setSpawn,
  __clearSpawn,
  __clearCache,
};
