'use strict';

/**
 * projectMetadataService — 项目可维护性元数据生成器（"种子文档"）
 *
 * 目标（来自用户 /goal）：凡是 khy 生成的项目都必须自带可维护性元数据，
 * 即便将来没有 AI（"万一 claude 那天用不了了"），人类或低算力模型也能据此
 * 快速理解并维护项目。
 *
 * 产物（写入项目根 `.ai/`）：
 *   - MAP.md       骨架与导航：目录职责、入口点、技术栈、构建/运行命令、目录树
 *   - CONTEXT.yaml 调用契约/数据契约：栈、入口、依赖、构建命令、逐文件符号清单
 *   - GUARDS.md    红线与"无 AI 维护"指南：探测到的事实 + 通用维护红线 + 待人工补全占位
 *
 * 设计原则（与 /learn 三模式 RAG 同构：确定性地板 + 可选模型增强）：
 *   - 确定性地板：完全不依赖任何模型/网络即可生成（这是"必须有"的硬保证）。
 *   - 可选模型增强：通过 opts.enhance 注入语义润色，仅在显式启用且模型可用时生效，
 *     失败静默降级回确定性产物，绝不阻塞。
 *   - Bounded：扫描深度/文件数/符号文件数全部 env 可调并有上限，绝不挂死调用流。
 *   - Idempotent：若 `.ai/MAP.md` 已存在则跳过（保护手写文档，如本仓库 kernel 种子文档）。
 *   - Fail-soft：任何异常都被吞掉并以结构化结果返回，不抛错打断生成它的任务。
 *   - 零硬编码：所有阈值走 env，无业务字面量写死。
 *
 * 纯 Node stdlib（fs/path），无第三方依赖，便于在任何 khy 派生环境运行。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const metadataPointers = require('./metadataPointers');

// 文档模板版本：模板渲染逻辑变化时 +1，使旧产物判定为 stale 并被刷新。
// /3：符号文件改公平桶配额 + 指纹并入全量源树（path|size），覆盖大型 monorepo。
// /4：详略得当——MAP/SKELETON 的「符号速览」降为导航 teaser（按详略档位裁剪、引导到
//     CONTEXT.yaml 看完整清单），CONTEXT.yaml 仍完整；树的二级目录/根文件数改档位驱动。
const TOOL_VERSION = 'khy-metadata/4';
// 机器自有标记：带此标记的 .ai 文档可被 refresh 安全覆盖；无标记 = 人工撰写，绝不覆盖。
const AUTO_MARKER = 'khy-metadata:auto';
// 机器自有层文件名（当主文档为人工撰写时，把可机械推导的部分落到这里，永远可覆盖）。
const SKELETON_AUTO = 'SKELETON.auto.md';
const METAHASH_FILE = '.metahash.json';

// ── 可调上限（全部 env 可覆盖，含安全默认） ──
function _intEnv(name, def, min, max) {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw)) return def;
  let v = Math.floor(raw);
  if (Number.isFinite(min)) v = Math.max(min, v);
  if (Number.isFinite(max)) v = Math.min(max, v);
  return v;
}
function _boolEnv(name, def) {
  const raw = String(process.env[name] ?? '').trim().toLowerCase();
  if (raw === '') return def;
  return !['0', 'false', 'off', 'no'].includes(raw);
}

const LIMITS = () => ({
  // monorepo 友好默认：扫描天花板需足够高，否则 BFS 在抵达深层模块（platform/、
  // software/）前就被 maxFiles 截断，那些模块的变更将对指纹完全不可见。
  maxDepth: _intEnv('KHY_META_MAX_DEPTH', 6, 1, 12),
  maxFiles: _intEnv('KHY_META_MAX_FILES', 4000, 10, 20000),
  maxSymbolFiles: _intEnv('KHY_META_MAX_SYMBOL_FILES', 120, 1, 800),
  maxSymbolsPerFile: _intEnv('KHY_META_MAX_SYMBOLS_PER_FILE', 30, 1, 200),
  maxFileBytes: _intEnv('KHY_META_MAX_FILE_BYTES', 256 * 1024, 1024, 8 * 1024 * 1024),
  maxTreeEntries: _intEnv('KHY_META_MAX_TREE_ENTRIES', 200, 10, 2000),
  // 详略得当：MAP.md / SKELETON.auto.md 是给「人」看的导航速览（宜简），按详略档位
  // 裁剪「关键文件符号速览」teaser 与目录树密度；CONTEXT.yaml 是给「机器」读的完整
  // 契约（宜全），不受这些 cap 约束。单项仍可显式 env 覆盖（零硬编码），覆盖优先于档位。
  mapSymbolFiles: _intEnv('KHY_META_MAP_SYMBOL_FILES', _detailProfile().mapSymbolFiles, 1, 800),
  mapSymbolsPerFile: _intEnv('KHY_META_MAP_SYMBOLS_PER_FILE', _detailProfile().mapSymbolsPerFile, 1, 200),
  treeSubDirs: _intEnv('KHY_META_TREE_SUBDIRS', _detailProfile().treeSubDirs, 1, 200),
  treeRootFiles: _intEnv('KHY_META_TREE_ROOT_FILES', _detailProfile().treeRootFiles, 1, 400),
});

// ── 详略档位（KHY_META_DETAIL=brief|standard|full，默认 standard） ──
// 同一份扫描数据按用途分级渲染：人看的导航速览裁剪到「够定位即止」，机器读的契约保持
// 完整。档位只调人看的两份文档的渲染密度，绝不削减 CONTEXT.yaml 的符号清单；也不参与
// 指纹（见 _computeFingerprint），故纯密度变化不制造 git 噪音或幂等漂移。
const DETAIL_PROFILES = {
  brief: { mapSymbolFiles: 24, mapSymbolsPerFile: 6, treeSubDirs: 8, treeRootFiles: 12 },
  standard: { mapSymbolFiles: 48, mapSymbolsPerFile: 10, treeSubDirs: 12, treeRootFiles: 20 },
  full: { mapSymbolFiles: 800, mapSymbolsPerFile: 200, treeSubDirs: 24, treeRootFiles: 48 },
};
function _detailProfile() {
  const raw = String(process.env.KHY_META_DETAIL ?? '').trim().toLowerCase();
  return DETAIL_PROFILES[raw] || DETAIL_PROFILES.standard;
}

// 扫描时跳过的目录（生成物 / 依赖 / VCS / 我们自己的输出）。
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', 'target',
  '.next', '.nuxt', '.cache', 'coverage', '.venv', 'venv', '__pycache__',
  '.idea', '.vscode', '.ai', 'vendor', '.pytest_cache', '.mypy_cache',
  'bin', 'obj', '.gradle', '.terraform', 'tmp', '.tox', 'site-packages',
]);

// 视为源码、参与符号抽取的扩展名 → 语言标签。
const SOURCE_LANG = {
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.ts': 'typescript', '.tsx': 'typescript', '.jsx': 'javascript',
  '.py': 'python', '.go': 'go', '.rs': 'rust', '.java': 'java',
  '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.cc': 'cpp', '.hpp': 'cpp',
  '.rb': 'ruby', '.php': 'php', '.cs': 'csharp', '.kt': 'kotlin',
  '.swift': 'swift', '.vue': 'vue', '.mbt': 'moonbit', '.sh': 'shell',
};

// ── 安全读文件（有界、永不抛） ──
function _safeRead(abs, maxBytes) {
  try {
    const st = fs.statSync(abs);
    if (!st.isFile() || st.size > maxBytes) return '';
    return fs.readFileSync(abs, 'utf8');
  } catch {
    return '';
  }
}
function _safeJson(abs, maxBytes) {
  const txt = _safeRead(abs, maxBytes);
  if (!txt) return null;
  try { return JSON.parse(txt); } catch { return null; }
}

// ── 目录扫描（BFS，深度/数量双上限，跳过 SKIP_DIRS） ──
function _scanTree(root, limits) {
  const files = [];     // { rel, abs, ext, size }
  const dirs = [];      // rel dir paths (depth>=1)
  const queue = [{ abs: root, rel: '', depth: 0 }];
  let visited = 0;
  while (queue.length && files.length < limits.maxFiles) {
    const cur = queue.shift();
    let entries;
    try {
      entries = fs.readdirSync(cur.abs, { withFileTypes: true });
    } catch {
      continue;
    }
    // 目录内稳定排序：目录在前、再按名字，保证产物可复现（无时间/随机依赖）。
    entries.sort((a, b) => {
      const ad = a.isDirectory() ? 0 : 1;
      const bd = b.isDirectory() ? 0 : 1;
      if (ad !== bd) return ad - bd;
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });
    for (const ent of entries) {
      if (ent.name.startsWith('.') && ent.name !== '.env' && !ent.name.startsWith('.env')) {
        // 跳过隐藏文件/目录，但保留 .env* 这类配置线索。
        if (ent.isDirectory()) continue;
      }
      const childRel = cur.rel ? `${cur.rel}/${ent.name}` : ent.name;
      const childAbs = path.join(cur.abs, ent.name);
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) continue;
        if (cur.depth + 1 <= limits.maxDepth) {
          dirs.push(childRel);
          queue.push({ abs: childAbs, rel: childRel, depth: cur.depth + 1 });
        }
      } else if (ent.isFile()) {
        if (++visited > limits.maxFiles * 4) break; // 防御性硬上限
        let size = 0;
        try { size = fs.statSync(childAbs).size; } catch { /* ignore */ }
        files.push({
          rel: childRel,
          abs: childAbs,
          ext: path.extname(ent.name).toLowerCase(),
          size,
        });
        if (files.length >= limits.maxFiles) break;
      }
    }
  }
  return { files, dirs };
}

// ── npm workspace 成员目录解析（确定性、有界、仅展开末段 glob） ──
// 单仓多包时根 package.json 通常是 private 且无 main/bin，真正的入口都在成员包里。
// 这里把 `workspaces` 里的字面路径与 `parent/<prefix>*` 形式的浅 glob 解析成含
// package.json 的成员目录列表，供 _detectStack 汇总入口点与测试命令。
function _resolveWorkspaceDirs(root, workspaces) {
  const patterns = Array.isArray(workspaces)
    ? workspaces
    : (workspaces && Array.isArray(workspaces.packages) ? workspaces.packages : []);
  const dirs = [];
  for (const pat of patterns) {
    if (typeof pat !== 'string' || !pat) continue;
    if (!pat.includes('*')) {
      if (fs.existsSync(path.join(root, pat, 'package.json'))) dirs.push(pat);
      continue;
    }
    // 仅支持末段 glob（npm 常见形态，如 `platform/packages/khy-*`）。
    const lastSlash = pat.lastIndexOf('/');
    const parent = lastSlash >= 0 ? pat.slice(0, lastSlash) : '';
    const lastSeg = lastSlash >= 0 ? pat.slice(lastSlash + 1) : pat;
    if (!lastSeg.includes('*')) continue; // glob 在非末段：不展开（保持确定性）
    const segPrefix = lastSeg.slice(0, lastSeg.indexOf('*'));
    let entries;
    try {
      entries = fs.readdirSync(path.join(root, parent), { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      if (segPrefix && !ent.name.startsWith(segPrefix)) continue;
      const memberRel = parent ? `${parent}/${ent.name}` : ent.name;
      if (fs.existsSync(path.join(root, memberRel, 'package.json'))) dirs.push(memberRel);
    }
  }
  return [...new Set(dirs)];
}

// ── 从 pyproject `[project.scripts]` 推断 Python 入口文件（确定性） ──
// `name = "module.path:func"` → 把 module.path 映射回树内真实文件，解决「pip 启动器
// 入口不在仓库根」导致的「核心入口点未识别」。找不到对应文件时回落为约定路径。
function _pythonEntriesFromPyproject(root, files, limits) {
  const out = [];
  const txt = _safeRead(path.join(root, 'pyproject.toml'), limits.maxFileBytes);
  if (!txt) return out;
  const block = txt.match(/\[project\.scripts\]([\s\S]*?)(?:\n\[|\s*$)/);
  if (!block) return out;
  const seen = new Set();
  const lineRe = /^\s*[\w.-]+\s*=\s*["']([\w.]+):[\w.]+["']/gm;
  let m;
  while ((m = lineRe.exec(block[1])) !== null) {
    const asPath = m[1].replace(/\./g, '/'); // khy_platform.cli → khy_platform/cli
    const cand = `${asPath}.py`;
    const hit = files.find(f => f.rel === cand || f.rel.endsWith(`/${cand}`));
    const target = hit ? hit.rel : cand;
    if (seen.has(target)) continue;
    seen.add(target);
    out.push({ kind: 'python-entry', path: target, hint: 'pyproject scripts' });
    if (out.length >= 6) break;
  }
  return out;
}

// ── 技术栈/构建命令探测（基于 manifest，确定性） ──
function _detectStack(root, files, limits) {
  const has = (rel) => files.some(f => f.rel === rel) || fs.existsSync(path.join(root, rel));
  const stack = [];       // 语言/运行时标签
  const buildCmds = [];   // { label, cmd }
  const runCmds = [];
  const testCmds = [];
  const deps = [];        // 主要依赖名（有界）
  const entryPoints = []; // { kind, path, hint }

  // Node / JS
  if (has('package.json')) {
    stack.push('node');
    const pkg = _safeJson(path.join(root, 'package.json'), limits.maxFileBytes) || {};
    if (pkg.type === 'module') stack.push('esm');
    if (typeof pkg.main === 'string') entryPoints.push({ kind: 'node-main', path: pkg.main, hint: 'package.json#main' });
    if (pkg.bin && typeof pkg.bin === 'object') {
      for (const [name, p] of Object.entries(pkg.bin).slice(0, 8)) {
        entryPoints.push({ kind: 'cli-bin', path: String(p), hint: `bin:${name}` });
      }
    } else if (typeof pkg.bin === 'string') {
      entryPoints.push({ kind: 'cli-bin', path: pkg.bin, hint: 'bin' });
    }
    const scripts = pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
    if (scripts.build) buildCmds.push({ label: 'build', cmd: 'npm run build' });
    if (scripts.start) runCmds.push({ label: 'start', cmd: 'npm start' });
    if (scripts.dev) runCmds.push({ label: 'dev', cmd: 'npm run dev' });
    if (scripts.test) testCmds.push({ label: 'test', cmd: 'npm test' });
    buildCmds.unshift({ label: 'install', cmd: 'npm install' });
    for (const d of Object.keys(pkg.dependencies || {}).slice(0, 20)) deps.push(d);
    if (pkg.engines && pkg.engines.node) stack.push(`node${pkg.engines.node}`);

    // npm workspaces：根包常 private 且无 main/bin，真入口在成员包里。
    // 汇总成员包的 main/bin 作为入口点，并在根无 test 时给出 workspaces 测试命令。
    if (pkg.workspaces) {
      const memberDirs = _resolveWorkspaceDirs(root, pkg.workspaces).slice(0, 16);
      if (memberDirs.length) stack.push('monorepo');
      let memberHasTest = false;
      // join a member dir with a manifest-relative path, stripping any leading "./"
      const memberPath = (dir, rel) => `${dir}/${String(rel).replace(/^\.\//, '')}`;
      for (const dir of memberDirs) {
        const mPkg = _safeJson(path.join(root, dir, 'package.json'), limits.maxFileBytes);
        if (!mPkg) continue;
        if (typeof mPkg.main === 'string') {
          entryPoints.push({ kind: 'node-main', path: memberPath(dir, mPkg.main), hint: `workspace:${mPkg.name || dir}#main` });
        }
        if (mPkg.bin && typeof mPkg.bin === 'object') {
          for (const [name, p] of Object.entries(mPkg.bin).slice(0, 4)) {
            entryPoints.push({ kind: 'cli-bin', path: memberPath(dir, p), hint: `workspace:${mPkg.name || dir} bin:${name}` });
          }
        } else if (typeof mPkg.bin === 'string') {
          entryPoints.push({ kind: 'cli-bin', path: memberPath(dir, mPkg.bin), hint: `workspace:${mPkg.name || dir} bin` });
        }
        const mScripts = mPkg.scripts && typeof mPkg.scripts === 'object' ? mPkg.scripts : {};
        if (mScripts.test) memberHasTest = true;
        for (const d of Object.keys(mPkg.dependencies || {}).slice(0, 6)) {
          if (deps.length < 40 && !deps.includes(d)) deps.push(d);
        }
      }
      if (memberHasTest && !scripts.test) {
        testCmds.push({ label: 'test', cmd: 'npm test --workspaces --if-present' });
      }
    }
  }

  // Python
  if (has('pyproject.toml') || has('requirements.txt') || has('setup.py') || has('setup.cfg')) {
    stack.push('python');
    if (has('requirements.txt')) buildCmds.push({ label: 'install', cmd: 'pip install -r requirements.txt' });
    else if (has('pyproject.toml')) buildCmds.push({ label: 'install', cmd: 'pip install -e .' });
    if (has('manage.py')) { stack.push('django'); runCmds.push({ label: 'serve', cmd: 'python manage.py runserver' }); }
    // pyproject `[project.scripts]` 入口优先（解决 pip 启动器入口不在仓库根）。
    if (has('pyproject.toml')) {
      for (const ep of _pythonEntriesFromPyproject(root, files, limits)) entryPoints.push(ep);
    }
    if (!entryPoints.some(e => e.kind === 'python-entry')) {
      for (const cand of ['main.py', 'app.py', 'src/main.py', 'src/app.py', '__main__.py']) {
        if (has(cand)) { entryPoints.push({ kind: 'python-entry', path: cand, hint: 'common entry' }); break; }
      }
    }
    // 仅在有实际证据时才声明 pytest，避免对无测试套件的项目硬塞命令。
    const pyprojectText = has('pyproject.toml') ? _safeRead(path.join(root, 'pyproject.toml'), limits.maxFileBytes) : '';
    const hasPytestEvidence =
      has('pytest.ini') || has('tox.ini') || has('conftest.py')
      || files.some(f => /(^|\/)(test_[^/]*\.py|[^/]*_test\.py)$/.test(f.rel))
      || /\[tool\.pytest/.test(pyprojectText)
      || /["']pytest[">'=\s]/.test(pyprojectText);
    if (hasPytestEvidence) testCmds.push({ label: 'test', cmd: 'pytest' });
  }

  // Rust
  if (has('Cargo.toml')) {
    stack.push('rust');
    buildCmds.push({ label: 'build', cmd: 'cargo build' });
    runCmds.push({ label: 'run', cmd: 'cargo run' });
    testCmds.push({ label: 'test', cmd: 'cargo test' });
    if (has('src/main.rs')) entryPoints.push({ kind: 'rust-bin', path: 'src/main.rs', hint: 'cargo bin' });
    if (has('src/lib.rs')) entryPoints.push({ kind: 'rust-lib', path: 'src/lib.rs', hint: 'cargo lib' });
  }

  // Go
  if (has('go.mod')) {
    stack.push('go');
    buildCmds.push({ label: 'build', cmd: 'go build ./...' });
    testCmds.push({ label: 'test', cmd: 'go test ./...' });
    if (has('main.go')) entryPoints.push({ kind: 'go-main', path: 'main.go', hint: 'package main' });
  }

  // Java / JVM
  if (has('pom.xml')) { stack.push('java', 'maven'); buildCmds.push({ label: 'build', cmd: 'mvn package' }); testCmds.push({ label: 'test', cmd: 'mvn test' }); }
  if (has('build.gradle') || has('build.gradle.kts')) { stack.push('java', 'gradle'); buildCmds.push({ label: 'build', cmd: './gradlew build' }); }

  // Native (C/C++)
  if (has('Makefile') || has('makefile')) { stack.push('make'); buildCmds.push({ label: 'build', cmd: 'make' }); }
  if (has('CMakeLists.txt')) { stack.push('cmake'); buildCmds.push({ label: 'configure', cmd: 'cmake -B build' }, { label: 'build', cmd: 'cmake --build build' }); }

  // Ruby / PHP / .NET
  if (has('Gemfile')) { stack.push('ruby'); buildCmds.push({ label: 'install', cmd: 'bundle install' }); }
  if (has('composer.json')) { stack.push('php'); buildCmds.push({ label: 'install', cmd: 'composer install' }); }
  const csproj = files.find(f => f.ext === '.csproj' || f.rel.endsWith('.sln'));
  if (csproj) { stack.push('dotnet'); buildCmds.push({ label: 'build', cmd: 'dotnet build' }); }

  // 容器
  if (has('Dockerfile')) stack.push('docker');
  if (has('docker-compose.yml') || has('docker-compose.yaml') || has('compose.yaml')) stack.push('docker-compose');

  // 配置 / env 文件线索
  const configFiles = files
    .filter(f => /^(\.env|\.env\.|config\.|.*\.config\.|.*\.toml|.*\.ya?ml|.*\.ini)/i.test(path.basename(f.rel)) ||
                 /(^|\/)(config|conf|settings)(\/|\.|$)/i.test(f.rel))
    .map(f => f.rel)
    .slice(0, 30);

  return {
    stack: [...new Set(stack)],
    buildCmds, runCmds, testCmds,
    deps,
    entryPoints,
    configFiles,
  };
}

// ── 入口点兜底推断（无 manifest 声明时） ──
function _inferEntryPoints(files) {
  const out = [];
  const candidates = [
    'index.js', 'index.ts', 'src/index.js', 'src/index.ts',
    'main.js', 'server.js', 'app.js', 'bin/cli.js',
    'main.py', 'app.py', 'src/main.py', 'main.go', 'src/main.rs', 'src/lib.rs',
    'index.html', 'src/main.ts', 'src/App.vue',
  ];
  const relSet = new Set(files.map(f => f.rel));
  for (const c of candidates) {
    if (relSet.has(c)) out.push({ kind: 'inferred-entry', path: c, hint: 'conventional' });
  }
  return out;
}

// ── 轻量符号抽取（正则，按语言；仅声明签名，不解析 AST） ──
function _extractSymbols(text, lang, limit) {
  const syms = [];
  const push = (kind, name) => {
    if (name && syms.length < limit) syms.push({ kind, name });
  };
  const lines = text.split(/\r?\n/);
  // 单一真源的语言→正则表，避免重复分支。每条 [kind, regex(全局), nameGroupIndex]。
  const RULES = {
    javascript: [
      ['fn', /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/, 1],
      ['class', /(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/, 1],
      ['const', /(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/, 1],
      ['export', /module\.exports(?:\.([A-Za-z_$][\w$]*))?\s*=/, 1],
    ],
    typescript: [
      ['fn', /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/, 1],
      ['class', /(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, 1],
      ['interface', /(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/, 1],
      ['type', /(?:export\s+)?type\s+([A-Za-z_$][\w$]*)/, 1],
    ],
    python: [
      ['def', /^\s*def\s+([A-Za-z_]\w*)/, 1],
      ['class', /^\s*class\s+([A-Za-z_]\w*)/, 1],
    ],
    go: [
      ['func', /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, 1],
      ['type', /^type\s+([A-Za-z_]\w*)/, 1],
    ],
    rust: [
      ['fn', /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/, 1],
      ['struct', /^\s*(?:pub\s+)?struct\s+([A-Za-z_]\w*)/, 1],
      ['enum', /^\s*(?:pub\s+)?enum\s+([A-Za-z_]\w*)/, 1],
      ['trait', /^\s*(?:pub\s+)?trait\s+([A-Za-z_]\w*)/, 1],
    ],
    c: [
      ['fn', /^[A-Za-z_][\w\s*]*\s+([A-Za-z_]\w*)\s*\([^;]*\)\s*\{?$/, 1],
      ['struct', /^(?:typedef\s+)?struct\s+([A-Za-z_]\w*)/, 1],
    ],
    java: [
      ['class', /(?:public|private|protected)?\s*(?:abstract\s+)?class\s+([A-Za-z_]\w*)/, 1],
      ['method', /(?:public|private|protected)\s+[\w<>\[\].]+\s+([A-Za-z_]\w*)\s*\(/, 1],
    ],
    ruby: [['def', /^\s*def\s+([A-Za-z_]\w*[!?]?)/, 1], ['class', /^\s*class\s+([A-Za-z_]\w*)/, 1]],
    php: [['fn', /function\s+([A-Za-z_]\w*)/, 1], ['class', /class\s+([A-Za-z_]\w*)/, 1]],
    moonbit: [['fn', /^\s*(?:pub\s+)?fn\s+([A-Za-z_]\w*)/, 1], ['struct', /^\s*(?:pub\s+)?struct\s+([A-Za-z_]\w*)/, 1]],
  };
  const rules = RULES[lang];
  if (!rules) return syms;
  for (const line of lines) {
    if (syms.length >= limit) break;
    if (line.length > 400) continue;
    for (const [kind, re, gi] of rules) {
      const m = line.match(re);
      if (m && m[gi]) { push(kind, m[gi]); break; }
    }
  }
  return syms;
}

// ── 目录职责启发式（按名字给一行人类可读职责） ──
const DIR_ROLES = {
  src: '源代码主目录', lib: '库代码', app: '应用代码', apps: '多应用',
  test: '测试', tests: '测试', spec: '测试规格', __tests__: '测试',
  docs: '文档', doc: '文档', scripts: '脚本（构建/CI/运维）', bin: '可执行入口',
  config: '配置', conf: '配置', settings: '配置',
  public: '静态资源', assets: '静态资源', static: '静态资源',
  components: 'UI 组件', views: '页面/视图', pages: '页面', routes: '路由',
  controllers: '控制器', services: '服务/业务逻辑', models: '数据模型',
  middleware: '中间件', utils: '工具函数', helpers: '辅助函数',
  api: 'API 层', server: '服务端', client: '客户端', frontend: '前端', backend: '后端',
  migrations: '数据库迁移', db: '数据库', database: '数据库',
  kernel: '内核', boot: '引导', drivers: '驱动', tools: '工具',
  packaging: '打包', dist: '发行物', vendor: '第三方', deploy: '部署',
};
function _dirRole(name) {
  return DIR_ROLES[name.toLowerCase()] || '';
}

// ── 渲染：目录树（有界，缩进） ──
function _renderTree(root, files, dirs, limits) {
  // 仅渲染 top 2 层，避免噪音。
  const lines = [];
  const topDirs = [...new Set(dirs.map(d => d.split('/')[0]))].sort();
  const rootFiles = files.filter(f => !f.rel.includes('/')).map(f => f.rel).sort();
  let count = 0;
  for (const d of topDirs) {
    if (count++ >= limits.maxTreeEntries) break;
    const role = _dirRole(d);
    lines.push(`- \`${d}/\`${role ? ` — ${role}` : ''}`);
    // 二级目录（数量按详略档位裁剪）
    const subs = [...new Set(dirs.filter(x => x.startsWith(`${d}/`)).map(x => x.split('/')[1]).filter(Boolean))].sort();
    for (const s of subs.slice(0, limits.treeSubDirs)) {
      if (count++ >= limits.maxTreeEntries) break;
      const srole = _dirRole(s);
      lines.push(`  - \`${d}/${s}/\`${srole ? ` — ${srole}` : ''}`);
    }
  }
  if (rootFiles.length) {
    lines.push('- 根文件: ' + rootFiles.slice(0, limits.treeRootFiles).map(f => `\`${f}\``).join(', '));
  }
  return lines.join('\n');
}

// ── 渲染：关键文件符号速览（给人看的导航 teaser） ──
// 按详略档位裁剪：限文件数 + 每文件符号数，超出用计数提示，并把完整逐文件清单的
// 权威来源指向 CONTEXT.yaml。这是「详略得当」的核心——人看的 MAP/SKELETON 只给够定位
// 的概览，机器读的 CONTEXT.yaml 才承载完整契约，避免在导航文档里堆「符号墙」。
function _renderSymbolTeaser(symbolFiles, limits, emptyHint) {
  if (!symbolFiles.length) return [`- ${emptyHint}`];
  const lines = [];
  const shownFiles = symbolFiles.slice(0, limits.mapSymbolFiles);
  for (const sf of shownFiles) {
    const total = sf.symbols.length;
    const shown = sf.symbols.slice(0, limits.mapSymbolsPerFile).map(s => s.name);
    let names = shown.join(', ');
    if (total > shown.length) names += `, …(+${total - shown.length})`;
    lines.push(`- \`${sf.rel}\` (${sf.lang}): ${names || '_无导出符号_'}`);
  }
  const restFiles = symbolFiles.length - shownFiles.length;
  if (restFiles > 0) {
    lines.push(`- …其余 ${restFiles} 个文件的符号见 \`CONTEXT.yaml\`（完整逐文件清单）。`);
  }
  return lines;
}

// ── 组装 MAP.md ──
function _renderMap(ctx, fingerprint) {
  const { projectName, det, tree, symbolFiles, limits } = ctx;
  const L = [];
  L.push(`<!-- ${AUTO_MARKER} ${TOOL_VERSION} fingerprint=${fingerprint} -->`);
  L.push('<!-- 本文件由 khy 机械生成，可被 `khy metadata refresh` 安全覆盖。删除上面这行标记即视为人工接管，刷新将不再覆盖本文件。 -->');
  L.push(`# MAP — ${projectName} 骨架与导航`);
  L.push('');
  L.push('> 由 khy 自动生成的可维护性种子文档（无需 AI 即可据此维护）。配套 `.ai/CONTEXT.yaml`（契约/符号）`.ai/GUARDS.md`（红线/无AI维护指南）。');
  L.push('> 本文为确定性扫描产物：目录职责按约定推断，入口/构建命令来自 manifest，符号清单来自轻量正则。带 `TODO(人工)` 处需维护者补全意图。');
  L.push('');
  L.push('## 技术栈');
  L.push(det.stack.length ? det.stack.map(s => `\`${s}\``).join(' · ') : '_未从 manifest 识别（TODO(人工): 补充语言/运行时）_');
  L.push('');
  L.push('## 核心入口点');
  const eps = det.entryPoints.length ? det.entryPoints : det.inferred;
  if (eps.length) {
    for (const e of eps.slice(0, 12)) L.push(`- \`${e.path}\` (${e.kind}${e.hint ? `, ${e.hint}` : ''})`);
  } else {
    L.push('- _未识别明确入口 — TODO(人工): 指明程序从哪个文件开始执行_');
  }
  L.push('');
  L.push('## 目录结构与职责');
  L.push(tree || '_（空项目）_');
  L.push('');
  L.push('## 构建 / 运行 / 测试');
  const renderCmds = (label, arr) => {
    if (!arr.length) return;
    L.push(`- **${label}**: ` + arr.map(c => `\`${c.cmd}\``).join(' ; '));
  };
  renderCmds('安装', det.buildCmds.filter(c => c.label === 'install'));
  renderCmds('构建', det.buildCmds.filter(c => c.label !== 'install'));
  renderCmds('运行', det.runCmds);
  renderCmds('测试', det.testCmds);
  if (!det.buildCmds.length && !det.runCmds.length && !det.testCmds.length) {
    L.push('- _未从 manifest 推断到命令 — TODO(人工): 补充如何构建/运行/测试_');
  }
  L.push('');
  L.push('## 关键文件符号速览');
  L.push('> 导航 teaser（按详略档位裁剪，`KHY_META_DETAIL=brief|standard|full`）。完整逐文件逐符号清单见 `CONTEXT.yaml`。');
  for (const line of _renderSymbolTeaser(symbolFiles, limits, '_未抽取到源码符号_')) L.push(line);
  L.push('');
  return L.join('\n') + '\n';
}

// ── 组装 CONTEXT.yaml（手写 emit，避免依赖） ──
function _yamlStr(s) {
  const v = String(s);
  if (v === '' || /[:#\-{}\[\],&*!|>%@`"']|^\s|\s$/.test(v)) {
    return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return v;
}
function _renderContext(ctx, fingerprint) {
  const { projectName, det, symbolFiles } = ctx;
  const L = [];
  L.push(`# CONTEXT — ${projectName} 契约与符号 (khy 自动生成种子文档)`);
  L.push('# 机器可读。stack/entry_points/build 来自 manifest；symbols 来自轻量正则。');
  L.push('generated:');
  L.push('  mode: auto                # auto = 机器自有，可被 refresh 覆盖；改为 manual 则人工接管');
  L.push(`  tool: ${_yamlStr(TOOL_VERSION)}`);
  L.push(`  fingerprint: ${_yamlStr(fingerprint)}`);
  L.push(`project: ${_yamlStr(projectName)}`);
  L.push(`stack: [${det.stack.map(_yamlStr).join(', ')}]`);
  L.push('entry_points:');
  const eps = det.entryPoints.length ? det.entryPoints : det.inferred;
  if (eps.length) {
    for (const e of eps.slice(0, 12)) L.push(`  - { path: ${_yamlStr(e.path)}, kind: ${_yamlStr(e.kind)}, hint: ${_yamlStr(e.hint || '')} }`);
  } else {
    L.push('  []   # TODO(人工): 补充入口');
  }
  L.push('build:');
  L.push(`  install: [${det.buildCmds.filter(c => c.label === 'install').map(c => _yamlStr(c.cmd)).join(', ')}]`);
  L.push(`  build:   [${det.buildCmds.filter(c => c.label !== 'install').map(c => _yamlStr(c.cmd)).join(', ')}]`);
  L.push(`  run:     [${det.runCmds.map(c => _yamlStr(c.cmd)).join(', ')}]`);
  L.push(`  test:    [${det.testCmds.map(c => _yamlStr(c.cmd)).join(', ')}]`);
  L.push('deps:');
  if (det.deps.length) L.push(`  primary: [${det.deps.map(_yamlStr).join(', ')}]`);
  else L.push('  primary: []');
  L.push('config_files:');
  if (det.configFiles.length) for (const c of det.configFiles) L.push(`  - ${_yamlStr(c)}`);
  else L.push('  []');
  L.push('symbols:   # 逐文件符号清单 (kind + name, 仅声明非语义)');
  if (symbolFiles.length) {
    for (const sf of symbolFiles) {
      L.push(`  ${_yamlStr(sf.rel)}:`);
      L.push(`    lang: ${_yamlStr(sf.lang)}`);
      if (sf.symbols.length) {
        L.push('    decls:');
        for (const s of sf.symbols) L.push(`      - { kind: ${_yamlStr(s.kind)}, name: ${_yamlStr(s.name)} }`);
      } else {
        L.push('    decls: []');
      }
    }
  } else {
    L.push('  {}');
  }
  return L.join('\n') + '\n';
}

// ── 组装 GUARDS.md（探测事实 + 通用红线 + 无 AI 维护指南 + 人工占位） ──
function _renderGuards(ctx, fingerprint) {
  const { projectName, det } = ctx;
  const L = [];
  L.push(`<!-- ${AUTO_MARKER} ${TOOL_VERSION} fingerprint=${fingerprint} -->`);
  L.push('<!-- 机器生成，可被 `khy metadata refresh` 覆盖。删除此标记行即人工接管。项目特有红线请写在「项目特有红线」小节，刷新不会动那一节以外的人工补写——但为安全起见，接管整文件时请删除本标记。 -->');
  L.push(`# GUARDS — ${projectName} 红线与维护指南 (khy 自动生成种子文档)`);
  L.push('');
  L.push('> 本文保证：**即便没有 AI**，维护者也能据此安全改动本项目。');
  L.push('> 自动探测部分是事实；`TODO(人工)` 部分需第一位维护者补全项目特有红线。');
  L.push('');
  L.push('## 探测到的事实（改动前先看）');
  const eps = det.entryPoints.length ? det.entryPoints : det.inferred;
  if (eps.length) L.push(`- **入口点**: ${eps.slice(0, 6).map(e => `\`${e.path}\``).join(', ')} — 改这些文件影响启动行为。`);
  if (det.configFiles.length) L.push(`- **配置/敏感文件**: ${det.configFiles.slice(0, 8).map(c => `\`${c}\``).join(', ')} — 含运行参数/密钥，勿提交真实密钥到版本库。`);
  if (det.stack.length) L.push(`- **技术栈**: ${det.stack.join(', ')} — 工具链需与之匹配。`);
  L.push('');
  L.push('## 如何在没有 AI 的情况下维护本项目');
  L.push('1. 读本目录三件套：`MAP.md`（去哪找代码）→ `CONTEXT.yaml`（谁调用谁/有哪些符号）→ 本文（哪些不能碰）。');
  if (det.buildCmds.length) L.push(`2. 复现构建：${det.buildCmds.map(c => `\`${c.cmd}\``).join(' → ')}。`);
  else L.push('2. 复现构建：TODO(人工) — 补全本项目的安装/构建步骤。');
  if (det.testCmds.length) L.push(`3. 改动后跑测试验证：${det.testCmds.map(c => `\`${c.cmd}\``).join(' ; ')}。`);
  else L.push('3. 改动后验证：TODO(人工) — 本项目尚无探测到的测试命令，补一条最小验证路径。');
  L.push('4. 小步改动、改完即验证、保持 `.ai/` 三件套与代码同步更新。');
  L.push('');
  L.push('## 通用红线（适用于多数项目）');
  L.push('- 不提交密钥/令牌到版本库（用 env 或密钥管理；检查 `config_files` 列出的文件）。');
  L.push('- 不在未跑测试的情况下改动入口点或公共接口。');
  L.push('- 不引入与既有技术栈冲突的工具链/包管理器。');
  L.push('- 不删除看不懂用途的文件——先在 `CONTEXT.yaml`/`MAP.md` 查它被谁引用。');
  L.push('- 不制造“上帝文件”：单个源文件只承担一个内聚职责，超出体量上限或开始混入无关职责时按职责拆分，而不是继续堆积。');
  L.push('- 不重复造同功能版块：新增模块/文件前先在本目录与 `MAP.md` 查是否已有同职能实现，有则扩展复用；同一能力只应存在一处，杜绝并行近似副本。');
  L.push('');
  L.push('## 项目特有红线（待维护者补全）');
  L.push('- TODO(人工): 列出"改了会运行期炸/数据损坏"的具体约束（如某字段格式、某调用顺序、某硬编码常量及其位置）。');
  L.push('- TODO(人工): 列出对外契约（API/协议/文件格式）中不可破坏向后兼容的部分。');
  L.push('');
  return L.join('\n') + '\n';
}

// ── 机器自有的最小骨架（当主文档为人工撰写、不可覆盖时，把可机械推导的部分落这里） ──
// 这是「khyos 自身随变化更新」的关键：人工 .ai/ 受保护，但派生层始终可被无 AI 刷新。
function _renderSkeletonAuto(ctx, fingerprint) {
  const { projectName, det, tree, symbolFiles, limits } = ctx;
  const L = [];
  L.push(`<!-- ${AUTO_MARKER} ${TOOL_VERSION} fingerprint=${fingerprint} -->`);
  L.push('<!-- 机器生成的派生骨架层。本目录的 MAP/CONTEXT/GUARDS 为人工撰写、不被覆盖；');
  L.push('     本文件由 `khy metadata refresh` 在结构变化时自动刷新，使「可机械推导的事实」永不过时。');
  L.push('     不要手工编辑本文件——人工补充请写进 MAP/CONTEXT/GUARDS。 -->');
  L.push(`# SKELETON (auto) — ${projectName} 机器派生骨架`);
  L.push('');
  L.push('> 与人工 `.ai/` 三件套并存：人工文档记录意图与红线，本文件记录随代码漂移的结构事实。');
  L.push('');
  L.push('## 技术栈');
  L.push(det.stack.length ? det.stack.map(s => `\`${s}\``).join(' · ') : '_未识别_');
  L.push('');
  L.push('## 核心入口点');
  const eps = det.entryPoints.length ? det.entryPoints : det.inferred;
  if (eps.length) for (const e of eps.slice(0, 12)) L.push(`- \`${e.path}\` (${e.kind}${e.hint ? `, ${e.hint}` : ''})`);
  else L.push('- _未识别_');
  L.push('');
  L.push('## 构建 / 运行 / 测试');
  const cmds = (label, arr) => { if (arr.length) L.push(`- **${label}**: ` + arr.map(c => `\`${c.cmd}\``).join(' ; ')); };
  cmds('安装', det.buildCmds.filter(c => c.label === 'install'));
  cmds('构建', det.buildCmds.filter(c => c.label !== 'install'));
  cmds('运行', det.runCmds);
  cmds('测试', det.testCmds);
  L.push('');
  L.push('## 目录结构');
  L.push(tree || '_（空）_');
  L.push('');
  L.push('## 关键文件符号速览');
  L.push('> 导航 teaser（按详略档位裁剪）。完整逐文件清单见同目录 `CONTEXT.yaml`。');
  for (const line of _renderSymbolTeaser(symbolFiles, limits, '_未抽取到符号_')) L.push(line);
  L.push('');
  return L.join('\n') + '\n';
}

/**
 * 确定性内容指纹：仅对「结构事实」取哈希（文件清单+大小、栈、入口、构建命令、依赖、符号），
 * 不含时间戳/随机数，因此相同项目结构永远得到相同指纹 → 内容不变则不重写（git 噪音最小化），
 * 内容一变指纹即变 → 可被无 AI 的机制（如 git 钩子）确定性地检测到「该刷新了」。
 * TOOL_VERSION 并入哈希：模板渲染逻辑升级时旧产物自动判定为 stale。
 */
function _computeFingerprint(ctx) {
  const { det, symbolFiles } = ctx;
  const canon = {
    v: TOOL_VERSION,
    stack: [...det.stack].sort(),
    entryPoints: (det.entryPoints.length ? det.entryPoints : det.inferred)
      .map(e => `${e.kind}:${e.path}`).sort(),
    build: det.buildCmds.map(c => `${c.label}:${c.cmd}`).sort(),
    run: det.runCmds.map(c => c.cmd).sort(),
    test: det.testCmds.map(c => c.cmd).sort(),
    deps: [...det.deps].sort(),
    configFiles: [...det.configFiles].sort(),
    symbols: symbolFiles
      .map(sf => `${sf.rel}|${sf.lang}|${sf.symbols.map(s => `${s.kind}:${s.name}`).join(',')}`)
      .sort(),
    // 全量源文件 path|size 清单：使「未进符号采样」的源文件变更也翻转指纹（无 AI 自动刷新触发器）。
    srcTree: Array.isArray(ctx.srcTree) ? ctx.srcTree : [],
  };
  return crypto.createHash('sha256').update(JSON.stringify(canon)).digest('hex').slice(0, 16);
}

// 文档是否为「机器自有」（带 AUTO_MARKER）。无标记 = 人工撰写，绝不覆盖。
function _isAutoOwned(text) {
  return typeof text === 'string' && text.includes(AUTO_MARKER);
}

function _readMetahash(aiDir) {
  try {
    const raw = fs.readFileSync(path.join(aiDir, METAHASH_FILE), 'utf8');
    const obj = JSON.parse(raw);
    return (obj && typeof obj === 'object') ? obj : null;
  } catch { return null; }
}

function _writeMetahash(aiDir, fingerprint, kind) {
  // 无时间戳（保持确定性、最小化 git 噪音）。kind: 'auto'（机器自有三件套）| 'skeleton'（人工+派生骨架）。
  const payload = { tool: TOOL_VERSION, fingerprint, kind };
  fs.writeFileSync(path.join(aiDir, METAHASH_FILE), JSON.stringify(payload, null, 2) + '\n', 'utf8');
}

/**
 * 稳定排序键：浅层在前，再按路径字典序。保证产物可复现（无时间/随机依赖）。
 */
function _byDepthPath(a, b) {
  const da = a.rel.split('/').length;
  const db = b.rel.split('/').length;
  if (da !== db) return da - db;
  return a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0;
}

/**
 * 公平挑选参与符号抽取的源文件——**按顶层模块轮询配额**，而非全局深度排序。
 *
 * 旧逻辑「全局 (depth,path) 排序后 slice」在大型 monorepo 下会让字典序靠前的浅层
 * 模块（apps/、kernel/、scripts/）吃满配额，深层模块（platform/、software/）的符号
 * 永远进不了骨架，其变更也就对指纹不可见。改为先按顶层段分桶、桶内稳定排序，再跨桶
 * 轮询取文件，确保每个主要模块都被代表，直到达到 maxSymbolFiles 上限。
 */
function _selectSymbolFiles(files, limits) {
  const src = files.filter(f => SOURCE_LANG[f.ext] && f.size > 0 && f.size <= limits.maxFileBytes);
  const buckets = new Map();   // 顶层段 → 该桶内源文件（根文件归入 '' 桶）
  for (const f of src) {
    const seg = f.rel.includes('/') ? f.rel.split('/')[0] : '';
    if (!buckets.has(seg)) buckets.set(seg, []);
    buckets.get(seg).push(f);
  }
  for (const arr of buckets.values()) arr.sort(_byDepthPath);
  const names = [...buckets.keys()].sort();   // 桶顺序确定性
  const picked = [];
  for (let i = 0; picked.length < limits.maxSymbolFiles; i++) {
    let progressed = false;
    for (const name of names) {
      const arr = buckets.get(name);
      if (i < arr.length) {
        picked.push(arr[i]);
        progressed = true;
        if (picked.length >= limits.maxSymbolFiles) break;
      }
    }
    if (!progressed) break;   // 所有桶都取尽
  }
  return picked.sort(_byDepthPath);   // 渲染/指纹用的最终稳定序
}

/**
 * 采集确定性上下文（扫描+探测+符号），供 generate/refresh 共用，避免重复逻辑。
 * @returns {{ok:boolean, reason?:string, ctx?:object, fileCount?:number}}
 */
function _collectContext(projectRoot, limits) {
  if (!projectRoot || !fs.existsSync(projectRoot) || !fs.statSync(projectRoot).isDirectory()) {
    return { ok: false, reason: 'invalid_root' };
  }
  const { files, dirs } = _scanTree(projectRoot, limits);
  if (files.length === 0) return { ok: false, reason: 'empty_project' };

  const det = _detectStack(projectRoot, files, limits);
  det.inferred = det.entryPoints.length ? [] : _inferEntryPoints(files);

  const sourceCandidates = _selectSymbolFiles(files, limits);

  const symbolFiles = [];
  for (const f of sourceCandidates) {
    const lang = SOURCE_LANG[f.ext];
    const text = _safeRead(f.abs, limits.maxFileBytes);
    if (!text) continue;
    const symbols = _extractSymbols(text, lang, limits.maxSymbolsPerFile);
    symbolFiles.push({ rel: f.rel, lang, symbols });
  }

  // 全量源文件清单（path|size），并入指纹——使「未被采样为符号文件」的源文件发生
  // 增/删/改名/体积变化时指纹照样翻转，骨架随之无 AI 自动刷新。size 在扫描期已 statSync，
  // 此处零额外 I/O。（同体积的等字节编辑是已知盲区，概率极低、可接受。）
  const srcTree = files
    .filter(f => SOURCE_LANG[f.ext])
    .map(f => `${f.rel}|${f.size}`)
    .sort();

  const projectName = path.basename(projectRoot) || 'project';
  const tree = _renderTree(projectRoot, files, dirs, limits);
  // limits 随 ctx 传入渲染层（供符号 teaser / 树密度按详略档位裁剪）。注意：指纹只哈希
  // det + symbolFiles（见 _computeFingerprint），不含 limits，故详略档位变化不动指纹。
  return { ok: true, ctx: { projectName, det, tree, symbolFiles, srcTree, limits }, fileCount: files.length };
}

/**
 * 渲染并写出机器自有三件套（MAP/CONTEXT/GUARDS）+ metahash，可选模型增强。
 * 供 generate（首次）与 refresh（结构变化覆盖）共用。
 */
async function _writeAutoDocs(aiDir, ctx, fingerprint, opts, log) {
  let docs = {
    map: _renderMap(ctx, fingerprint),
    context: _renderContext(ctx, fingerprint),
    guards: _renderGuards(ctx, fingerprint),
  };
  const enhanceEnabled = _boolEnv('KHY_META_MODEL_ENHANCE', false);
  if (enhanceEnabled && typeof opts.enhance === 'function') {
    try {
      const enriched = await opts.enhance(docs, {
        projectName: ctx.projectName, stack: ctx.det.stack, fingerprint,
      });
      if (enriched && typeof enriched === 'object') {
        if (typeof enriched.map === 'string' && enriched.map.trim()) docs.map = enriched.map;
        if (typeof enriched.context === 'string' && enriched.context.trim()) docs.context = enriched.context;
        if (typeof enriched.guards === 'string' && enriched.guards.trim()) docs.guards = enriched.guards;
        log('metadata: 模型增强已应用');
      }
    } catch {
      log('metadata: 模型增强失败，降级回确定性产物');
    }
  }
  fs.mkdirSync(aiDir, { recursive: true });
  fs.writeFileSync(path.join(aiDir, 'MAP.md'), docs.map, 'utf8');
  fs.writeFileSync(path.join(aiDir, 'CONTEXT.yaml'), docs.context, 'utf8');
  fs.writeFileSync(path.join(aiDir, 'GUARDS.md'), docs.guards, 'utf8');
  _writeMetahash(aiDir, fingerprint, 'auto');
  const files = ['.ai/MAP.md', '.ai/CONTEXT.yaml', '.ai/GUARDS.md', `.ai/${METAHASH_FILE}`];
  return files.concat(_linkPointers(path.dirname(aiDir), log));
}

// 让各 AI 工具的入口文件指向 .ai/（fail-soft）。返回新写/更新的文件相对路径列表。
function _linkPointers(root, log) {
  try {
    const r = metadataPointers.linkAgentPointers(root, { log });
    return Array.isArray(r && r.written) ? r.written : [];
  } catch {
    return [];
  }
}

/**
 * 确定性生成项目元数据。
 * @param {string} projectRoot 项目根绝对路径
 * @param {object} [opts]
 * @param {boolean} [opts.force] 即使 .ai/MAP.md 已存在也覆盖（默认 false → 幂等跳过）
 * @param {(msg:string)=>void} [opts.log] 进度回调
 * @param {(docs:{map,context,guards},meta)=>Promise<{map?,context?,guards?}>} [opts.enhance]
 *        可选模型增强 seam：接收确定性产物，可返回润色后的字符串覆盖。失败被吞，降级回确定性。
 * @returns {Promise<{generated:boolean, reason:string, root:string, files:string[]}>}
 */
async function generateProjectMetadata(projectRoot, opts = {}) {
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  try {
    if (!projectRoot || !fs.existsSync(projectRoot) || !fs.statSync(projectRoot).isDirectory()) {
      return { generated: false, reason: 'invalid_root', root: String(projectRoot || ''), files: [] };
    }
    const aiDir = path.join(projectRoot, '.ai');
    const mapPath = path.join(aiDir, 'MAP.md');
    if (!opts.force && fs.existsSync(mapPath)) {
      return { generated: false, reason: 'already_exists', root: projectRoot, files: [] };
    }

    const limits = LIMITS();
    const collected = _collectContext(projectRoot, limits);
    if (!collected.ok) {
      return { generated: false, reason: collected.reason, root: projectRoot, files: [] };
    }
    const { ctx } = collected;
    const fingerprint = _computeFingerprint(ctx);

    const written = await _writeAutoDocs(aiDir, ctx, fingerprint, opts, log);
    log(`metadata: 已生成可维护性种子文档（${written.join(', ')}）`);
    return { generated: true, reason: 'ok', root: projectRoot, files: written, fingerprint };
  } catch (err) {
    // 绝不打断生成它的任务。
    return { generated: false, reason: `error:${err && err.message ? err.message : 'unknown'}`, root: String(projectRoot || ''), files: [] };
  }
}

/**
 * 随项目变化「就地更新」元数据——无需 AI、确定性、非破坏性。这是 /goal
 * 「ai 元数据要能随项目更新……产生变化就需要即时更新，最好不靠 AI 自动完成」的核心。
 *
 * 三种情形（按 .ai/MAP.md 的归属判定，绝不误伤人工文档）：
 *   1. 缺失        → 首次生成完整三件套（等同 generate force）。
 *   2. 机器自有    → 比对指纹：变了就覆盖三件套+metahash（'refreshed'），没变则跳过（'unchanged'）。
 *   3. 人工撰写    → 绝不碰 MAP/CONTEXT/GUARDS；改为刷新机器派生层 SKELETON.auto.md + metahash，
 *                    使「可机械推导的事实」随代码漂移而更新（'skeleton_refreshed' / 'skeleton_unchanged'）。
 *
 * @returns {Promise<{generated:boolean, changed:boolean, reason:string, mode:'auto'|'skeleton'|'none', root:string, files:string[], fingerprint?:string}>}
 */
async function refreshProjectMetadata(projectRoot, opts = {}) {
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  try {
    const limits = LIMITS();
    const collected = _collectContext(projectRoot, limits);
    if (!collected.ok) {
      return { generated: false, changed: false, reason: collected.reason, mode: 'none', root: String(projectRoot || ''), files: [] };
    }
    const { ctx } = collected;
    const fingerprint = _computeFingerprint(ctx);
    const aiDir = path.join(projectRoot, '.ai');
    const mapPath = path.join(aiDir, 'MAP.md');

    // 情形 1：缺失 → 首次生成。
    if (!fs.existsSync(mapPath)) {
      const written = await _writeAutoDocs(aiDir, ctx, fingerprint, opts, log);
      log(`metadata: 首次生成（${written.join(', ')}）`);
      return { generated: true, changed: true, reason: 'generated', mode: 'auto', root: projectRoot, files: written, fingerprint };
    }

    const existing = _safeRead(mapPath, limits.maxFileBytes) || '';
    const autoOwned = _isAutoOwned(existing);

    if (autoOwned) {
      // 情形 2：机器自有 → 指纹比对决定是否覆盖。
      const meta = _readMetahash(aiDir);
      const prev = meta && meta.fingerprint;
      if (!opts.force && prev === fingerprint) {
        // Docs are current; still ensure AI entry-point pointers exist (idempotent —
        // returns [] when already linked, so no spurious change/stage on every commit).
        const linked = _linkPointers(projectRoot, log);
        return {
          generated: false, changed: linked.length > 0,
          reason: linked.length ? 'pointers_linked' : 'unchanged',
          mode: 'auto', root: projectRoot, files: linked, fingerprint,
        };
      }
      const written = await _writeAutoDocs(aiDir, ctx, fingerprint, opts, log);
      log(`metadata: 结构变化，已刷新（${written.join(', ')}）`);
      return { generated: true, changed: true, reason: 'refreshed', mode: 'auto', root: projectRoot, files: written, fingerprint };
    }

    // 情形 3：人工撰写 → 绝不覆盖三件套，只刷新机器派生骨架层。
    const skelPath = path.join(aiDir, SKELETON_AUTO);
    const meta = _readMetahash(aiDir);
    const prev = meta && meta.kind === 'skeleton' ? meta.fingerprint : null;
    if (!opts.force && prev === fingerprint && fs.existsSync(skelPath)) {
      // Derived skeleton is current; still ensure AI entry-point pointers exist
      // (idempotent — returns [] when already linked, so no noise on every commit).
      const linked = _linkPointers(projectRoot, log);
      return {
        generated: false, changed: linked.length > 0,
        reason: linked.length ? 'pointers_linked' : 'skeleton_unchanged',
        mode: 'skeleton', root: projectRoot, files: linked, fingerprint,
      };
    }
    fs.mkdirSync(aiDir, { recursive: true });
    fs.writeFileSync(skelPath, _renderSkeletonAuto(ctx, fingerprint), 'utf8');
    _writeMetahash(aiDir, fingerprint, 'skeleton');
    const linked = _linkPointers(projectRoot, log);
    log(`metadata: 人工 .ai/ 受保护，已刷新机器派生骨架（.ai/${SKELETON_AUTO}）`);
    return {
      generated: true, changed: true, reason: 'skeleton_refreshed', mode: 'skeleton',
      root: projectRoot, files: [`.ai/${SKELETON_AUTO}`, `.ai/${METAHASH_FILE}`, ...linked], fingerprint,
    };
  } catch (err) {
    return { generated: false, changed: false, reason: `error:${err && err.message ? err.message : 'unknown'}`, mode: 'none', root: String(projectRoot || ''), files: [] };
  }
}

/**
 * 从一次 agent 运行的 toolCallLog 推断是否"生成了项目"，若是则补齐元数据。
 * 触发条件（任一）：用过 scaffoldFiles/projectTemplate，或新写文件数 >= KHY_META_MIN_FILES。
 * 始终幂等（.ai/MAP.md 存在则跳过）、fail-soft。
 *
 * @param {string} cwd 当前工作目录（项目根上界，生成位置不会高于此）
 * @param {Array} toolCallLog 形如 [{ tool, params:{file_path|filePath|path}, result }]
 * @param {object} [opts] 透传给 generateProjectMetadata（log/enhance/force）
 * @returns {Promise<{generated:boolean, reason:string, root:string, files:string[]}>}
 */
async function maybeGenerateAfterRun(cwd, toolCallLog, opts = {}) {
  try {
    if (!_boolEnv('KHY_META_ENABLED', true)) {
      return { generated: false, reason: 'disabled', root: cwd, files: [] };
    }
    const log = Array.isArray(toolCallLog) ? toolCallLog : [];
    const minFiles = _intEnv('KHY_META_MIN_FILES', 3, 1, 1000);

    const norm = (s) => String(s || '').toLowerCase().replace(/[\s_-]/g, '');
    const isWriteTool = (t) => /^(write|writefile|createfile|scaffoldfiles|projecttemplate)$/.test(norm(t));
    const isScaffold = (t) => /^(scaffoldfiles|projecttemplate)$/.test(norm(t));

    const writtenAbs = [];
    let scaffoldUsed = false;
    for (const entry of log) {
      const tool = entry && entry.tool;
      const ok = entry && entry.result && entry.result.success !== false && !entry.result.denied;
      if (!tool || !ok) continue;
      if (isScaffold(tool)) {
        scaffoldUsed = true;
        // scaffold/template 的 result 可能带 root + createdFiles
        const r = entry.result;
        if (r && r.root) writtenAbs.push(path.resolve(r.root, '_'));  // 标记其 root
        if (Array.isArray(r && r.createdFiles)) {
          for (const cf of r.createdFiles) {
            const p = typeof cf === 'string' ? cf : (cf && (cf.path || cf.file));
            if (p) writtenAbs.push(path.isAbsolute(p) ? p : path.resolve(r.root || cwd, p));
          }
        }
      }
      if (isWriteTool(tool)) {
        const p = entry.params && (entry.params.file_path || entry.params.filePath || entry.params.path);
        if (p) writtenAbs.push(path.isAbsolute(p) ? p : path.resolve(cwd, p));
      }
    }

    const uniqueWritten = [...new Set(writtenAbs.filter(Boolean))];
    const trigger = scaffoldUsed || uniqueWritten.length >= minFiles;
    if (!trigger) {
      return { generated: false, reason: 'no_project_generated', root: cwd, files: [] };
    }

    const projectRoot = _commonProjectRoot(cwd, uniqueWritten);
    // refresh（而非 generate）：首次缺失则生成，已存在则按指纹「随变化更新」，
    // 人工 .ai/ 受保护只刷新派生骨架。满足 /goal「产生变化就需要即时更新」。
    return await refreshProjectMetadata(projectRoot, opts);
  } catch (err) {
    return { generated: false, reason: `error:${err && err.message ? err.message : 'unknown'}`, root: String(cwd || ''), files: [] };
  }
}

/**
 * 计算写入文件的公共祖先目录，下界 cwd（生成位置不会高于 cwd，也不会逃逸）。
 * - 全部文件直接在 cwd → 返回 cwd。
 * - 全部文件在 cwd/sub/... → 返回 cwd/sub（项目被脚手架进子目录的常见情形）。
 */
function _commonProjectRoot(cwd, absFiles) {
  const baseAbs = path.resolve(cwd);
  if (!absFiles.length) return baseAbs;
  // 仅考虑落在 cwd 之内的文件；越界的忽略。
  const within = absFiles
    .map(f => path.resolve(f))
    .filter(f => f === baseAbs || f.startsWith(baseAbs + path.sep));
  if (!within.length) return baseAbs;

  // 取每个文件相对 cwd 的第一段；若所有文件共享同一第一段且该段是目录，则下钻一层。
  const firstSegs = new Set();
  for (const f of within) {
    const rel = path.relative(baseAbs, f);
    const seg = rel.split(path.sep)[0];
    firstSegs.add(seg);
  }
  if (firstSegs.size === 1) {
    const only = [...firstSegs][0];
    const candidate = path.join(baseAbs, only);
    // 仅当该候选是已存在目录时才下钻（否则 only 是 cwd 直下的文件）。
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
        return candidate;
      }
    } catch { /* fall through */ }
  }
  return baseAbs;
}

/**
 * 只读地判定元数据状态（不写任何文件），供 CI 门禁 `khy metadata check` 与 hook 决策使用。
 * @returns {{ok:boolean, exists:boolean, mode:'auto'|'skeleton'|'none', stale:boolean,
 *            reason:string, fingerprint?:string, current?:string, root:string}}
 */
function checkProjectMetadata(projectRoot) {
  try {
    const limits = LIMITS();
    const collected = _collectContext(projectRoot, limits);
    if (!collected.ok) {
      return { ok: false, exists: false, mode: 'none', stale: false, reason: collected.reason, root: String(projectRoot || '') };
    }
    const current = _computeFingerprint(collected.ctx);
    const aiDir = path.join(projectRoot, '.ai');
    const mapPath = path.join(aiDir, 'MAP.md');
    if (!fs.existsSync(mapPath)) {
      return { ok: false, exists: false, mode: 'none', stale: true, reason: 'absent', current, root: projectRoot };
    }
    const existing = _safeRead(mapPath, limits.maxFileBytes) || '';
    const meta = _readMetahash(aiDir);
    if (_isAutoOwned(existing)) {
      const stale = !meta || meta.fingerprint !== current;
      return {
        ok: !stale, exists: true, mode: 'auto', stale,
        reason: stale ? 'stale' : 'fresh', fingerprint: meta && meta.fingerprint, current, root: projectRoot,
      };
    }
    // 人工撰写：以机器派生骨架的新鲜度衡量（人工三件套永远视为「存在即合格」）。
    const skelPath = path.join(aiDir, SKELETON_AUTO);
    const skelFresh = fs.existsSync(skelPath) && meta && meta.kind === 'skeleton' && meta.fingerprint === current;
    return {
      ok: skelFresh, exists: true, mode: 'skeleton', stale: !skelFresh,
      reason: skelFresh ? 'fresh' : 'skeleton_stale', fingerprint: meta && meta.fingerprint, current, root: projectRoot,
    };
  } catch (err) {
    return { ok: false, exists: false, mode: 'none', stale: false, reason: `error:${err && err.message ? err.message : 'unknown'}`, root: String(projectRoot || '') };
  }
}

module.exports = {
  generateProjectMetadata,
  refreshProjectMetadata,
  checkProjectMetadata,
  maybeGenerateAfterRun,
  // 暴露内部以便测试/复用
  _internal: {
    _scanTree, _detectStack, _extractSymbols, _commonProjectRoot, LIMITS,
    _computeFingerprint, _collectContext, _isAutoOwned, _readMetahash,
    AUTO_MARKER, SKELETON_AUTO, METAHASH_FILE, TOOL_VERSION,
  },
};
