'use strict';

/**
 * startupFailureExplain.js — 他机首启崩溃的「真实原因 + 解决方法」归因（确定性纯叶子）
 *
 * 送别礼「错误真实原因加方法」角度。pip/npm 是仅有的两条离机渠道，他机装完首启时
 * backend 的 node_modules 若半装/未联网 hydrate/被清，bin/khy.js 起来后深层 require
 * 会抛 MODULE_NOT_FOUND；原生模块（better-sqlite3 等）跨平台复制未重建则抛
 * ERR_DLOPEN_FAILED。今日 bin/khy.js 的 _emitFatal 只吐一行**裸 stack**——这正是被
 * 红线点名的反模式：只报「找不到」，不说真实原因、不给怎么修。
 *
 * cli.py:2305 已为「bin/khy.js 文件缺失」示范了「真实原因 + 解决方法」的好样子，但它
 * 只管**文件不在**的情形，且 Unix 上 os.execvpe 之后 Python 归因不可达。本文件补上更常见
 * 的**依赖不齐**情形：文件在、进程起来、深层 require 才崩。归因逻辑仓内早已具备
 * （scripts/lib/hydrationHealth.js 的 _RULES），但它只在 doctor CLI 跑，从不在崩溃路径。
 * 本文件把「崩溃现场的 err」→「一句真实原因 + 照抄即用的修法」，交给 _emitFatal 追加。
 *
 * 与四件构建期送别礼（restore/install/hydration/bundle-launch）不同：那四件在发布仓跑、
 * 不进 bundle；本文件是**运行时**错误增强，随 backend 源码树一起打包进 pip/npm，故落在
 * services/backend/src/bootstrap/ 而非 scripts/lib/。
 *
 * 分层（同 windowsSpawnHardening）：纯核心——零 IO、无时钟、无随机、同输入恒同输出、
 * 绝不抛（任何异常退化为安全 null = 逐字节回退今日裸 stack）。做 IO 的探测/呈现在
 * bin/khy.js 的 _emitFatal 里，且对本文件的 require 亦包 try/catch，绝不加重致命路径。
 *
 * 门控 KHY_STARTUP_FAILURE_EXPLAIN（default-on，CANON off:4 词）。关 → 返回 null →
 * _emitFatal 逐字节回退今日行为。
 *
 * HOW-TO-EXTEND（给下一个维护者 / 小模型）
 *   1. 新增一类首启崩溃归因 → 往 _CLASSIFIERS 追加一条 { id, match(err), build(ctx) }。
 *      match(err) 纯谓词，命中返回真；build 返回 { cause, fixes } —— cause 是人话一句
 *      「真实原因」，fixes 是 { common:[], win32:[], unix:[] } 三组照抄即用的修法。
 *   2. 修法务必安全，不得含 commit/push/rm -rf/curl/wget/publish 等危险动作
 *      （_DANGER_TOKENS 自检守此线，规则表本身必须天然干净）。
 *   3. 改完跑：node --test services/backend/tests/bootstrap/startupFailureExplain.test.js。
 */

// ── 门控（KHY_STARTUP_FAILURE_EXPLAIN，default-on，CANON off:4 词）──────────────
const _FALSY = new Set(['0', 'false', 'off', 'no']);

// 刻意**不**走 flagRegistry：本门是 sibling 门（不进注册表，同 KHY_TASK_STORE_RELOAD_ON_STALE
// 等），flagRegistry 对未登记 flag 会回默认开、吞掉 off；且崩溃现场 require flagRegistry 可能
// 命中缺失依赖。故直读 env，最简且最安全。
function isEnabled(env = process.env) {
  const e = env || {};
  const v = e.KHY_STARTUP_FAILURE_EXPLAIN;
  return !(v !== undefined && v !== null && _FALSY.has(String(v).trim().toLowerCase()));
}

// 修法里绝不允许出现的危险动作（与 hydrationHealth / 1000 条手册同源红线）。
const _DANGER_TOKENS = [
  'git commit', 'git push', 'rm -rf /', 'rm -r /', 'curl ', 'wget ',
  'npm publish', 'twine', 'sudo rm', '> /dev', 'mkfs',
];

/** 安全读 err 字段：恶意 getter 抛错也不冒泡（崩溃现场 err 形态不可信）。 */
function _safeStr(getter) {
  try {
    const v = getter();
    return v === undefined || v === null ? '' : String(v);
  } catch {
    return '';
  }
}

/** 从 "Cannot find module 'X'" 里提取缺失模块名；提不出返回 ''。 */
function _missingModuleName(message) {
  const m = /Cannot find module ['"]([^'"]+)['"]/.exec(String(message || ''));
  return m ? m[1] : '';
}

// 归因规则表：顺序即匹配优先级。每条 build(ctx) 返回 { cause, fixes:{common,win32,unix} }。
// ctx = { code, message, missingModule, platform }。
const _CLASSIFIERS = [
  {
    id: 'module-not-found',
    match: (ctx) => ctx.code === 'MODULE_NOT_FOUND'
      || /Cannot find module ['"]/.test(ctx.message),
    build: (ctx) => {
      const named = ctx.missingModule ? `（缺少模块 '${ctx.missingModule}'）` : '';
      return {
        cause: `后端运行时依赖未装齐${named}——首启联网 hydrate 未完成、被中断，或 node_modules 半装/被清。`,
        fixes: {
          common: [
            '联网后重跑一次 khy（或 khy doctor）触发首启 hydrate，会自动在后端目录补装依赖。',
            '若仍缺：删除后端目录下的 .khy_quant_bootstrapped 与 package-lock.json 后重跑 khy 全量重装。',
          ],
          win32: [
            'Windows 若上次升级被文件占用中断：先 khy stop 释放占用，再 pip install --force-reinstall --no-cache-dir khy-os。',
          ],
          unix: [
            '若从源码运行：在 services/backend 下执行 npm install 补齐依赖。',
          ],
        },
      };
    },
  },
  {
    id: 'native-abi-mismatch',
    match: (ctx) => ctx.code === 'ERR_DLOPEN_FAILED'
      || /\.node['"]?\b|shared library|invalid ELF|was compiled against a different Node/i.test(ctx.message),
    build: () => ({
      cause: '原生模块与当前 Node/平台 ABI 不匹配（如 better-sqlite3 跨平台复制而未针对本机重建）。',
      fixes: {
        common: [
          '在后端目录重建原生模块：npm rebuild better-sqlite3（或删掉 node_modules 后重跑 khy 让首启重装）。',
          '确认 Node 版本 ≥ 20 且与安装时一致（khy 首启会落便携 Node，勿混用旧全局 Node）。',
        ],
        win32: [],
        unix: [],
      },
    }),
  },
];

/** 断言一条修法不含危险动作（内部自检，规则表天然应干净）。 */
function _fixIsSafe(fix) {
  const s = String(fix || '').toLowerCase();
  return !_DANGER_TOKENS.some((t) => s.includes(t.toLowerCase()));
}

/** 把 { cause, fixes } + 平台渲染成追加到裸 stack 之后的可读块。 */
function _render(built, platform) {
  const lines = ['', `  真实原因：${built.cause}`, '  解决方法：'];
  const branch = platform === 'win32' ? built.fixes.win32 : built.fixes.unix;
  const steps = [...(built.fixes.common || []), ...(branch || [])];
  let n = 1;
  for (const step of steps) {
    lines.push(`    ${n}. ${step}`);
    n += 1;
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * 把首启崩溃的 err 归因为「真实原因 + 解决方法」文本块，供 _emitFatal 追加。
 * 纯计算、绝不抛。门关 / 无法归因 → 返回 null（_emitFatal 逐字节回退今日裸 stack）。
 *
 * @param {*} err       崩溃现场的错误（形态不可信，恶意 getter 也安全）
 * @param {string} platform process.platform（'win32' | 'linux' | 'darwin' | ...）
 * @param {object} env   环境变量（门控用）
 * @returns {string|null} 追加块（以 '\n' 开头），或 null
 */
function explainStartupFailure(err, platform = process.platform, env = process.env) {
  try {
    if (!isEnabled(env)) return null;
    if (!err || (typeof err !== 'object' && typeof err !== 'function')) return null;
    const code = _safeStr(() => err.code);
    const message = _safeStr(() => err.message) || _safeStr(() => err.stack);
    const ctx = {
      code,
      message,
      missingModule: _missingModuleName(message),
      platform: String(platform || ''),
    };
    for (const c of _CLASSIFIERS) {
      let hit = false;
      try {
        hit = c.match(ctx) === true;
      } catch {
        hit = false; // 谓词自身出错绝不冒泡
      }
      if (!hit) continue;
      const built = c.build(ctx);
      // 自检：任何一条修法含危险动作则放弃（保守回退 null，绝不吐危险建议）。
      const allFixes = [
        ...(built.fixes.common || []),
        ...(built.fixes.win32 || []),
        ...(built.fixes.unix || []),
      ];
      if (!allFixes.every(_fixIsSafe)) return null;
      return _render(built, ctx.platform);
    }
    return null; // 未识别 → 逐字节回退今日裸 stack
  } catch {
    return null; // 任何异常 → 安全回退，绝不加重致命路径
  }
}

module.exports = {
  explainStartupFailure,
  isEnabled,
  _missingModuleName,
  _fixIsSafe,
  _CLASSIFIERS,
  _FALSY,
  _DANGER_TOKENS,
};
