#!/usr/bin/env node
'use strict';

/**
 * scripts/pack-portable.js — 打包便携分发 zip
 *
 * 用法:
 *   node scripts/pack-portable.js [--dry-run] [--no-modules] [--out <dir>]
 *
 * 产出: dist/khy-os-portable-<版本或日期>.zip
 *   - 默认包含 node_modules（解压即用，目标机 Node >= 23.4 无需 rebuild）
 *   - apps/ai-frontend 只携带编译产物 dist/（源码与 node_modules 不打包）
 *   - --no-modules  排除所有 node_modules（目标机首启需 npm install）
 *   - --dry-run     只列包含/排除清单与统计，不压缩
 *
 * 压缩实现: 优先使用 Windows 自带 bsdtar (tar.exe，支持 zip64 大文件)，
 * 不可用时回退 PowerShell Compress-Archive（staging 复制，体积大时较慢）。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SEP = path.sep;

// ---------------------------------------------------------------------------
// 参数解析
// ---------------------------------------------------------------------------
function parseArgv(argv) {
  const opts = { dryRun: false, noModules: false, out: path.join(ROOT, 'dist') };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--dry-run') opts.dryRun = true;
    else if (t === '--no-modules') opts.noModules = true;
    else if (t === '--out' && argv[i + 1]) opts.out = path.resolve(argv[++i]);
    else if (t === '--help' || t === '-h') { printHelp(); process.exit(0); }
    else { console.error(`未知参数: ${t}（可用: --dry-run / --no-modules / --out <dir> / --help）`); process.exit(1); }
  }
  return opts;
}

function printHelp() {
  console.log([
    '用法: node scripts/pack-portable.js [选项]',
    '  --dry-run      只列包含/排除清单与统计，不压缩',
    '  --no-modules   排除所有 node_modules（默认包含以做到解压即用）',
    '  --out <dir>    输出目录（默认 dist/）',
  ].join('\n'));
}

// ---------------------------------------------------------------------------
// 排除规则
// ---------------------------------------------------------------------------

// 根目录下整体排除的目录（运行时数据 / 版本库 / 构建产物 / 缓存）
const EXCLUDE_ROOT_DIRS = new Set([
  '.git', 'dist',
  // 运行时数据目录（与 .gitignore、portable-sync 保护目录一致）
  '.khyquant-data', '.khy', '.khyquant', '.khy-Trajectory', 'khy-Trajectory',
  'data', 'cache', 'logs',
]);

// 任意层级排除的目录名
const EXCLUDE_ANY_DIRS = new Set([
  '__pycache__', '.tmp', 'tmp', 'logs', 'coverage', '.nyc_output',
  '.idea', '.vscode', '.cache', '.pytest_cache',
]);

// 根目录下整体排除的文件
const EXCLUDE_ROOT_FILES = new Set([
  '_bs3_prebuild.tar.gz', '.sync-manifest.json', '.khy_orphan_sweep',
]);

// 任意层级按扩展名/文件名排除
const EXCLUDE_FILE_RE = [
  /\.log$/i, /\.pyc$/i, /\.pid$/i, /\.seed$/i,
  /\.node$/i, /\.node\.broken\.bak$/i,                 // 平台相关原生二进制
  /\.db$/i, /\.db-shm$/i, /\.db-wal$/i, /\.sqlite3?$/i, // 运行时数据库
  /\.swp$/i, /\.swo$/i, /\.orig$/i, /\.rej$/i,
  /\.tar\.gz\.enc$/i,                                   // 加密源码快照
  /^Thumbs\.db$/i, /^\.DS_Store$/i,
  /^\.env(\..*)?$/i,                                    // 本地环境/密钥
];

// node_modules 内部额外排除的目录名（预编译二进制 / 缓存）
// 注：不能整体排除 build/（部分包用 build/ 发布 JS），只排除 node-gyp 产物 build/Release|Debug
const EXCLUDE_NM_DIRS = new Set(['prebuilds', '.cache']);
// npm 中断安装残留目录形如 ".pkgname-XXXXXXXX"（保留 .bin）
const NM_TEMP_DIR_RE = /^\.(?!bin$).+/;

// apps/ai-frontend 只随包携带编译产物 dist/（Vite 已把 public/ 拷入 dist）。
// 运行态由 gatewayManageDaemon 只从 dist/ 静态托管，src/node_modules/public 均不需要。
const AI_FRONTEND_PREFIX = 'apps' + SEP + 'ai-frontend' + SEP;

function isAiFrontendExtra(rel) {
  if (!rel.startsWith(AI_FRONTEND_PREFIX)) return false;
  const rest = rel.slice(AI_FRONTEND_PREFIX.length);
  if (!rest) return false;                                  // ai-frontend 目录本身
  if (rest === 'dist' || rest.startsWith('dist' + SEP)) return false; // 保留 dist 子树
  return true;
}

function classifyEntry(rel, name, isDir, inNodeModules, parentIsNodeModules, opts) {
  // 返回 null=包含, 否则返回排除原因标签
  if (isDir) {
    if (isAiFrontendExtra(rel)) return 'ai-frontend-only-dist';
    if (!rel.includes(SEP) && EXCLUDE_ROOT_DIRS.has(name)) return 'root-dir:' + name;
    if (name === 'node_modules') {
      if (opts.noModules) return 'no-modules';
      return null;
    }
    if (inNodeModules) {
      if (EXCLUDE_NM_DIRS.has(name)) return 'nm-dir:' + name;
      if ((name === 'Release' || name === 'Debug') && /(^|[\\/])build$/.test(path.dirname(rel))) return 'nm-gyp:build/' + name;
      if (parentIsNodeModules && NM_TEMP_DIR_RE.test(name)) return 'nm-temp';
      return null;
    }
    if (EXCLUDE_ANY_DIRS.has(name)) return 'any-dir:' + name;
    return null;
  }
  if (isAiFrontendExtra(rel)) return 'ai-frontend-only-dist';
  if (!rel.includes(SEP) && EXCLUDE_ROOT_FILES.has(name)) return 'root-file:' + name;
  for (const re of EXCLUDE_FILE_RE) {
    if (re.test(name)) return 'file-pattern:' + String(re);
  }
  return null;
}

// ---------------------------------------------------------------------------
// 目录遍历（跳过符号链接/Junction，防止 node_modules/khy-os-backend 造成重复打包）
// ---------------------------------------------------------------------------
function collect(opts) {
  const files = [];            // { rel, size }
  const excluded = new Map();  // reason -> { count, bytes, samples[] }
  let symlinks = 0;

  function markExcluded(reason, rel, bytes, extraCount) {
    let e = excluded.get(reason);
    if (!e) { e = { count: 0, bytes: 0, samples: [] }; excluded.set(reason, e); }
    e.count += extraCount || 1;
    e.bytes += bytes;
    if (e.samples.length < 3) e.samples.push(rel);
  }

  function dirStats(abs) {
    // 统计被整目录排除的文件数与体积（用于摘要）
    let n = 0, s = 0;
    try {
      for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
        const f = path.join(abs, ent.name);
        if (ent.isSymbolicLink()) continue;
        if (ent.isDirectory()) { const r = dirStats(f); n += r[0]; s += r[1]; }
        else { n += 1; try { s += fs.statSync(f).size; } catch (_) {} }
      }
    } catch (_) {}
    return [n, s];
  }

  function walk(absDir, relDir, inNodeModules, parentIsNodeModules) {
    let entries;
    try { entries = fs.readdirSync(absDir, { withFileTypes: true }); } catch (_) { return; }
    for (const ent of entries) {
      const abs = path.join(absDir, ent.name);
      const rel = relDir ? relDir + SEP + ent.name : ent.name;
      if (ent.isSymbolicLink()) { symlinks += 1; continue; }
      if (ent.isDirectory()) {
        const reason = classifyEntry(rel, ent.name, true, inNodeModules, parentIsNodeModules, opts);
        if (reason) {
          const [n, s] = dirStats(abs);
          markExcluded(reason, rel + SEP, s, n);
          continue;
        }
        const isNM = ent.name === 'node_modules';
        const scoped = inNodeModules && ent.name.startsWith('@'); // @scope 下一层仍视作 node_modules 直接子级
        walk(abs, rel, inNodeModules || isNM, isNM || scoped);
      } else if (ent.isFile()) {
        const reason = classifyEntry(rel, ent.name, false, inNodeModules, parentIsNodeModules, opts);
        let size = 0;
        try { size = fs.statSync(abs).size; } catch (_) {}
        if (reason) { markExcluded(reason, rel, size); continue; }
        files.push({ rel, size });
      }
    }
  }

  walk(ROOT, '', false, false);
  return { files, excluded, symlinks };
}

// ---------------------------------------------------------------------------
// 压缩
// ---------------------------------------------------------------------------
function findTar() {
  const winTar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  if (process.platform === 'win32' && fs.existsSync(winTar)) return winTar;
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['tar'], { encoding: 'utf8' });
  if (probe.status === 0) return 'tar';
  return null;
}

function encodeListForTar(text) {
  // Windows 下 bsdtar 按系统 ANSI 代码页（如 GBK/936）解析 -T 清单，
  // 中文文件名需转换编码，否则报 "Can't convert a path to a wchar_t string"。
  if (process.platform !== 'win32' || !/[^\x00-\x7F]/.test(text)) return Buffer.from(text, 'utf8');
  try {
    const iconv = require(path.join(ROOT, 'node_modules', 'iconv-lite'));
    return iconv.encode(text, 'gbk');
  } catch (_) {
    console.warn('[pack] 警告: iconv-lite 不可用，中文文件名可能打包失败');
    return Buffer.from(text, 'utf8');
  }
}

function zipWithTar(tarBin, files, zipPath) {
  const listFile = path.join(os.tmpdir(), `khy-pack-list-${Date.now()}.txt`);
  // bsdtar -T 按行读取相对路径；-n 不递归（列表已全为文件）
  fs.writeFileSync(listFile, encodeListForTar(files.map((f) => f.rel).join('\n')));
  try {
    const r = spawnSync(tarBin, ['-a', '-c', '-n', '-f', zipPath, '-C', ROOT, '-T', listFile], {
      stdio: ['ignore', 'inherit', 'inherit'],
      maxBuffer: 64 * 1024 * 1024,
    });
    if (r.status !== 0) throw new Error(`tar 退出码 ${r.status}${r.error ? ' ' + r.error.message : ''}`);
  } finally {
    try { fs.unlinkSync(listFile); } catch (_) {}
  }
}

function zipWithCompressArchive(files, zipPath) {
  // 回退方案：staging 复制后 Compress-Archive（注意 >4GB 存档可能不受支持）
  const staging = path.join(os.tmpdir(), `khy-pack-staging-${Date.now()}`);
  console.log(`[pack] tar 不可用，回退 Compress-Archive（staging: ${staging}）`);
  for (const f of files) {
    const dst = path.join(staging, f.rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(ROOT, f.rel), dst);
  }
  const ps = [
    '$ErrorActionPreference="Stop";',
    `Compress-Archive -Path "${staging}\\*" -DestinationPath "${zipPath}" -CompressionLevel Optimal -Force`,
  ].join(' ');
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', ps], { stdio: 'inherit' });
  try { fs.rmSync(staging, { recursive: true, force: true }); } catch (_) {}
  if (r.status !== 0) throw new Error(`Compress-Archive 退出码 ${r.status}`);
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
function fmtBytes(n) {
  if (n >= 1024 * 1024 * 1024) return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
  if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return n + ' B';
}

function resolveVersionTag() {
  for (const p of [
    path.join(ROOT, 'package.json'),
    path.join(ROOT, 'services', 'backend', 'package.json'),
  ]) {
    try {
      const v = JSON.parse(fs.readFileSync(p, 'utf8')).version;
      if (v) return 'v' + v;
    } catch (_) {}
  }
  const d = new Date();
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('');
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
function main() {
  const opts = parseArgv(process.argv.slice(2));
  const t0 = Date.now();

  console.log(`[pack] 根目录: ${ROOT}`);
  console.log(`[pack] 模式: ${opts.dryRun ? 'dry-run（不压缩）' : '压缩'}${opts.noModules ? '，排除 node_modules' : '，包含 node_modules'}`);
  console.log('[pack] 扫描文件…');

  const { files, excluded, symlinks } = collect(opts);
  const totalBytes = files.reduce((s, f) => s + f.size, 0);

  // 包含清单：按顶层条目聚合
  const topAgg = new Map();
  for (const f of files) {
    const top = f.rel.includes(SEP) ? f.rel.slice(0, f.rel.indexOf(SEP)) + SEP : f.rel;
    let a = topAgg.get(top);
    if (!a) { a = { count: 0, bytes: 0 }; topAgg.set(top, a); }
    a.count += 1;
    a.bytes += f.size;
  }

  console.log('\n== 包含清单（按顶层聚合）==');
  for (const [top, a] of [...topAgg.entries()].sort((x, y) => y[1].bytes - x[1].bytes)) {
    console.log(`  ${top.padEnd(28)} ${String(a.count).padStart(7)} 个文件  ${fmtBytes(a.bytes)}`);
  }

  console.log('\n== 排除统计 ==');
  for (const [reason, e] of [...excluded.entries()].sort((x, y) => y[1].bytes - x[1].bytes)) {
    console.log(`  ${reason.padEnd(42)} ${String(e.count).padStart(7)} 项  ${fmtBytes(e.bytes)}  例: ${e.samples.join(', ')}`);
  }
  if (symlinks) console.log(`  (跳过符号链接/Junction ${symlinks} 个，如 node_modules/khy-os-backend、@khy/shared；首启由 preinstall 脚本重建)`);

  console.log(`\n[pack] 待打包: ${files.length} 个文件，原始体积 ${fmtBytes(totalBytes)}`);

  if (opts.dryRun) {
    console.log(`[pack] dry-run 完成，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return;
  }

  fs.mkdirSync(opts.out, { recursive: true });
  const tag = resolveVersionTag() + (opts.noModules ? '-nomodules' : '');
  const zipPath = path.join(opts.out, `khy-os-portable-${tag}.zip`);
  try { fs.unlinkSync(zipPath); } catch (_) {}

  console.log(`[pack] 压缩到 ${zipPath} …`);
  const tarBin = findTar();
  if (tarBin) zipWithTar(tarBin, files, zipPath);
  else if (process.platform === 'win32') zipWithCompressArchive(files, zipPath);
  else throw new Error('未找到 tar，无法压缩');

  const zipSize = fs.statSync(zipPath).size;
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log('\n== 打包摘要 ==');
  console.log(`  文件数   : ${files.length}`);
  console.log(`  原始体积 : ${fmtBytes(totalBytes)}`);
  console.log(`  zip 体积 : ${fmtBytes(zipSize)}`);
  console.log(`  产物     : ${zipPath}`);
  console.log(`  耗时     : ${secs}s`);
}

try {
  main();
} catch (err) {
  console.error(`[pack] 失败: ${(err && err.message) || err}`);
  process.exit(1);
}
