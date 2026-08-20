'use strict';

/**
 * @pattern Specification, Strategy
 *
 * dependencyClosure.js — 「代码能 require 的东西，必须在某份 manifest 里有名字」
 * 的判定层（纯叶子：零 IO、确定性、绝不抛、可单测）。
 *
 * ── 为什么这条线值得有一道门 ────────────────────────────────────────────────
 * 发布产物是**一个 esbuild bundle**，不是一棵 node_modules。`packaging/npm/package.json`
 * 声明零依赖，真正决定「装什么」的是 `packaging/build/esbuild-modules.js`：除了 Node
 * 内置和三个原生可选模块，其余全部内联进 bundle。
 *
 * 这带来一个很难自己冒出来的失败模式：一个包**没被任何 manifest 声明**，却因为
 * workspace 提升恰好躺在根 node_modules 里，于是本机能 require、bundle 也打得进去，
 * 一切正常 —— 直到某天别人删掉一个八竿子打不着的 devDependency，那个包的提升位置
 * 变了或整棵子树消失，发布产物当场少一块。实测踩过：`javascript-obfuscator`（一个
 * 零调用点的 devDependency）经 `@vercel/blob` 把根 undici 钉在 ^6，第一方代码的
 * `require('undici')` 于是静默绑到 6.28.0，而 cheerio 自带的 7.x 嵌在下一层。
 *
 * 所以判定的口径是**声明闭包**而不是「能不能装上」：
 *   - 硬依赖（顶层静态 require）→ dependencies；
 *   - try/catch 或 env 门控的可选模块 → optional peer（**不是** optionalDependencies：
 *     后者会让每次安装都真去尝试，原生模块还要编译一次）；
 *   - 只有测试用的 → devDependencies。
 * 三者都算「有名字」，本文件不区分——区分是人的判断，门禁只保证不出现「无名氏」。
 *
 * ── 刻意不做的事 ────────────────────────────────────────────────────────────
 * 不判「声明了但没人用」。多余的声明只是几行 JSON，而误删一条被动态路径引用的依赖
 * 是线上事故；这道门只往「补声明」一个方向推，不往「删声明」推。
 *
 * 同理不判版本范围是否最优、不判该放 dependencies 还是 peer —— 那些需要读懂调用点
 * 的语义，机器判错的代价远大于收益。
 *
 * ── specifier 必须来自 AST，不能来自 grep ──────────────────────────────────
 * 本文件收的是**已经解析出来的 specifier 列表**。这不是洁癖：同一份扫描用正则跑出
 * 42 个「未声明包」，其中 38 个是模板字符串里的散文和脚手架模板里的示例代码；用
 * @babel/parser 跑出 4 个，全部是真的。带着 38 条噪音的门禁，第二天就会被人加进
 * 忽略名单里，然后那 4 条真的也一起被忽略。AST 解析在 scripts/ci 侧做。
 *
 * env 门控 KHY_DEPENDENCY_CLOSURE（默认开，仅显式 0/false/off/no 关闭）。
 */

const OFF = new Set(['0', 'false', 'off', 'no']);

/** 门控判定。纯字符串运算。 */
function isEnabled(env) {
  const v = (env || process.env || {}).KHY_DEPENDENCY_CLOSURE;
  return !(v !== undefined && OFF.has(String(v).trim().toLowerCase()));
}

/** manifest 里算「声明过」的四个字段。顺序即报错时的展示顺序。 */
const DECLARING_FIELDS = Object.freeze([
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
]);

/**
 * 从 specifier 取包名：`@scope/pkg/sub/path` → `@scope/pkg`，`pkg/sub` → `pkg`。
 *
 * 作用域包必须取前两段——`mysql2/promise` 的包名是 `mysql2`，而 `@khy/shared/utils`
 * 的包名是 `@khy/shared` 而不是 `@khy`。少写这一条会让所有作用域包都判成未声明。
 */
function packageNameOf(specifier) {
  const s = String(specifier == null ? '' : specifier);
  if (!s) return '';
  const parts = s.split('/');
  if (s.charAt(0) === '@') return parts.slice(0, 2).join('/');
  return parts[0];
}

/**
 * 这个 specifier 需不需要一份声明。
 *
 * 相对路径、绝对路径、`node:` 前缀和 Node 内置一律不需要。剩下的都是「从
 * node_modules 解析」的裸包名，必须有名字。
 *
 * @param {string} specifier
 * @param {{builtins?: Set<string>|Array<string>}} [ctx]
 * @returns {boolean}
 */
function needsDeclaration(specifier, ctx = {}) {
  const s = String(specifier == null ? '' : specifier);
  if (!s) return false;
  if (s.charAt(0) === '.') return false;
  if (s.charAt(0) === '/') return false;
  if (s.indexOf('node:') === 0) return false;
  // Windows 绝对路径（`C:\...`）。第一方代码不该有，但动态生成的 specifier 可能带进来。
  if (/^[A-Za-z]:[\\/]/.test(s)) return false;
  const builtins = ctx.builtins instanceof Set ? ctx.builtins : new Set(ctx.builtins || []);
  return !builtins.has(packageNameOf(s));
}

/**
 * 把一份 manifest 摊成「声明过的包名 → 出现在哪些字段」。
 *
 * @param {object} manifest
 * @returns {Map<string, string[]>}
 */
function declaredNames(manifest) {
  const out = new Map();
  const mf = manifest && typeof manifest === 'object' ? manifest : {};
  for (const field of DECLARING_FIELDS) {
    const block = mf[field];
    if (!block || typeof block !== 'object') continue;
    for (const name of Object.keys(block)) {
      const seen = out.get(name);
      if (seen) seen.push(field);
      else out.set(name, [field]);
    }
  }
  return out;
}

/**
 * 判定一个包对某个 manifest 是不是「无名氏」。
 *
 * workspace 内部包（`@khy/shared` 这类）算已声明：它们由 workspace 链接解析，
 * 不经 registry，逼每个消费方再写一条 `"@khy/shared": "*"` 只是噪音。
 *
 * @returns {null|{name: string, why: string}} null 表示合规
 */
function classifySpecifier(specifier, ctx = {}) {
  if (!needsDeclaration(specifier, ctx)) return null;
  const name = packageNameOf(specifier);
  const declared = ctx.declared instanceof Set ? ctx.declared : new Set(ctx.declared || []);
  if (declared.has(name)) return null;
  const workspace = ctx.workspaceNames instanceof Set
    ? ctx.workspaceNames
    : new Set(ctx.workspaceNames || []);
  if (workspace.has(name)) return null;
  return {
    name,
    why: '被第一方代码 require，但不在本包 manifest 的 dependencies / devDependencies / '
      + 'optionalDependencies / peerDependencies 里；现在能解析到纯属 workspace 提升的巧合',
  };
}

/**
 * 全量判定。
 *
 * @param {object} facts
 * @param {Array<{pkg: string, declared: Array<string>, imports: Array<{file: string,
 *   specifier: string}>}>} facts.packages 每个 workspace 包一条
 * @param {Array<string>} [facts.workspaceNames] workspace 内部包名
 * @param {Array<string>} [facts.builtins] Node 内置模块名
 * @param {Array<{name: string, versions: Array<string>, bytes: number}>} [facts.bundledDuplicates]
 *   来自 esbuild metafile 的「同一个包在 bundle 里被内联了多份」。可缺省。
 * @param {number} [facts.duplicateBaseline] 允许的重复条数上限（棘轮，只降不升）
 * @param {object} [env]
 * @returns {{disabled: boolean, undeclared: Array<object>, duplicates: Array<object>,
 *            duplicateBaseline: number|null, scanned: number, packages: number}}
 */
function inspect(facts, env) {
  if (!isEnabled(env)) {
    return {
      disabled: true,
      undeclared: [],
      duplicates: [],
      duplicateBaseline: null,
      scanned: 0,
      packages: 0,
    };
  }
  const f = facts && typeof facts === 'object' ? facts : {};
  const workspaceNames = new Set(Array.isArray(f.workspaceNames) ? f.workspaceNames : []);
  const builtins = new Set(Array.isArray(f.builtins) ? f.builtins : []);
  const pkgs = Array.isArray(f.packages) ? f.packages : [];

  const undeclared = [];
  let scanned = 0;
  for (const entry of pkgs) {
    if (!entry || typeof entry !== 'object') continue;
    const pkg = String(entry.pkg || '');
    const declared = new Set(Array.isArray(entry.declared) ? entry.declared : []);
    const imports = Array.isArray(entry.imports) ? entry.imports : [];
    // 同一个包名在同一个 workspace 包里只报一条，但把调用点都带上——
    // 只报一个文件会让人补完那处就以为修完了。
    const byName = new Map();
    for (const imp of imports) {
      if (!imp || typeof imp !== 'object') continue;
      scanned++;
      const hit = classifySpecifier(imp.specifier, { declared, workspaceNames, builtins });
      if (!hit) continue;
      const file = String(imp.file || '');
      const seen = byName.get(hit.name);
      if (seen) {
        if (seen.files.indexOf(file) === -1) seen.files.push(file);
      } else {
        byName.set(hit.name, { pkg, name: hit.name, why: hit.why, files: file ? [file] : [] });
      }
    }
    for (const v of byName.values()) undeclared.push(v);
  }
  undeclared.sort((a, b) => (a.pkg + '\u0000' + a.name < b.pkg + '\u0000' + b.name ? -1 : 1));

  const duplicates = (Array.isArray(f.bundledDuplicates) ? f.bundledDuplicates : [])
    .filter((d) => d && typeof d === 'object' && d.name)
    .map((d) => ({
      name: String(d.name),
      versions: Array.isArray(d.versions) ? d.versions.slice() : [],
      bytes: Number.isFinite(Number(d.bytes)) ? Number(d.bytes) : 0,
    }))
    .sort((a, b) => b.bytes - a.bytes);

  const baseline = Number.isFinite(Number(f.duplicateBaseline))
    ? Number(f.duplicateBaseline)
    : null;

  return {
    disabled: false,
    undeclared,
    duplicates,
    duplicateBaseline: baseline,
    scanned,
    packages: pkgs.length,
  };
}

/**
 * 重复内联是否越过棘轮。
 *
 * **基线缺失一律按 0 处理**，不是按「无限制」。一个读不到基线就自动放行的门禁，
 * 在基线文件没进 git 的那次 fresh clone 上会安静地全绿——而那正是最需要它出声的
 * 时候。宁可红，也不要假绿。
 */
function exceedsDuplicateBaseline(result) {
  if (!result || result.disabled) return false;
  const baseline = Number.isFinite(Number(result.duplicateBaseline))
    ? Number(result.duplicateBaseline)
    : 0;
  return (result.duplicates || []).length > baseline;
}

function _fmtKB(bytes) {
  return (Number(bytes) / 1024).toFixed(1) + ' KB';
}

/** 人读渲染。报错必须把「哪个包 / 哪个 workspace / 哪个文件」三样都说全。 */
function render(result) {
  if (!result || result.disabled) {
    return 'dependency-closure: disabled (KHY_DEPENDENCY_CLOSURE)';
  }
  const lines = [];
  const undeclared = result.undeclared || [];
  if (undeclared.length === 0) {
    lines.push(
      `dependency-closure: 声明闭包完整（${result.packages} 个 workspace 包，`
      + `${result.scanned} 处裸包引用）。`
    );
  } else {
    lines.push(`dependency-closure: ${undeclared.length} 个包被 require 但没有声明。`);
    for (const v of undeclared) {
      lines.push(`  [error] ${v.pkg} → ${v.name}`);
      lines.push(`      ${v.why}`);
      for (const f of v.files.slice(0, 3)) lines.push(`      ${f}`);
      if (v.files.length > 3) lines.push(`      …另 ${v.files.length - 3} 处`);
    }
    lines.push('  修法：顶层静态 require 进 dependencies；try/catch 或 env 门控的进');
    lines.push('  peerDependencies + peerDependenciesMeta.optional；只有测试用的进 devDependencies。');
  }

  const dups = result.duplicates || [];
  const baseline = Number.isFinite(Number(result.duplicateBaseline))
    ? Number(result.duplicateBaseline)
    : 0;
  if (dups.length > 0) {
    const verdict = dups.length > baseline ? 'error' : 'ok';
    const waste = dups.reduce((n, d) => n + d.bytes, 0);
    lines.push(
      `  [${verdict}] bundle 内重复内联 ${dups.length} 个包（基线 ${baseline}），`
      + `合计 ${_fmtKB(waste)}。`
    );
    for (const d of dups.slice(0, 8)) {
      lines.push(`      ${d.name} ${d.versions.join(' / ')}  ${_fmtKB(d.bytes)}`);
    }
    if (dups.length > 8) lines.push(`      …另 ${dups.length - 8} 个`);
  }
  return lines.join('\n');
}

module.exports = {
  isEnabled,
  packageNameOf,
  needsDeclaration,
  declaredNames,
  classifySpecifier,
  inspect,
  exceedsDuplicateBaseline,
  render,
  DECLARING_FIELDS,
};
