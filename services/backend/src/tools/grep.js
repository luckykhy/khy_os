/**
 * Grep — content search tool using regular expressions.
 *
 * Searches file contents for a regex pattern, similar to ripgrep.
 * Supports output modes: files_with_matches, content, count.
 *
 * Execution strategy (cross-platform):
 *   1. ripgrep (rg) — fastest, works on Linux/macOS/Windows
 *   2. grep -rnE   — Unix fallback
 *   3. Pure-JS walk — universal fallback (no native binary needed)
 */
const fs = require('fs');
const path = require('path');

const _rtkMode = require('../services/rtkMode');
const { spawnWithIdleTimeout } = require('../utils/spawnWithIdleTimeout');
// RTK 省 token 模式:content 模式经 rtk grep 压缩输出(单一真源 services/rtkMode)。

const { defineTool } = require('./_baseTool');
const _walkBudget = require('./_walkBudget');
const {
  isRgAvailable,
  isGrepAvailable,
  shellEscape,
  pureJsGrep,
  pureJsGrepAsync,
  getShellConfiguration,
  DEFAULT_EXCLUDE_DIRS,
} = require('./platformUtils');
// 墙钟预算:无 rg/grep 时 pure-JS 回退是同步递归 walk,超大树 / Windows junction 回环 /
// 慢盘会把事件循环阻塞到分钟级(「一显示正在搜索就卡死」)。复用与 GlobTool/ListDirTool 同源
// 的 _walkBudget:预算耗尽提前收尾 + 门控开走异步 walk(不冻结事件循环)。

const MAX_OUTPUT = 100 * 1024; // 100 KB
const EXCLUDE_DIRS = DEFAULT_EXCLUDE_DIRS;

module.exports = defineTool({
  name: 'grep',
  description:
    'Search file CONTENTS for a regex pattern (ripgrep-style) and return matching file paths, lines, or counts. ' +
    'Use it to locate where code/text occurs inside files; use glob to find files by NAME, and webSearch for the internet. ' +
    'Constraints: pattern is a regex (escape literals like "foo\\.bar"); common dirs (node_modules, .git, dist) are always skipped; results are capped by max_results. ' +
    'Timeout semantics: timeout and idleTimeout BOTH set an idle (no-new-output) kill window in ms — not a total wall-clock cap; idleTimeout takes precedence when both are given (default 15000).',
  category: 'filesystem',
  risk: 'safe',
  isReadOnly: true,
  isConcurrencySafe: true,
  maxResultSizeChars: 40000,

  aliases: ['search_content', 'rg'],
  searchHint: 'search grep regex content files',

  inputSchema: {
    pattern: {
      type: 'string',
      required: true,
      description:
        'Ripgrep-compatible regular expression matched against line content, e.g. "function\\s+\\w+". Escape special chars for literal matches (e.g. "require\\(").',
      example: 'class\\s+\\w+',
    },
    path: {
      type: 'string',
      required: false,
      description:
        'File or directory to search, relative to CWD or absolute (default: CWD), e.g. "src/services".',
      example: 'src/services',
    },
    glob: {
      type: 'string',
      required: false,
      description:
        'Glob filter limiting which files are searched, e.g. "*.js" or "*.{ts,tsx}" (default: all non-excluded files).',
      example: '*.{ts,tsx}',
    },
    output_mode: {
      type: 'string',
      required: false,
      description:
        '"files_with_matches" (default) = file paths only; "content" = matching lines with file and line number; "count" = per-file match counts.',
      example: 'content',
    },
    max_results: {
      type: 'number',
      required: false,
      description: 'Maximum number of results to return (default: 50).',
      example: 100,
    },
    timeout: {
      type: 'number',
      required: false,
      description:
        'Idle (no-new-output) kill window in ms — NOT a total wall-clock limit (default: 15000). If idleTimeout is also set, idleTimeout wins.',
      example: 15000,
    },
    idleTimeout: {
      type: 'number',
      required: false,
      description:
        'Sliding idle timeout in ms: the search is killed after this long with no new output. Takes precedence over timeout (default: 15000).',
      example: 30000,
    },
    case_insensitive: {
      type: 'boolean',
      required: false,
      description: 'Case-insensitive matching (default: false).',
      example: true,
    },
  },

  getActivityDescription(input) {
    return `搜索内容：\"${(input.pattern || '').slice(0, 40)}\"`;
  },

  async execute(params, context = {}) {
    const cwd = process.env.KHYQUANT_CWD || process.cwd();
    const searchPath = params.path ? path.resolve(cwd, params.path) : cwd;
    const mode = params.output_mode || 'files_with_matches';
    const maxResults = params.max_results || 50;
    const idleTimeoutMs = Math.max(
      50,
      parseInt(
        String(
          params.idleTimeout || params.timeout || process.env.KHY_GREP_IDLE_TIMEOUT_MS || '15000'
        ),
        10
      ) || 15000
    );

    if (!fs.existsSync(searchPath)) {
      return { success: false, error: `Path not found: ${searchPath}` };
    }

    // RTK 省 token 模式:仅 content 模式经 `rtk grep` 压缩(截断长行 + 分组),
    // 解析回与原生同形的结构化 matches。files_with_matches/count 模式 rtk 无对应,
    // 保持原生。缺二进制/关闭/任何异常 → 静默回落下方原生 ripgrep 路径。
    if (mode === 'content' && _rtkMode.fileToolsEnabled()) {
      try {
        const bin = await _rtkMode.resolveBinary();
        if (bin) {
          const rtkResult = await _execRtkGrep(
            bin,
            params,
            cwd,
            maxResults,
            idleTimeoutMs,
            context
          );
          if (rtkResult) {
            return rtkResult;
          }
        }
      } catch {
        /* 回落原生路径 */
      }
    }

    // Strategy 1: ripgrep (best, cross-platform)
    if (isRgAvailable()) {
      return _execRg(params, searchPath, cwd, mode, maxResults, context, idleTimeoutMs);
    }

    // Strategy 2: Unix grep
    if (isGrepAvailable()) {
      return _execGrep(params, searchPath, cwd, mode, maxResults, context, idleTimeoutMs);
    }

    // Strategy 3: Pure-JS fallback (Windows without rg, or bare environments)
    return _execPureJs(params, searchPath, cwd, mode, maxResults);
  },
});

// ── ripgrep execution ───────────────────────────────────────────────
function _execRg(params, searchPath, cwd, mode, maxResults, context, idleTimeoutMs) {
  const args = ['--no-heading', '--line-number', '--color=never'];
  if (params.case_insensitive) {
    args.push('-i');
  }

  if (mode === 'files_with_matches') {
    args.push('-l');
  } else if (mode === 'count') {
    args.push('-c');
  }

  if (params.glob) {
    args.push('-g', params.glob);
  }

  for (const skip of EXCLUDE_DIRS) {
    args.push('-g', `!${skip}`);
  }

  args.push('--max-count', String(maxResults * 10)); // over-fetch for safety
  const escaped = shellEscape(params.pattern);
  const cmd = `rg ${args.join(' ')} ${escaped} ${shellEscape(searchPath)}`;

  return _runAndParse(cmd, cwd, mode, maxResults, searchPath, context, idleTimeoutMs, 'grep:rg');
}

// ── RTK grep execution (content 模式压缩) ───────────────────────────

/**
 * 经 `rtk grep` 跑 content 搜索,解析回与原生同形的 { success, matches, count, truncated }。
 * 失败/异常返回 null → 调用方回落原生 ripgrep。
 */
async function _execRtkGrep(bin, params, cwd, maxResults, idleTimeoutMs, context) {
  const argv = _rtkMode.buildGrepArgs(params);
  const traceCtx =
    context && context.traceContext && typeof context.traceContext === 'object'
      ? context.traceContext
      : {};
  const spawnEnv = { ...process.env, ...(traceCtx.env || {}), FORCE_COLOR: '0', NO_COLOR: '1' };

  let result;
  try {
    let totalOutBytes = 0;
    let totalErrBytes = 0;
    result = await spawnWithIdleTimeout(bin, argv, {
      idleMs: idleTimeoutMs,
      spawnOpts: { cwd, env: spawnEnv, windowsHide: true },
      label: 'grep:rtk',
      maxOutputBytes: MAX_OUTPUT,
      // 复用原生路径同一进度/活动契约,RTK 路由不丢失进度上报。
      onActivity: (payload) => {
        if (typeof context?.onActivity === 'function') {
          try {
            context.onActivity({ tool: 'grep', ...payload });
          } catch {
            /* non-critical */
          }
        }
      },
      onStdoutChunk: (chunk) => {
        totalOutBytes += Buffer.byteLength(String(chunk || ''), 'utf8');
        if (typeof context?.onProgress === 'function') {
          try {
            context.onProgress(`grep stdout ${Math.round(totalOutBytes / 1024)}KB`);
          } catch {
            /* non-critical */
          }
        }
      },
      onStderrChunk: (chunk) => {
        totalErrBytes += Buffer.byteLength(String(chunk || ''), 'utf8');
        if (typeof context?.onProgress === 'function') {
          try {
            context.onProgress(`grep stderr ${Math.round(totalErrBytes / 1024)}KB`);
          } catch {
            /* non-critical */
          }
        }
      },
    });
  } catch {
    return null; // spawn 失败 → 回落原生
  }

  // rtk grep 退出码:0 有结果 / 1 无匹配(非错误)/ 其他视作失败回落。
  // 注意:rtk 自身的 grep 子命令依赖 PATH 上的 grep 二进制;当 grep 缺失时 rtk 会以
  // exit code 1 + stderr「Failed to resolve 'grep' / search failed」失败——这**不是**「无匹配」。
  // 若只按 code 判断,会把「工具坏了」误报成「找到 0 个文件」,误导模型以为源码里没有该模式
  // (治「RTK 机器上搜索假 0 结果 / 反复空搜」)。检测 stderr 真实失败特征 → 回落原生路径。
  const _rtkErr = `${result.stdout || ''}${result.stderr || ''}`;
  if (/Failed to resolve|search failed|not found on PATH|Binary .* not found/i.test(_rtkErr)) {
    return null; // rtk 不可用(如 grep 依赖缺失)→ 回落原生 ripgrep/grep/pureJS
  }
  if (result.code === 1) {
    return { success: true, matches: [], count: 0, message: 'No matches found' };
  }
  if (result.code !== 0) {
    return null;
  }

  const raw = `${result.stdout || ''}${result.stderr ? `\n${result.stderr}` : ''}`;
  const matches = _rtkMode.parseGrepOutput(raw, { cwd, maxResults });
  return {
    success: true,
    matches,
    count: matches.length,
    truncated: matches.length >= maxResults,
  };
}

// ── Unix grep execution ─────────────────────────────────────────────

function _execGrep(params, searchPath, cwd, mode, maxResults, context, idleTimeoutMs) {
  const args = ['-rn'];
  if (params.case_insensitive) {
    args.push('-i');
  }

  if (mode === 'files_with_matches') {
    args.push('-l');
  } else if (mode === 'count') {
    args.push('-c');
  }

  args.push('-E');

  if (params.glob) {
    args.push(`--include=${params.glob}`);
  }

  for (const skip of EXCLUDE_DIRS) {
    args.push(`--exclude-dir=${skip}`);
  }

  const escaped = shellEscape(params.pattern);
  const cmd = `grep ${args.join(' ')} ${escaped} ${searchPath}`;

  return _runAndParse(cmd, cwd, mode, maxResults, searchPath, context, idleTimeoutMs, 'grep:grep');
}

// ── Common output parser ────────────────────────────────────────────

async function _runAndParse(cmd, cwd, mode, maxResults, searchPath, context, idleTimeoutMs, label) {
  const traceCtx =
    context && context.traceContext && typeof context.traceContext === 'object'
      ? context.traceContext
      : {};
  const spawnEnv = {
    ...process.env,
    ...(traceCtx.env || {}),
    FORCE_COLOR: '0',
    NO_COLOR: '1',
  };
  const { executable: shellBin, argsPrefix } = getShellConfiguration({ login: true });
  const shellArgs = [...argsPrefix, cmd];

  try {
    let totalOutBytes = 0;
    let totalErrBytes = 0;
    const result = await spawnWithIdleTimeout(shellBin, shellArgs, {
      idleMs: idleTimeoutMs,
      spawnOpts: {
        cwd,
        env: spawnEnv,
        windowsHide: true,
      },
      label,
      maxOutputBytes: MAX_OUTPUT,
      onActivity: (payload) => {
        if (typeof context?.onActivity === 'function') {
          try {
            context.onActivity({ tool: 'grep', ...payload });
          } catch {
            /* non-critical */
          }
        }
      },
      onStdoutChunk: (chunk) => {
        totalOutBytes += Buffer.byteLength(String(chunk || ''), 'utf8');
        if (typeof context?.onProgress === 'function') {
          try {
            context.onProgress(`grep stdout ${Math.round(totalOutBytes / 1024)}KB`);
          } catch {
            /* non-critical */
          }
        }
      },
      onStderrChunk: (chunk) => {
        totalErrBytes += Buffer.byteLength(String(chunk || ''), 'utf8');
        if (typeof context?.onProgress === 'function') {
          try {
            context.onProgress(`grep stderr ${Math.round(totalErrBytes / 1024)}KB`);
          } catch {
            /* non-critical */
          }
        }
      },
    });

    // grep/rg exit code 1 means "no matches" (not an execution failure).
    if (result.code === 1) {
      return { success: true, matches: [], count: 0, message: 'No matches found' };
    }
    if (result.code !== 0) {
      const mergedErr = `${result.stdout || ''}${result.stderr ? `\n${result.stderr}` : ''}`.trim();
      return {
        success: false,
        error: mergedErr || `Search command failed with exit code ${result.code}`,
      };
    }

    const output = `${result.stdout || ''}${result.stderr ? `\n${result.stderr}` : ''}`;
    if (!output || !output.trim()) {
      return { success: true, matches: [], count: 0, message: 'No matches found' };
    }

    const lines = output.trim().split('\n');

    if (mode === 'files_with_matches') {
      const files = lines.slice(0, maxResults).map((f) => path.relative(cwd, f.trim()));
      return { success: true, files, count: files.length, truncated: lines.length > maxResults };
    }

    if (mode === 'count') {
      const counts = [];
      for (const line of lines.slice(0, maxResults)) {
        const sep = line.lastIndexOf(':');
        if (sep > 0) {
          const file = path.relative(cwd, line.slice(0, sep));
          const count = parseInt(line.slice(sep + 1), 10);
          if (count > 0) {
            counts.push({ file, count });
          }
        }
      }
      return { success: true, counts, total: counts.reduce((s, c) => s + c.count, 0) };
    }

    // mode === 'content'
    const matches = lines.slice(0, maxResults).map((line) => {
      const firstColon = line.indexOf(':');
      const secondColon = line.indexOf(':', firstColon + 1);
      if (firstColon > 0 && secondColon > 0) {
        return {
          file: path.relative(cwd, line.slice(0, firstColon)),
          line: parseInt(line.slice(firstColon + 1, secondColon), 10),
          content: line.slice(secondColon + 1),
        };
      }
      return { raw: line };
    });

    return { success: true, matches, count: matches.length, truncated: lines.length > maxResults };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ── Pure-JS fallback ────────────────────────────────────────────────

async function _execPureJs(params, searchPath, cwd, mode, maxResults) {
  try {
    const flags = params.case_insensitive ? 'i' : '';
    const regex = new RegExp(params.pattern, flags);

    // 墙钟预算 + 异步 walk:门开走纯JsGrepAsync(事件循环不被冻结,既有超时/中断恢复生效);
    // 门关 → 逐字节回退今日同步 pureJsGrep(无预算)。
    const deadline = _walkBudget.createWalkDeadline(process.env);
    const result = _walkBudget.isWalkAsyncEnabled(process.env)
      ? await pureJsGrepAsync(searchPath, regex, {
          mode,
          glob: params.glob,
          maxResults,
          excludeDirs: EXCLUDE_DIRS,
          deadline,
        })
      : pureJsGrep(searchPath, regex, {
          mode,
          glob: params.glob,
          maxResults,
          excludeDirs: EXCLUDE_DIRS,
          deadline,
        });

    if (mode === 'files_with_matches') {
      const files = result.files.map((f) => path.relative(cwd, f));
      const out = { success: true, files, count: files.length, truncated: result.truncated };
      if (result.timedOut) {
        out.timedOut = true;
      }
      return out;
    }

    if (mode === 'count') {
      const counts = (result.counts || []).map((c) => ({
        file: path.relative(cwd, c.file),
        count: c.count,
      }));
      const out = { success: true, counts, total: result.total || 0 };
      if (result.timedOut) {
        out.timedOut = true;
      }
      return out;
    }

    // mode === 'content'
    const matches = (result.matches || []).map((m) => ({
      file: path.relative(cwd, m.file),
      line: m.line,
      content: m.content,
    }));
    const out = { success: true, matches, count: matches.length, truncated: result.truncated };
    // 预算耗尽:结果可能不完整,诚实标注(加法式;无预算时永不出现 → 字节回退)。
    if (result.timedOut) {
      out.timedOut = true;
    }
    return out;
  } catch (err) {
    return { success: false, error: `Pure-JS grep error: ${err.message}` };
  }
}
