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
 * 2026-09-21 补第三种形态「**空心包**（hollow）**：ESM import 命中的路径里**目录在、
 * 内容空**。pnpm 风格布局把 `node_modules/<pkg>` 做成指向
 * `node_modules/.pnpm/<pkg>@<ver>/...` 的符号链接，安装被中断会留下「链接建了、
 * 内容没解包」的空实体；`fs.existsSync` 跟随符号链接故报「在」，bootstrap 的
 * 存在性判据因此跳过 npm install —— 于是**永不自愈**。CJS require 靠向上回退侥幸
 * 能跑，ESM import() 不回退，直接 ERR_MODULE_NOT_FOUND（TUI 的 `ink` 就这样炸）。
 * 故归因不能只说「未装齐 / 跑 npm install」——那对空壳无效。判据：ESM 崩溃文案里
 * 的命中路径若**不含 `build/`**（`.../node_modules/ink/index.js` 这种=按包根解析、
 * 目录为空才会走到 legacyMainResolve），即空心形态，改指向「删掉这些链接」。
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
  'git commit',
  'git push',
  'rm -rf /',
  'rm -r /',
  'curl ',
  'wget ',
  'npm publish',
  'twine',
  'sudo rm',
  '> /dev',
  'mkfs',
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

/**
 * 从崩溃文案里提取缺失依赖名；提不出返回 ''。
 * 两种方言都要认：
 *   CJS require → `Cannot find module 'ink'`（裸说明符）
 *   ESM import  → `Cannot find package 'D:…\node_modules\ink\index.js'`（**命中路径**，非包名）
 * 故对后者还要把路径归约成包名，否则归因句里会打印一整条绝对路径。
 */
function _missingModuleName(message) {
  const m = /Cannot find (?:module|package) ['"]([^'"]+)['"]/.exec(String(message || ''));
  return m ? _packageNameFromSpec(m[1]) : '';
}

/** 裸说明符原样返回；node_modules 内的路径归约为包名（scoped 保留 @scope/name）。 */
function _packageNameFromSpec(spec) {
  const s = String(spec || '');
  const marker = 'node_modules';
  const i = s.lastIndexOf(marker);
  if (i === -1) {
    return s;
  }
  const parts = s
    .slice(i + marker.length)
    .split(/[\\/]+/)
    .filter(Boolean);
  if (parts.length === 0) {
    return s;
  }
  if (parts[0].startsWith('@') && parts[1]) {
    return `${parts[0]}/${parts[1]}`;
  }
  return parts[0];
}

/** 取崩溃文案里 `node_modules` 之后的那段**命中路径**（诊断「空壳 vs 真缺」用），无则 ''。 */
function _specPathTail(message) {
  const m = /Cannot find (?:module|package) ['"]([^'"]+)['"]/.exec(String(message || ''));
  if (!m) return '';
  const s = m[1];
  const marker = 'node_modules';
  const i = s.lastIndexOf(marker);
  return i === -1 ? '' : s.slice(i + marker.length).replace(/^[\\/]+/, '');
}

/**
 * 命中的是不是「空心包」形态？
 *
 * ESM 解析到 `node_modules/<pkg>/<sub>` 时，若 `<sub>` 不存在会**回退到包根**再按
 * `exports`/`main` 解析；对空目录这一步会抛
 * `Cannot find package '.../node_modules/ink/index.js'`（后缀是**包根推断出的 main**
 * 候选，不是包内真实文件）。反过来，路径里出现真实子目录（如 `build/`）说明包体
 * 存在、只是该文件缺失 —— 那时报「空壳」是错的。
 *
 * 判据：命中路径 `node_modules` 之后只有 `<pkg>` 或 `@scope/<pkg>` 这一段（+ 一个无目录
 * 层级的推断文件名）⇒ 空心。这是纯文本推断，无需 IO（本文件是纯叶子，绝不做 IO）。
 */
function _looksHollow(message) {
  const tail = _specPathTail(message);
  if (!tail) return false;
  const parts = tail.split(/[\\/]+/).filter(Boolean);
  // 去掉 scoped 的 @scope 段
  let idx = 0;
  if (parts[0] && parts[0].startsWith('@')) idx = 1;
  const pkg = parts[idx];
  const rest = parts.slice(idx + 1);
  if (!pkg) return false;
  // rest 为空（找不到包根）或只有一个文件名（推断的 main）⇒ 包内没有任何真实目录层级
  return rest.length <= 1;
}

// 归因规则表：顺序即匹配优先级。每条 build(ctx) 返回 { cause, fixes:{common,win32,unix} }。
// ctx = { code, message, missingModule, platform }。
const _CLASSIFIERS = [
  {
    id: 'hollow-package',
    // 必须排在 module-not-found **之前**：两者 match 同一批文案，但空壳的修法
    // 与「真缺」不同（重装 vs 补装），靠顺序实现「更具体的先赢」。
    // 判据见 _looksHollow：ESM 命中路径 `node_modules` 之后没有任何真实目录层级。
    match: (ctx) =>
      (ctx.code === 'MODULE_NOT_FOUND' ||
        ctx.code === 'ERR_MODULE_NOT_FOUND' ||
        /Cannot find (?:module|package) ['"]/.test(ctx.message)) &&
      _looksHollow(ctx.message),
    build: (ctx) => {
      const named = ctx.missingModule ? ` '${ctx.missingModule}'` : '';
      return {
        cause: `依赖${named} 是「空心」的——包目录在（所以存在性检查全说好），但里面是空的：上一次安装建了符号链接、还没来得及解包就被中断/清掉。CJS require 靠向上回退侥幸能跑，ESM import 不回退，于是这里直接崩。marker 已写下 ⇒ 重装被短路 ⇒ 不自愈。`,
        fixes: {
          common: [
            '删掉后端 node_modules 里指向空实体的符号链接（它们的目标目录是空的），再重跑一次 khy——bootstrap 的空壳判据会发现内容缺失并重新 npm install。',
            '或一次性全量重装：删除后端目录下的 .khy_quant_bootstrapped 与 node_modules 后重跑 khy。',
            '急着恢复：只删这批坏链接即可让模块解析回退到上层完好的 node_modules，无需下载任何东西。',
          ],
          win32: [
            '若链接删不掉（文件占用）：先 khy stop 释放占用再删；仍失败则删整个后端 node_modules 后重跑 khy。',
            '若从源码树运行：在 services/backend 下先 npm install，再重跑 khy。',
          ],
          unix: ['若从源码运行：在 services/backend 下先 npm install，再重跑 khy。'],
        },
      };
    },
  },
  {
    id: 'module-not-found',
    // 两种崩溃方言：CJS require 抛 MODULE_NOT_FOUND，ESM import 抛 ERR_MODULE_NOT_FOUND
    // （文案亦是 Cannot find **package**）。只认前者的话，TUI 的 `import('ink')` 失败
    // 就落到「未识别 → 裸 stack」，见 tui-ux-audit-20260919/AB。
    match: (ctx) =>
      ctx.code === 'MODULE_NOT_FOUND' ||
      ctx.code === 'ERR_MODULE_NOT_FOUND' ||
      /Cannot find (?:module|package) ['"]/.test(ctx.message),
    build: (ctx) => {
      const named = ctx.missingModule ? `（缺少依赖 '${ctx.missingModule}'）` : '';
      return {
        cause: `后端运行时依赖未装齐${named}——首启联网 hydrate 未完成、被中断，或 node_modules 半装/被清。`,
        fixes: {
          common: [
            '联网后重跑一次 khy（或 khy doctor）触发首启 hydrate，会自动在后端目录补装依赖。',
            '若仍缺：删除后端目录下的 .khy_quant_bootstrapped 与 package-lock.json 后重跑 khy 全量重装。',
          ],
          win32: [
            'Windows 若上次升级被文件占用中断：先 khy stop 释放占用，再 pip install --force-reinstall --no-cache-dir khy-os。',
            '若从源码树运行：在 services/backend 下执行 npm install 补齐依赖，再重跑 khy。',
          ],
          unix: ['若从源码运行：在 services/backend 下执行 npm install 补齐依赖。'],
        },
      };
    },
  },
  {
    id: 'native-abi-mismatch',
    match: (ctx) =>
      ctx.code === 'ERR_DLOPEN_FAILED' ||
      /\.node['"]?\b|shared library|invalid ELF|was compiled against a different Node/i.test(
        ctx.message
      ),
    build: () => ({
      cause:
        '原生模块与当前 Node/平台 ABI 不匹配（如 better-sqlite3 跨平台复制而未针对本机重建）。',
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
    if (!isEnabled(env)) {
      return null;
    }
    if (!err || (typeof err !== 'object' && typeof err !== 'function')) {
      return null;
    }
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
      if (!hit) {
        continue;
      }
      const built = c.build(ctx);
      // 自检：任何一条修法含危险动作则放弃（保守回退 null，绝不吐危险建议）。
      const allFixes = [
        ...(built.fixes.common || []),
        ...(built.fixes.win32 || []),
        ...(built.fixes.unix || []),
      ];
      if (!allFixes.every(_fixIsSafe)) {
        return null;
      }
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
  _packageNameFromSpec,
  _specPathTail,
  _looksHollow,
  _fixIsSafe,
  _CLASSIFIERS,
  _FALSY,
  _DANGER_TOKENS,
};
