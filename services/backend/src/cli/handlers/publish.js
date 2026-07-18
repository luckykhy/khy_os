'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { promptCompat } = require('../uiPrompt');
const { findPython } = require('../../utils/pythonPath');
const {
  printError, printInfo, printSuccess, printWarn,
} = require('../formatters');
const {
  SNAPSHOT_ENC_NAME,
  SNAPSHOT_META_NAME,
  RESTORE_DOC_NAME,
  DEFAULT_SOURCE_SECRET,
  decrypt: _decryptSnapshot,
  sha256Hex: _sha256Hex,
  ALGO: _SNAPSHOT_ALGO,
} = require('../../services/sourceSnapshotCrypto');
// 还原完整性对账（bundled 运行时纯叶）+ 磁盘落地文件枚举原语（既有 bundled 服务）。
// 把「快照头 fileCount 只被打印、从不与磁盘对账」这条死字段接上线，让 restore 横幅诚实。
const { verifyRestoreCompleteness } = require('../../services/restoreCompletenessCheck');
const { _collectRelFiles } = require('../../services/sourceHealService');
// 解密前兼容性预检（bundled 运行时纯叶）：把 OPS-105 格式兼容 + OPS-110 加密套件可解密性
// 的诊断能力接进运行时 restore，让「套件不兼容」不再被误报成「用 --secret 口令错误」。
const { assessRestorePreflight } = require('../../services/restorePreflightCheck');
// 解密后、解包前的内层归档形制把关（bundled 运行时纯叶）：把 archiveExtractCompat 的诊断
// 能力接进运行时 restore。快照头的 plaintextFormat / layout 一直是死字段——解包器把
// `tar -xzf` 写死、从不读它们。本叶在盲目解包前确认本机认不认识这团解密归档，让未来
// tar.zst/zip 快照在旧机器上得到「请升级 khy」的精确成因，而非解出天书 / 半个目录。
const { assessArchiveExtractCompat } = require('../../services/restoreArchiveExtractCheck');
// 还原成功、打横幅时的「来源可溯性」把关（bundled 运行时纯叶）：把快照头的 captureMode /
// includesUncommitted / dirty 这条死三字段接进横幅。dev 侧 scripts/lib/restoreProvenance.js
// 早已能裁决「这份还原源码等于哪个 git 状态」，但运行时横幅只印 gitCommit——默认的脏工作树
// 快照被印成「commit X · 目录布局原样」，让维护者误判「等于干净提交 X」。本叶把静默误导变成诚实标注。
const { assessRestoreProvenance, buildProvenanceBannerLine } = require('../../services/restoreProvenanceCheck');
// 解密后、解包前的「路径可移植性」把关（bundled 运行时纯叶）：快照条目名是在 Linux 上打的，
// 但 pip/npm 会把它发到 Windows / macOS 还原。运行时 `tar -xzf` 盲解包对「哪些条目名在目标
// 文件系统建不出来」一无所知——保留设备名(CON/NUL/COM1…)、非法字符(< > : " | ? *)、结尾点/空格、
// 超 MAX_PATH、大小写碰撞都会**静默少文件 / 改名**，唯一信号是 completeness 事后发现「少了」。
// 本叶在解包前枚举条目名、逐条分类，给出主动、指名道姓、按宿主系统分级的诚实横幅。
const { assessPathPortability, buildPortabilityBannerLine } = require('../../services/restorePathPortabilityCheck');

// 门控 KHY_RESTORE_VERIFY_COMPLETENESS（默认开；仅 env ∈ {0,false,off,no} 归一后关闭）。
// 关 → 不做对账、横幅字节等价旧行为。
const _RESTORE_VERIFY_OFF = new Set(['0', 'false', 'off', 'no']);
function _restoreVerifyEnabled() {
  const raw = process.env.KHY_RESTORE_VERIFY_COMPLETENESS;
  if (raw == null) return true;
  return !_RESTORE_VERIFY_OFF.has(String(raw).trim().toLowerCase());
}

// 门控 KHY_RESTORE_PREFLIGHT（默认开；仅 env ∈ {0,false,off,no} 归一后关闭）。
// 关 → 跳过解密前预检，直入 decrypt（字节等价旧行为）。
function _restorePreflightEnabled() {
  const raw = process.env.KHY_RESTORE_PREFLIGHT;
  if (raw == null) return true;
  return !_RESTORE_VERIFY_OFF.has(String(raw).trim().toLowerCase());
}

// 门控 KHY_RESTORE_ARCHIVE_CHECK（默认开；仅 env ∈ {0,false,off,no} 归一后关闭）。
// 关 → 跳过解包前归档形制把关，直入 tar -xzf（字节等价旧行为：盲目解包）。
function _restoreArchiveCheckEnabled() {
  const raw = process.env.KHY_RESTORE_ARCHIVE_CHECK;
  if (raw == null) return true;
  return !_RESTORE_VERIFY_OFF.has(String(raw).trim().toLowerCase());
}

// 门控 KHY_RESTORE_PROVENANCE（默认开；仅 env ∈ {0,false,off,no} 归一后关闭）。
// 关 → 横幅不附「来源可溯性」诚实行，字节等价旧行为（只印 commit）。
function _restoreProvenanceEnabled() {
  const raw = process.env.KHY_RESTORE_PROVENANCE;
  if (raw == null) return true;
  return !_RESTORE_VERIFY_OFF.has(String(raw).trim().toLowerCase());
}

// 门控 KHY_RESTORE_PATH_PORTABILITY（默认开；仅 env ∈ {0,false,off,no} 归一后关闭）。
// 关 → 跳过解包前路径可移植性枚举与横幅，字节等价旧行为（直入 tar -xzf、无枚举开销）。
function _restorePathPortabilityEnabled() {
  const raw = process.env.KHY_RESTORE_PATH_PORTABILITY;
  if (raw == null) return true;
  return !_RESTORE_VERIFY_OFF.has(String(raw).trim().toLowerCase());
}

// 宿主系统解析：默认 process.platform；KHY_RESTORE_PLATFORM_OVERRIDE 允许在单机上验证
// win32 / darwin 分支（横幅严重度是 host-aware 的，测试需要能模拟目标系统）。
function _restoreHostPlatform() {
  const ov = process.env.KHY_RESTORE_PLATFORM_OVERRIDE;
  if (ov != null && String(ov).trim()) return String(ov).trim();
  return process.platform;
}

// Pure project-version-state reader (project root + manifest version parsing)
// was extracted to the services layer (B1 god-file split). Imported back under
// the original names so all existing call sites are unchanged.
const {
  PYPROJECT_PATH,
  PYTHON_INIT_CANDIDATES,
  BACKEND_PKG_CANDIDATES,
  NPM_PKG_CANDIDATES,
  _findProjectRoot,
  _resolveExisting,
  _readFileSafe,
  _extractProjectBlock,
  _extractProjectField,
  _readState,
  _isLikelyVersion,
} = require('../../services/publish/projectState');
// Generic dependency-free helpers, likewise extracted to the services layer.
const {
  _toInt,
  _formatDuration,
  _markFailure,
  _isTruthyFlag,
  _pickFirstNonEmpty,
} = require('../../services/publish/publishUtils');
// Pure deploy-bundle artifact generators (Dockerfile/compose/env/README + the
// filename timestamp), extracted to the services layer; imported back by name.
const {
  _writeDockerBundleDockerfile,
  _writeDockerBundleCompose,
  _writeDockerBundleEnvExample,
  _writeDockerBundleReadme,
  _writePipInstallBundleReadme,
  _timestampForFileName,
} = require('../../services/publish/bundleArtifacts');
// Print-free shared bundle helpers (JSON read, recursive copy, backend detection,
// ASCII tree, INSTALL_LAYOUT writer, archive packer) + the docker out-dir/skip-set
// constants, extracted to the services layer; imported back by their original names.
const {
  DOCKER_BUNDLE_DEFAULT_OUT_DIR,
  DOCKER_BUNDLE_SKIP_NAMES,
  _readJsonSafe,
  _copyDirForBundle,
  _isBackendRoot,
  _isSelfContainedBackend,
  _sortDirEntries,
  _buildAsciiTree,
  _writeInstallLayoutArtifacts,
  _buildDockerBundleArchive,
} = require('../../services/publish/bundleCommon');
// Docker deploy-bundle builder, extracted to the services layer with logger
// injection (the remote subsystem can now build a bundle without reaching up into
// cli/handlers). publish.js injects its own print* formatters below so the CLI
// output is unchanged; the lower-level helpers are imported back by name.
const {
  buildDockerBundle: _buildDockerBundleService,
  _resolveDockerBackendSource,
  _copyBackendForDockerBundle,
  _ensureSharedDependencyForBundle,
} = require('../../services/publish/dockerBundleBuilder');

const HEARTBEAT_MS_DEFAULT = 10000;
const DIST_NAME_PATTERN = /\.whl$|\.tar\.gz$/i;
const ORIGIN_CODE_DEFAULT_OUT_DIR = path.join('dist', 'origin-code');
const DOCKER_BUNDLE_ACTIONS = new Set(['docker-bundle', 'bundle-docker', 'docker']);
const PIP_INSTALL_BUNDLE_ACTIONS = new Set(['pip-dir-bundle', 'bundle-pip', 'pip-bundle', 'pipdir']);
const NPM_INSTALL_BUNDLE_ACTIONS = new Set(['npm-dir-bundle', 'bundle-npm', 'npm-bundle', 'npmdir']);
const ORIGIN_CODE_ACTIONS = new Set(['origin-code', 'restore-origin', 'origin']);
const RESTORE_ACTIONS = new Set(['restore', 'restore-source']);
const GIT_PUSH_ACTIONS = new Set(['git-push', 'push-git', 'push']);
const SELF_FIX_ACTIONS = new Set(['self-fix', 'self-bugfix', 'autofix']);
const SELF_PUBLISH_ACTIONS = new Set(['self-pypi', 'self-testpypi', 'self-release']);
const PIP_INSTALL_BUNDLE_SKIP_NAMES = new Set([
  ...DOCKER_BUNDLE_SKIP_NAMES,
  '__pycache__', '.pytest_cache', '.mypy_cache',
]);
const SUPPORTED_GIT_PLATFORMS = new Set(['github', 'gitee', 'gitlab']);
const SOURCE_RELEASE_SECRET_ENV_KEYS = ['KHY_SOURCE_PUBLISH_SECRET', 'KHY_OWNER_SECRET'];

function _readSourceReleaseSecret(options = {}) {
  const direct = _pickFirstNonEmpty([
    options.secret,
    options['owner-secret'],
    options.ownerSecret,
    options['study-secret'],
    options.studySecret,
    options.pwd,
    options.password,
  ]);
  if (direct) return direct;

  for (const key of SOURCE_RELEASE_SECRET_ENV_KEYS) {
    const fromEnv = String(process.env[key] || '').trim();
    if (fromEnv) return fromEnv;
  }
  return '';
}

function _replaceOrThrow(content, regex, replacement, fileLabel) {
  if (!regex.test(content)) {
    throw new Error(`未在 ${fileLabel} 找到可更新的版本字段`);
  }
  return content.replace(regex, replacement);
}

function _updateVersions(projectRoot, nextVersion) {
  const version = String(nextVersion || '').trim();
  if (!_isLikelyVersion(version)) {
    throw new Error(`版本号格式不合法: ${version}（示例: 0.1.0, 1.2.3rc1）`);
  }

  const pyInitRel = _resolveExisting(projectRoot, PYTHON_INIT_CANDIDATES);
  const backendPkgRel = _resolveExisting(projectRoot, BACKEND_PKG_CANDIDATES);

  const pyprojectFile = path.join(projectRoot, PYPROJECT_PATH);
  const pyInitFile = path.join(projectRoot, pyInitRel);
  const backendPkgFile = path.join(projectRoot, backendPkgRel);

  const pyproject = _readFileSafe(pyprojectFile);
  const updatedPyproject = _replaceOrThrow(
    pyproject,
    /(\[project\][\s\S]*?^\s*version\s*=\s*["'])([^"']+)(["']\s*$)/m,
    `$1${version}$3`,
    PYPROJECT_PATH
  );
  fs.writeFileSync(pyprojectFile, updatedPyproject, 'utf-8');

  // platform/khy_platform/__init__.py resolves __version__ dynamically from
  // pyproject.toml / installed metadata (enforced by check-version-sync.js as
  // the single source of truth). Only rewrite when a literal
  // `__version__ = "x.y.z"` is actually present (legacy layout); never throw
  // when the version is computed at runtime — that is the canonical design.
  const pyInit = _readFileSafe(pyInitFile);
  const LITERAL_VERSION = /(^\s*__version__\s*=\s*["'])([^"']+)(["']\s*$)/m;
  if (LITERAL_VERSION.test(pyInit)) {
    fs.writeFileSync(pyInitFile, pyInit.replace(LITERAL_VERSION, `$1${version}$3`), 'utf-8');
  }

  const backendPkgRaw = _readFileSafe(backendPkgFile);
  let backendPkg;
  try {
    backendPkg = JSON.parse(backendPkgRaw || '{}');
  } catch {
    throw new Error(`无法解析 ${backendPkgRel}`);
  }
  backendPkg.version = version;
  fs.writeFileSync(backendPkgFile, `${JSON.stringify(backendPkg, null, 2)}\n`, 'utf-8');

  // npm channel manifest (packaging/npm/package.json) — the THIRD version-sync
  // red-line source (check-version-sync.js). Historically this bump lived only
  // in publish-dual.sh, so `khy publish --version` left the npm channel behind
  // and check:version-sync would fail. Mirror the backend bump exactly. When the
  // file is absent (unexpected layout), skip fail-soft rather than throw.
  const npmPkgRel = _resolveExisting(projectRoot, NPM_PKG_CANDIDATES);
  const npmPkgFile = path.join(projectRoot, npmPkgRel);
  if (fs.existsSync(npmPkgFile)) {
    const npmPkgRaw = _readFileSafe(npmPkgFile);
    let npmPkg;
    try {
      npmPkg = JSON.parse(npmPkgRaw || '{}');
    } catch {
      throw new Error(`无法解析 ${npmPkgRel}`);
    }
    npmPkg.version = version;
    fs.writeFileSync(npmPkgFile, `${JSON.stringify(npmPkg, null, 2)}\n`, 'utf-8');
  }
}

function _detectPython() {
  return findPython() || '';
}

function _moduleReady(pythonCmd, moduleName) {
  if (!pythonCmd) return false;
  try {
    const result = spawnSync(pythonCmd, ['-m', moduleName, '--version'], {
      encoding: 'utf-8',
      timeout: 8000,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

function _collectDistArtifacts(projectRoot) {
  const distDir = path.join(projectRoot, 'dist');
  if (!fs.existsSync(distDir)) return [];
  const names = fs.readdirSync(distDir).filter(n => DIST_NAME_PATTERN.test(n));
  return names.sort().map(n => path.join('dist', n));
}

function _isPipSiteRoot(dirPath) {
  if (!dirPath) return false;
  const siteRoot = path.resolve(dirPath);
  return fs.existsSync(path.join(siteRoot, 'khy_platform'))
    && fs.existsSync(path.join(siteRoot, 'khy_os', 'bundled', 'backend', 'package.json'));
}

function _collectKhyDistInfoDirs(siteRoot) {
  try {
    return fs.readdirSync(siteRoot)
      .filter(name => /^(khy[-_](?:os|quant).*)\.dist-info$/i.test(name))
      .map(name => path.join(siteRoot, name));
  } catch {
    return [];
  }
}

function _probePipInstallLayoutViaPython(pythonCmd) {
  if (!pythonCmd) return null;
  const probe = [
    'import importlib.util',
    'import json',
    'import pathlib',
    'import sys',
    'spec = importlib.util.find_spec("khy_platform")',
    'if spec is None or not getattr(spec, "origin", None):',
    '    print("{}")',
    '    sys.exit(0)',
    'pkg_dir = pathlib.Path(spec.origin).resolve().parent',
    'site_root = pkg_dir.parent',
    'khy_os_dir = site_root / "khy_os"',
    'backend = khy_os_dir / "bundled" / "backend"',
    'if backend.exists():',
    '    print(json.dumps({"site_root": str(site_root), "khy_platform": str(pkg_dir), "khy_os": str(khy_os_dir), "backend": str(backend)}))',
    'else:',
    '    print("{}")',
  ].join('\n');

  try {
    const result = spawnSync(pythonCmd, ['-c', probe], {
      encoding: 'utf-8',
      timeout: 10000,
    });
    if (result.status !== 0) return null;

    const lines = String(result.stdout || '').trim().split(/\r?\n/).filter(Boolean);
    if (lines.length === 0) return null;
    const parsed = JSON.parse(lines[lines.length - 1] || '{}');
    const siteRoot = String(parsed.site_root || '').trim();
    const khyQuantDir = String(parsed.khy_platform || '').trim();
    const khyOsDir = String(parsed.khy_os || '').trim();
    const bundledBackendDir = String(parsed.backend || '').trim();
    if (!siteRoot || !khyQuantDir || !khyOsDir || !bundledBackendDir) return null;
    return {
      source: 'python',
      siteRoot: path.resolve(siteRoot),
      khyQuantDir: path.resolve(khyQuantDir),
      khyOsDir: path.resolve(khyOsDir),
      bundledBackendDir: path.resolve(bundledBackendDir),
    };
  } catch {
    return null;
  }
}

function _probePipInstallLayoutViaRuntime() {
  const runtimeBackendRoot = path.resolve(__dirname, '../../..');
  const bundledDir = path.resolve(runtimeBackendRoot, '..');
  const khyOsDir = path.resolve(bundledDir, '..');

  if (path.basename(runtimeBackendRoot) !== 'backend') return null;
  if (path.basename(bundledDir) !== 'bundled') return null;
  if (path.basename(khyOsDir) !== 'khy_os') return null;

  const siteRoot = path.resolve(khyOsDir, '..');
  const khyQuantDir = path.join(siteRoot, 'khy_platform');
  const bundledBackendDir = path.join(khyOsDir, 'bundled', 'backend');
  if (!fs.existsSync(path.join(khyQuantDir, 'cli.py'))) return null;
  if (!fs.existsSync(path.join(bundledBackendDir, 'package.json'))) return null;

  return {
    source: 'runtime',
    siteRoot,
    khyQuantDir,
    khyOsDir,
    bundledBackendDir,
  };
}

function _resolvePipInstallLayout(options = {}) {
  const explicitRoot = String(
    options['pip-root']
    || options.pipRoot
    || options['site-packages']
    || options.sitePackages
    || ''
  ).trim();
  if (explicitRoot) {
    const siteRoot = path.resolve(explicitRoot);
    if (!_isPipSiteRoot(siteRoot)) {
      throw new Error(`指定目录不是有效的 pip 安装根目录: ${siteRoot}`);
    }
    return {
      source: 'option',
      siteRoot,
      khyQuantDir: path.join(siteRoot, 'khy_platform'),
      khyOsDir: path.join(siteRoot, 'khy_os'),
      bundledBackendDir: path.join(siteRoot, 'khy_os', 'bundled', 'backend'),
    };
  }

  const pythonCmd = _detectPython();
  const fromPython = _probePipInstallLayoutViaPython(pythonCmd);
  if (fromPython && _isPipSiteRoot(fromPython.siteRoot)) return fromPython;

  const fromRuntime = _probePipInstallLayoutViaRuntime();
  if (fromRuntime && _isPipSiteRoot(fromRuntime.siteRoot)) return fromRuntime;

  throw new Error('未找到 pip 安装目录（可用 --pip-root <site-packages路径> 手动指定）');
}

function _resolveNpmInstallLayout(options = {}) {
  const explicitRoot = String(
    options['npm-root']
    || options.npmRoot
    || options['node-root']
    || options.nodeRoot
    || ''
  ).trim();

  const resolveBackendDirFromRoot = (rootPath) => {
    const abs = path.resolve(rootPath);
    if (_isBackendRoot(abs)) return abs;
    const backendSub = path.join(abs, 'backend');
    if (_isBackendRoot(backendSub)) return backendSub;
    return '';
  };

  let backendDir = '';
  if (explicitRoot) {
    backendDir = resolveBackendDirFromRoot(explicitRoot);
    if (!backendDir) {
      throw new Error(`指定目录不是有效的 npm 安装根目录: ${path.resolve(explicitRoot)}（未找到 backend）`);
    }
  } else {
    const runtimeBackendRoot = path.resolve(__dirname, '../../..');
    if (_isBackendRoot(runtimeBackendRoot)) {
      backendDir = runtimeBackendRoot;
    }
  }

  if (!backendDir) {
    throw new Error('未找到 npm 安装目录（可用 --npm-root <path> 手动指定）');
  }

  const baseName = path.basename(backendDir).toLowerCase();
  const projectLikeRoot = baseName === 'backend' ? path.resolve(backendDir, '..') : backendDir;
  return {
    installKind: 'npm',
    source: explicitRoot ? 'option' : 'runtime',
    siteRoot: backendDir,
    npmBackendDir: backendDir,
    projectLikeRoot,
  };
}

function _parseLooseVersion(raw = '') {
  const text = String(raw || '').trim();
  const m = text.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?([A-Za-z].*)?$/);
  if (!m) return null;
  return {
    major: parseInt(m[1] || '0', 10) || 0,
    minor: parseInt(m[2] || '0', 10) || 0,
    patch: parseInt(m[3] || '0', 10) || 0,
    suffix: String(m[4] || ''),
  };
}

function _compareLooseVersions(a = '', b = '') {
  const av = _parseLooseVersion(a);
  const bv = _parseLooseVersion(b);
  if (!av && !bv) return 0;
  if (av && !bv) return 1;
  if (!av && bv) return -1;
  if (av.major !== bv.major) return av.major > bv.major ? 1 : -1;
  if (av.minor !== bv.minor) return av.minor > bv.minor ? 1 : -1;
  if (av.patch !== bv.patch) return av.patch > bv.patch ? 1 : -1;
  if (!av.suffix && bv.suffix) return 1;
  if (av.suffix && !bv.suffix) return -1;
  if (av.suffix === bv.suffix) return 0;
  return av.suffix > bv.suffix ? 1 : -1;
}

function _getFileMtimeMs(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return Number(stat.mtimeMs || 0);
  } catch {
    return 0;
  }
}

function _collectInstallLayoutMeta(layout, kind) {
  const installKind = kind === 'npm' ? 'npm' : 'pip';
  const pkgPath = installKind === 'npm'
    ? path.join(layout.npmBackendDir, 'package.json')
    : path.join(layout.bundledBackendDir, 'package.json');
  const pkg = _readJsonSafe(pkgPath);
  const version = String(pkg.version || '').trim();
  const mtimeMs = _getFileMtimeMs(pkgPath);
  return {
    installKind,
    layout,
    version,
    mtimeMs,
    pkgPath,
  };
}

function _resolveInstallLayoutCandidate(options = {}, kind = 'pip') {
  try {
    if (kind === 'npm') return _resolveNpmInstallLayout(options);
    return _resolvePipInstallLayout(options);
  } catch {
    return null;
  }
}

function _choosePreferredInstallLayout(pipLayout, npmLayout) {
  const pipMeta = _collectInstallLayoutMeta(pipLayout, 'pip');
  const npmMeta = _collectInstallLayoutMeta(npmLayout, 'npm');

  const versionCmp = _compareLooseVersions(pipMeta.version, npmMeta.version);
  if (versionCmp > 0) {
    printInfo(`安装布局仲裁: 选择 pip（版本 ${pipMeta.version || '-'} > npm ${npmMeta.version || '-'}）`);
    return { ...pipLayout, installKind: 'pip' };
  }
  if (versionCmp < 0) {
    printInfo(`安装布局仲裁: 选择 npm（版本 ${npmMeta.version || '-'} > pip ${pipMeta.version || '-'}）`);
    return npmLayout;
  }

  if (pipMeta.mtimeMs > npmMeta.mtimeMs) {
    printInfo('安装布局仲裁: 版本相同，选择最近更新的 pip 安装目录');
    return { ...pipLayout, installKind: 'pip' };
  }
  if (npmMeta.mtimeMs > pipMeta.mtimeMs) {
    printInfo('安装布局仲裁: 版本相同，选择最近更新的 npm 安装目录');
    return npmLayout;
  }

  printInfo('安装布局仲裁: pip/npm 版本与时间一致，默认选择 pip 安装目录');
  return { ...pipLayout, installKind: 'pip' };
}

function _resolveInstallLayout(options = {}) {
  const forced = String(options.install || options['install-type'] || options.target || '').trim().toLowerCase();

  if (forced === 'pip') {
    const pip = _resolvePipInstallLayout(options);
    return { ...pip, installKind: 'pip' };
  }
  if (forced === 'npm') {
    return _resolveNpmInstallLayout(options);
  }

  const pip = _resolveInstallLayoutCandidate(options, 'pip');
  const npm = _resolveInstallLayoutCandidate(options, 'npm');

  if (pip && npm) return _choosePreferredInstallLayout(pip, npm);
  if (pip) return { ...pip, installKind: 'pip' };
  if (npm) return npm;

  throw new Error('未找到可用安装布局（可用 --install pip|npm + --pip-root/--npm-root 手动指定）');
}

function _copyIfExists(srcDir, dstDir, skipNames) {
  if (!srcDir || !dstDir) return false;
  if (!fs.existsSync(srcDir)) return false;
  fs.mkdirSync(path.dirname(dstDir), { recursive: true });
  _copyDirForBundle(srcDir, dstDir, skipNames);
  return true;
}

function _writeOriginCodeReadme(bundleRoot, meta = {}) {
  const installKind = String(meta.installKind || 'pip').toLowerCase();
  const sourceLabel = installKind === 'npm' ? 'Source npm root' : 'Source pip root';
  const reconstructionNote = installKind === 'npm'
    ? 'This bundle is reconstructed from npm-installed payload/runtime paths.'
    : 'This bundle is reconstructed from pip payload (`khy_os/bundled`), not a Git clone.';
  const readme = `# KHY OS Origin Code Restore Bundle

Generated at: ${new Date().toISOString()}
${sourceLabel}: ${meta.siteRoot || '(unknown)'}
Version: ${meta.version || '(unknown)'}

## Purpose

Restore a source-like project tree from installed payload.

## Restored Top-level Paths

- \`khy_platform/\`
- \`backend/\`
- \`frontend/\`
- \`docs/\`
- \`alpine/\`
- \`scripts/alpine/\`
- \`packages/shared/\`

## Notes

- ${reconstructionNote}
- Repository metadata such as \`.git/\`, CI cache files, and pruned artifacts are not included.
- See \`INSTALL_LAYOUT.md\` and \`INSTALL_LAYOUT.json\` for precise source mapping.
`;
  fs.writeFileSync(path.join(bundleRoot, 'README.md'), readme, 'utf-8');
}

function _buildOriginCodeBundle(projectRoot, state, options = {}) {
  const layout = _resolveInstallLayout(options);
  const installKind = String(layout.installKind || 'pip').toLowerCase() === 'npm' ? 'npm' : 'pip';
  const runtimePkgPath = installKind === 'npm'
    ? path.join(layout.npmBackendDir, 'package.json')
    : path.join(layout.bundledBackendDir, 'package.json');
  const runtimePkg = _readJsonSafe(runtimePkgPath);
  const version = String(runtimePkg.version || state?.versions?.backend || state?.versions?.pyproject || '0.0.0').trim();
  const safeVersion = String(version || '0.0.0').replace(/[^0-9A-Za-z._-]/g, '-');
  const bundleName = String(options.name || `khy-os-origin-code-${safeVersion}-${_timestampForFileName()}`).replace(/[^0-9A-Za-z._-]/g, '-');

  const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-origin-code-bundle-'));
  const bundleRoot = path.join(stagingRoot, bundleName);
  fs.mkdirSync(bundleRoot, { recursive: true });
  printInfo(`还原 origin code(${installKind}): ${layout.siteRoot}`);

  const sourceLocations = installKind === 'npm'
    ? {
      khyQuantDir: '',
      bundledRoot: layout.projectLikeRoot,
      backendDir: layout.npmBackendDir,
      frontendDir: path.join(layout.projectLikeRoot, 'frontend'),
      docsDir: path.join(layout.projectLikeRoot, 'docs'),
      alpineDir: path.join(layout.projectLikeRoot, 'kernel', 'alpine'),
      scriptsAlpineDir: path.join(layout.projectLikeRoot, 'scripts', 'alpine'),
      packagesSharedDir: path.join(layout.projectLikeRoot, 'packages', 'shared'),
      backendSharedDir: path.join(layout.npmBackendDir, 'vendor', 'shared'),
    }
    : {
      khyQuantDir: layout.khyQuantDir,
      bundledRoot: path.join(layout.khyOsDir, 'bundled'),
      backendDir: path.join(layout.khyOsDir, 'bundled', 'backend'),
      frontendDir: path.join(layout.khyOsDir, 'bundled', 'frontend'),
      docsDir: path.join(layout.khyOsDir, 'bundled', 'docs'),
      alpineDir: path.join(layout.khyOsDir, 'bundled', 'alpine'),
      scriptsAlpineDir: path.join(layout.khyOsDir, 'bundled', 'scripts', 'alpine'),
      packagesSharedDir: path.join(layout.khyOsDir, 'bundled', 'packages', 'shared'),
      backendSharedDir: path.join(layout.khyOsDir, 'bundled', 'backend', 'vendor', 'shared'),
    };

  const sourceMappings = [];
  if (sourceLocations.khyQuantDir && _copyIfExists(sourceLocations.khyQuantDir, path.join(bundleRoot, 'khy_platform'), PIP_INSTALL_BUNDLE_SKIP_NAMES)) {
    sourceMappings.push({
      target: 'khy_platform/',
      source: sourceLocations.khyQuantDir,
      note: 'python launcher package',
    });
  }
  if (_copyIfExists(sourceLocations.backendDir, path.join(bundleRoot, 'backend'), PIP_INSTALL_BUNDLE_SKIP_NAMES)) {
    sourceMappings.push({
      target: 'backend/',
      source: sourceLocations.backendDir,
      note: installKind === 'npm' ? 'restored from npm backend package' : 'restored from pip bundled backend',
    });
  }
  if (_copyIfExists(sourceLocations.frontendDir, path.join(bundleRoot, 'frontend'), PIP_INSTALL_BUNDLE_SKIP_NAMES)) {
    sourceMappings.push({
      target: 'frontend/',
      source: sourceLocations.frontendDir,
      note: installKind === 'npm' ? 'restored from npm installation root' : 'restored from pip bundled frontend',
    });
  }
  if (_copyIfExists(sourceLocations.docsDir, path.join(bundleRoot, 'docs'), PIP_INSTALL_BUNDLE_SKIP_NAMES)) {
    sourceMappings.push({
      target: 'docs/',
      source: sourceLocations.docsDir,
      note: installKind === 'npm' ? 'restored from npm installation root' : 'restored from pip bundled docs',
    });
  }
  if (_copyIfExists(sourceLocations.alpineDir, path.join(bundleRoot, 'alpine'), PIP_INSTALL_BUNDLE_SKIP_NAMES)) {
    sourceMappings.push({
      target: 'alpine/',
      source: sourceLocations.alpineDir,
      note: installKind === 'npm' ? 'restored from npm installation root' : 'restored from pip bundled alpine resources',
    });
  }
  if (_copyIfExists(sourceLocations.scriptsAlpineDir, path.join(bundleRoot, 'scripts', 'alpine'), PIP_INSTALL_BUNDLE_SKIP_NAMES)) {
    sourceMappings.push({
      target: 'scripts/alpine/',
      source: sourceLocations.scriptsAlpineDir,
      note: 'ISO helper scripts',
    });
  }

  const sharedSrcCandidates = [
    sourceLocations.packagesSharedDir,
    sourceLocations.backendSharedDir,
  ];
  for (const sharedSrc of sharedSrcCandidates) {
    if (!sharedSrc) continue;
    if (_copyIfExists(sharedSrc, path.join(bundleRoot, 'packages', 'shared'), PIP_INSTALL_BUNDLE_SKIP_NAMES)) {
      sourceMappings.push({
        target: 'packages/shared/',
        source: sharedSrc,
        note: 'shared package restored',
      });
      break;
    }
  }

  _writeOriginCodeReadme(bundleRoot, {
    siteRoot: layout.siteRoot,
    version,
    installKind,
  });
  _writeInstallLayoutArtifacts(bundleRoot, {
    bundleType: 'origin-code-bundle',
    version,
    focusSubdir: 'backend',
    sourceMappings,
  });

  const archivePath = _buildDockerBundleArchive(
    bundleRoot,
    options.out || options.output || options['out-dir'] || options['output-dir'] || ORIGIN_CODE_DEFAULT_OUT_DIR,
    bundleName
  );
  printSuccess(`origin code 还原包已生成: ${archivePath}`);
  printInfo('使用方式: 解压后即可得到接近源码仓库的目录结构');
  return {
    archivePath,
    bundleName,
    version,
    siteRoot: layout.siteRoot,
  };
}

// ── Full-source snapshot restore (khy restore) ─────────────────────
// The pip wheel / npm package embeds an ENCRYPTED `git archive` of the whole
// repo under a `_source/` dir (see scripts/makeSourceSnapshot.js). Restore
// decrypts it with the owner secret and extracts it verbatim — original layout,
// every tracked file (kernel source, docs, data …) that the pruned runtime
// bundle drops. This is the carrier that lets a cloud-dev-only project be fully
// reconstructed on any machine via pip/npm, with no USB / direct download.

function _snapshotDirHasFiles(dir) {
  return !!dir
    && fs.existsSync(path.join(dir, SNAPSHOT_META_NAME))
    && fs.existsSync(path.join(dir, SNAPSHOT_ENC_NAME));
}

/**
 * Locate the embedded `_source/` snapshot directory across install shapes.
 * Primary anchors are derived from this backend's own location (robust for both
 * pip — bundled/services/backend → bundled/_source — and npm — package root
 * /_source). The resolved install layout is consulted best-effort as a fallback.
 */
function _findSnapshotSourceDir(options = {}) {
  const explicit = _pickFirstNonEmpty([
    options['source-dir'], options.sourceDir, options.from,
  ]);
  const candidates = [];
  if (explicit) candidates.push(path.resolve(explicit));

  const backendRoot = path.resolve(__dirname, '../../..'); // services/backend
  candidates.push(
    path.join(backendRoot, '_source'),                 // npm package + standalone backend
    path.join(backendRoot, '..', '..', '_source'),     // pip: bundled/services/backend → bundled/_source
    path.join(backendRoot, '..', '_source'),           // defensive
  );

  try {
    const layout = _resolveInstallLayout(options);
    if (String(layout.installKind).toLowerCase() === 'npm') {
      if (layout.projectLikeRoot) candidates.push(path.join(layout.projectLikeRoot, '_source'));
      if (layout.npmBackendDir) candidates.push(path.join(layout.npmBackendDir, '_source'));
    } else {
      if (layout.khyOsDir) candidates.push(path.join(layout.khyOsDir, 'bundled', '_source'));
      if (layout.bundledBackendDir) candidates.push(path.join(layout.bundledBackendDir, '..', '..', '_source'));
    }
  } catch { /* install layout optional — backendRoot anchors usually suffice */ }

  for (const c of candidates) {
    if (_snapshotDirHasFiles(c)) return c;
  }
  return null;
}

/** Extract a tar.gz buffer into destDir, preserving the original layout. */
function _extractTarGz(tarGzBuffer, destDir) {
  const tmp = path.join(os.tmpdir(), `khy-restore-${process.pid}-${Date.now()}.tar.gz`);
  fs.writeFileSync(tmp, tarGzBuffer);
  try {
    // `tar` is present on Linux/macOS and on Windows 10 1803+ (bsdtar as tar.exe).
    const result = spawnSync('tar', ['-xzf', tmp, '-C', destDir], { encoding: 'utf-8' });
    if (result.error && result.error.code === 'ENOENT') {
      throw new Error('未找到 tar 命令。Windows 10/11 自带 tar；旧系统请先安装 tar 或 7-Zip 再重试。');
    }
    if (result.status !== 0) {
      throw new Error(`解包失败(tar): ${String(result.stderr || result.stdout || '').trim() || `exit ${result.status}`}`);
    }
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

/**
 * List entry names inside a tar.gz buffer WITHOUT extracting (`tar -tzf`).
 * Used by the path-portability pre-scan: enumeration succeeds even for names that
 * would FAIL to extract on Windows/macOS, so we can warn about them before unpack.
 *
 * Bounded + fail-soft: a hard timeout guarantees this never hangs (the whole point
 * of the restore honesty family is never to block), and ANY failure (missing tar,
 * timeout, non-zero exit, malformed output) returns `null` → caller silently skips
 * the portability banner (byte-equivalent to old behavior). Only reads entry-name
 * strings — never touches any secret.
 *
 * @param {Buffer} tarGzBuffer  the decrypted, integrity-verified inner archive
 * @returns {(string[]|null)}   entry names (leading './' and trailing '/' stripped) or null
 */
function _listTarGzEntries(tarGzBuffer) {
  const tmp = path.join(os.tmpdir(), `khy-restore-list-${process.pid}-${Date.now()}.tar.gz`);
  try {
    fs.writeFileSync(tmp, tarGzBuffer);
    const result = spawnSync('tar', ['-tzf', tmp], { encoding: 'utf-8', timeout: 20000, maxBuffer: 64 * 1024 * 1024 });
    if (result.error || result.status !== 0 || typeof result.stdout !== 'string') return null;
    const names = [];
    for (const raw of result.stdout.split('\n')) {
      let n = raw.replace(/\r$/, '');
      if (!n) continue;
      n = n.replace(/^\.\//, '').replace(/\/+$/, '');
      if (n) names.push(n);
    }
    return names;
  } catch {
    return null;
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

/**
 * Resolve the restore secret. Restore is no longer password-gated: an explicit
 * --secret / KHY_SOURCE_PUBLISH_SECRET still wins (needed for legacy snapshots
 * built with a custom key), but absent that we fall back to the password-free
 * DEFAULT_SOURCE_SECRET the build now embeds under — so `khy restore` just works.
 */
async function _resolveRestoreSecret(options = {}) {
  const explicit = _readSourceReleaseSecret(options);
  return explicit || DEFAULT_SOURCE_SECRET;
}

/**
 * Decrypt + verify + extract the embedded snapshot into targetDir.
 * The encryption IS the access gate: a wrong secret fails GCM authentication.
 * @returns {{ok:boolean, reason?:string, dest?:string, header?:object, srcDir?:string}}
 */
async function _restoreFromSnapshot(targetDir, options = {}) {
  const srcDir = _findSnapshotSourceDir(options);
  if (!srcDir) return { ok: false, reason: 'no-snapshot' };

  const header = _readJsonSafe(path.join(srcDir, SNAPSHOT_META_NAME), null);
  if (!header || !header.crypto) {
    throw new Error(`快照元数据缺失或损坏: ${path.join(srcDir, SNAPSHOT_META_NAME)}`);
  }

  // 解密前兼容性预检（OPS-105 格式 + OPS-110 加密套件）。
  // block = 本机 khy 可证明解不开（缺/不支持 algo、不支持 kdf、缺 salt/iv/authTag）→
  //   抛出精确成因，取代下方误导性的「请用 --secret 口令错误」；zero false-block。
  // warn  = 仍可能解开（格式异形/版本偏差）→ 只提示、继续，绝不假阻断。
  // 门关或异常 → 退化为旧行为（字节等价直入 decrypt）。红线：预检只读 algo/kdf/format
  //   字符串与 salt/iv/authTag 的存在性布尔，绝不触碰其值。
  if (_restorePreflightEnabled()) {
    const pf = assessRestorePreflight(header, { supportedAlgos: [_SNAPSHOT_ALGO] });
    if (pf.block) throw new Error(pf.message);
    if (pf.warn) printWarn(pf.message);
  }

  const secret = await _resolveRestoreSecret(options);

  const ciphertext = fs.readFileSync(path.join(srcDir, SNAPSHOT_ENC_NAME));
  let plaintext;
  try {
    plaintext = _decryptSnapshot(ciphertext, header, secret);
  } catch {
    // Snapshots built after the password-free change decrypt with the default
    // key automatically; a failure here means a legacy snapshot encrypted with a
    // custom key, so the explicit --secret / KHY_SOURCE_PUBLISH_SECRET is needed.
    throw new Error('解密失败：该快照由自定义密钥加密，请用 --secret <密钥> 指定；或快照已损坏/篡改。');
  }
  if (header.sha256 && _sha256Hex(plaintext) !== header.sha256) {
    throw new Error('完整性校验失败：解密后的 sha256 与快照头不一致。');
  }

  // 解包前把关（OPS-128）：解密 + sha256 均已通过，密文是真的、完整的——但本机的
  // `tar -xzf` 认不认识这团解密出来的内层归档？把关 header.plaintextFormat / layout。
  // block = 格式不受支持（未来 tar.zst/zip 快照遇上旧 khy）→ 抛精确「请升级 khy」成因，
  //   在**创建目标目录 / 盲目解包之前**拦下，取代下方解出天书 / 半个目录的误导失败。
  // warn  = layout 陌生 → 只提示、仍解包，绝不 false-block 一个其实能解出字节的快照。
  // 门关或异常 → 退化为旧行为（字节等价直入 tar -xzf）。红线：只读归档形制串，绝不碰密钥。
  if (_restoreArchiveCheckEnabled()) {
    const ac = assessArchiveExtractCompat(header);
    if (ac.block) throw new Error(ac.message);
    if (ac.warn) printWarn(ac.message);
  }

  const dest = path.resolve(
    _pickFirstNonEmpty([targetDir]) || path.join(process.cwd(), 'Khy-OS')
  );
  const force = _isTruthyFlag(options.force) || _isTruthyFlag(options.f);
  if (fs.existsSync(dest) && fs.readdirSync(dest).length > 0 && !force) {
    throw new Error(`目标目录非空: ${dest}（加 --force 覆盖写入）`);
  }
  fs.mkdirSync(dest, { recursive: true });

  // 解包前路径可移植性预扫（门 default-on）：在盲目 `tar -xzf` 之前把归档条目名枚举出来，
  // 逐条按五类跨 OS 命名危害分类（Windows 保留名 / 非法字符 / 结尾点空格 / 超 MAX_PATH / 大小写碰撞）。
  // 纯诊断叠加——绝不改变还原成败、绝不阻拦解包：超长 / 保留名 / 碰撞是**目标系统**的命名限制，
  // 不是这团归档坏了（Linux 上还原它照样完整）。枚举有界超时、fail-soft，异常/门关 → 不带 verdict
  // （横幅字节等价旧行为）。红线：只读条目名字符串，绝不碰密钥。
  let pathPortability = null;
  if (_restorePathPortabilityEnabled()) {
    try {
      const _entries = _listTarGzEntries(plaintext);
      if (Array.isArray(_entries)) pathPortability = assessPathPortability(_entries);
    } catch { pathPortability = null; }
  }

  _extractTarGz(plaintext, dest);

  // 落地对账：把磁盘上真正解出的文件数与快照头 fileCount 对账（门 default-on）。
  // 纯诊断叠加层——绝不让还原失败，异常/证据不足则不附带 verdict（横幅回退旧行为）。
  let completeness = null;
  if (_restoreVerifyEnabled()) {
    try {
      const actualFileCount = _collectRelFiles(dest).length;
      completeness = verifyRestoreCompleteness({
        expectedFileCount: header.fileCount,
        actualFileCount,
      });
    } catch { completeness = null; }
  }

  return { ok: true, dest, header, srcDir, completeness, pathPortability };
}

/** Top-level `khy restore [dir] [--into <dir>] [--secret <s>] [--force]`. */
async function handleRestore(args = [], options = {}) {
  const positional = (Array.isArray(args) ? args : [])
    .find(a => a && !String(a).startsWith('-'));
  const targetDir = _pickFirstNonEmpty([
    options.into, options.to, options.dir, options.target, positional,
  ]);

  try {
    const result = await _restoreFromSnapshot(targetDir, options);

    if (!result.ok && result.reason === 'no-snapshot') {
      printWarn('未在安装包中找到加密源码快照（_source/snapshot.json）。');
      printInfo('该包可能为旧版本（未内嵌完整源码快照）。');
      printInfo('可改用从已安装运行时负载重建：khy publish origin-code --secret <密钥>');
      _markFailure();
      return false;
    }

    const _cq = result.completeness;
    const _commit = String(result.header.gitCommit || '').slice(0, 12);
    if (_cq && _cq.status === 'incomplete') {
      // 落地数 < 清单数：把假绿降级为诚实告警（仍算还原成功，不 _markFailure）。
      printWarn(`源码已还原到: ${result.dest}（⚠️ 文件数对账不完整）`);
      printWarn(
        `落地 ${_cq.actual} 个文件 · 快照清单 ${_cq.expected} 个 · 缺 ${_cq.missing} 个`
        + ` · commit ${_commit}`
      );
      printInfo('可能磁盘空间不足 / 路径过长(Windows MAX_PATH) / tar 跳过条目；'
        + '建议清空目标目录后加 --force 重试。');
    } else if (_cq && _cq.status === 'over-extracted') {
      // 落地数 > 清单数：目标目录疑有残留文件，据实提示。
      printSuccess(`源码已还原到: ${result.dest}`);
      printWarn(
        `落地 ${_cq.actual} 个文件 · 多于快照清单 ${_cq.expected} 个（目标目录可能有残留）`
        + ` · commit ${_commit}`
      );
    } else {
      // complete（已对账一致）/ unverifiable（证据不足）/ 门关 → 保持原横幅（字节等价旧行为）。
      printSuccess(`源码已完整还原到: ${result.dest}`);
      printInfo(
        `共 ${result.header.fileCount || '?'} 个文件 · `
        + `commit ${_commit} · 目录布局原样`
      );
    }
    // 来源可溯性诚实行（门 default-on）：把「commit X · 目录布局原样」这句会误导的横幅补上
    // 「这份源码到底等于哪个 git 状态」——默认的脏工作树快照 = 提交 X + 未提交增量，不等于干净提交 X。
    // 纯诊断叠加：绝不改变还原成败、绝不 _markFailure；证据不足 / 门关 → 不打行（字节等价）。
    if (_restoreProvenanceEnabled()) {
      try {
        const _pv = assessRestoreProvenance(result.header);
        const _pl = buildProvenanceBannerLine(_pv);
        if (_pl && _pl.line) {
          if (_pl.severity === 'warn') printWarn(_pl.line);
          else printInfo(_pl.line);
        }
      } catch { /* 来源把关异常 → 不打行，横幅字节等价旧行为 */ }
    }
    // 路径可移植性诚实行（门 default-on）：把「哪些条目名在本机文件系统建不出来」从 completeness
    // 事后猜测（"可能路径过长…"）升级为解包前的主动、指名道姓、按宿主系统分级的提示。
    // 纯诊断叠加：绝不改变还原成败、绝不 _markFailure；无危害 / 证据不足 / 门关 → 不打行（字节等价）。
    if (_restorePathPortabilityEnabled() && result.pathPortability) {
      try {
        const _pb = buildPortabilityBannerLine(result.pathPortability, { hostPlatform: _restoreHostPlatform() });
        if (_pb && _pb.line) {
          if (_pb.severity === 'warn') printWarn(_pb.line);
          else printInfo(_pb.line);
        }
      } catch { /* 可移植性把关异常 → 不打行，横幅字节等价旧行为 */ }
    }
    const docInDest = path.join(result.dest, 'docs', RESTORE_DOC_NAME);
    const docInSrc = path.join(result.srcDir, RESTORE_DOC_NAME);
    const docHint = fs.existsSync(docInDest) ? docInDest
      : (fs.existsSync(docInSrc) ? docInSrc : null);
    printInfo('下一步: 进入该目录 → `git init` → 在仓库根 `npm install`。');
    if (docHint) printInfo(`Windows/Linux 重建说明: ${docHint}`);
    return true;
  } catch (err) {
    printError(`源码还原失败: ${err.message || err}`);
    _markFailure();
    return false;
  }
}

// Thin CLI wrapper over the extracted service builder: injects publish.js's own
// print* formatters as the logger so the CLI progress output is byte-for-byte
// unchanged, while the actual build logic lives in the services layer. An explicit
// options.logger (if a caller ever passes one) takes precedence.
function _buildDockerBundle(projectRoot, state, options = {}) {
  return _buildDockerBundleService(projectRoot, state, {
    ...options,
    logger: options.logger || {
      info: printInfo,
      success: printSuccess,
      warn: printWarn,
      error: printError,
    },
  });
}

function _buildPipInstallBundle(projectRoot, state, options = {}) {
  const layout = _resolveInstallLayout(options);
  const installKind = String(layout.installKind || 'pip').toLowerCase() === 'npm' ? 'npm' : 'pip';
  const runtimePkgPath = installKind === 'npm'
    ? path.join(layout.npmBackendDir, 'package.json')
    : path.join(layout.bundledBackendDir, 'package.json');
  const runtimePkg = _readJsonSafe(runtimePkgPath);
  const version = String(runtimePkg.version || state?.versions?.backend || state?.versions?.pyproject || '0.0.0').trim();
  const safeVersion = String(version || '0.0.0').replace(/[^0-9A-Za-z._-]/g, '-');
  const bundlePrefix = installKind === 'npm' ? 'khy-os-npm-install' : 'khy-os-pip-install';
  const bundleName = String(options.name || `${bundlePrefix}-${safeVersion}-${_timestampForFileName()}`).replace(/[^0-9A-Za-z._-]/g, '-');

  const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), `khy-${installKind}-install-bundle-`));
  const bundleRoot = path.join(stagingRoot, bundleName);
  const installRootName = installKind === 'npm' ? 'npm-install' : 'pip-install';
  const installRoot = path.join(bundleRoot, installRootName);
  fs.mkdirSync(installRoot, { recursive: true });

  const sourceMappings = [];
  let backendInBundle = '';
  let backendSource = '';

  if (installKind === 'pip') {
    printInfo(`打包 pip 安装目录: ${layout.siteRoot}`);
    _copyDirForBundle(layout.khyQuantDir, path.join(installRoot, 'khy_platform'), PIP_INSTALL_BUNDLE_SKIP_NAMES);
    _copyDirForBundle(layout.khyOsDir, path.join(installRoot, 'khy_os'), PIP_INSTALL_BUNDLE_SKIP_NAMES);

    sourceMappings.push(
      { target: 'pip-install/khy_platform/', source: layout.khyQuantDir, note: 'Python launcher package from pip install' },
      { target: 'pip-install/khy_os/', source: layout.khyOsDir, note: 'bundled runtime payload from pip install' },
    );

    const distInfoDirs = _collectKhyDistInfoDirs(layout.siteRoot);
    for (const distInfoDir of distInfoDirs) {
      const name = path.basename(distInfoDir);
      _copyDirForBundle(distInfoDir, path.join(installRoot, name), PIP_INSTALL_BUNDLE_SKIP_NAMES);
      sourceMappings.push({
        target: `pip-install/${name}/`,
        source: path.join(layout.siteRoot, name),
        note: 'package metadata',
      });
    }

    backendInBundle = path.join(installRoot, 'khy_os', 'bundled', 'backend');
    backendSource = layout.bundledBackendDir;
  } else {
    printInfo(`打包 npm 安装目录: ${layout.siteRoot}`);
    _copyDirForBundle(layout.npmBackendDir, path.join(installRoot, 'backend'), PIP_INSTALL_BUNDLE_SKIP_NAMES);
    sourceMappings.push({
      target: 'npm-install/backend/',
      source: layout.npmBackendDir,
      note: 'Node backend package from npm install',
    });
    backendInBundle = path.join(installRoot, 'backend');
    backendSource = layout.npmBackendDir;
  }

  if (!_isBackendRoot(backendInBundle)) {
    throw new Error(`${installKind} 安装目录中缺少可用 backend，无法生成 Docker 部署包`);
  }
  _ensureSharedDependencyForBundle(backendInBundle, backendSource);
  _writeDockerBundleDockerfile(backendInBundle);
  const backendContext = installKind === 'npm'
    ? './npm-install/backend'
    : './pip-install/khy_os/bundled/backend';
  _writeDockerBundleCompose(bundleRoot, {
    backendContext,
    serviceName: 'khy-backend',
  });
  _writeDockerBundleEnvExample(bundleRoot);
  _writePipInstallBundleReadme(bundleRoot, {
    siteRoot: layout.siteRoot,
    version,
    serviceName: 'khy-backend',
    installKind,
  });
  _writeInstallLayoutArtifacts(bundleRoot, {
    bundleType: `${installKind}-install-bundle`,
    version,
    focusSubdir: installRootName,
    sourceMappings: [
      ...sourceMappings,
      { target: 'docker-compose.yml', source: '(generated)', note: 'Docker deploy entry' },
      { target: '.env.example', source: '(generated)', note: 'runtime env template' },
      { target: 'README.md', source: '(generated)', note: 'deploy guide' },
    ],
  });

  const archivePath = _buildDockerBundleArchive(
    bundleRoot,
    options.out || options.output || options['out-dir'] || options['output-dir'],
    bundleName
  );

  printSuccess(`${installKind} 安装目录部署包已生成: ${archivePath}`);
  printInfo('接收方部署: 解压后运行 `docker compose up -d --build`');
  return {
    archivePath,
    bundleName,
    siteRoot: layout.siteRoot,
    sourceBackend: backendSource,
    version,
    installKind,
  };
}

function _hasPypircSection(repoName) {
  const pypirc = path.join(os.homedir(), '.pypirc');
  const content = _readFileSafe(pypirc);
  if (!content) return false;
  const section = String(repoName || 'pypi').toLowerCase();
  const re = new RegExp(`^\\s*\\[\\s*${section}\\s*\\]\\s*$`, 'mi');
  return re.test(content);
}

function _resolveToken(targetRepo, options = {}) {
  const byOption = String(
    options.token
    || options['pypi-token']
    || options.pypiToken
    || options.password
    || ''
  ).trim();
  if (byOption) return byOption;

  const envVars = targetRepo === 'testpypi'
    ? ['TEST_PYPI_TOKEN', 'PYPI_TEST_TOKEN', 'PYPI_TOKEN', 'TWINE_PASSWORD']
    : ['PYPI_TOKEN', 'TWINE_PASSWORD'];
  for (const key of envVars) {
    const val = String(process.env[key] || '').trim();
    if (val) return val;
  }
  return '';
}

function _buildUploadEnv(targetRepo, options = {}) {
  const env = { ...process.env };
  const token = _resolveToken(targetRepo, options);
  const explicitUser = String(options.username || process.env.TWINE_USERNAME || '').trim();
  const explicitPass = String(options.password || process.env.TWINE_PASSWORD || '').trim();

  if (token) {
    env.TWINE_USERNAME = '__token__';
    env.TWINE_PASSWORD = token;
  } else if (explicitUser && explicitPass) {
    env.TWINE_USERNAME = explicitUser;
    env.TWINE_PASSWORD = explicitPass;
  }

  return {
    env,
    hasCredential: !!(env.TWINE_USERNAME && env.TWINE_PASSWORD) || _hasPypircSection(targetRepo),
    fromToken: !!token,
  };
}

function _runGitCommandSync(cwd, args, options = {}) {
  const timeout = _toInt(options.timeout, 30000, 1000);
  let result;
  try {
    result = spawnSync('git', args, {
      cwd,
      encoding: 'utf-8',
      timeout,
    });
  } catch (err) {
    throw new Error(`执行 git 失败: ${err.message || err}`);
  }

  if (result.error) {
    throw new Error(`执行 git 失败: ${result.error.message || result.error}`);
  }
  if (result.status !== 0) {
    const stderr = String(result.stderr || '').trim();
    const stdout = String(result.stdout || '').trim();
    const detail = [stderr, stdout].filter(Boolean).join(' | ');
    throw new Error(`git ${args.join(' ')} 失败: ${detail || `exit ${result.status}`}`);
  }
  return String(result.stdout || '').trim();
}

function _canonicalGitRemoteUrl(raw = '') {
  return String(raw || '')
    .trim()
    .replace(/\.git$/i, '')
    .replace(/^https?:\/\//i, '')
    .replace(/^ssh:\/\/git@/i, '')
    .replace(/^git@([^:]+):/i, '$1/')
    .toLowerCase();
}

function _maskRemoteUrl(url = '') {
  return String(url || '').replace(/(:\/\/)([^@/]+)@/g, '$1***@');
}

function _inferGitPlatformFromRepo(repoInput = '') {
  const text = String(repoInput || '').toLowerCase();
  if (!text) return '';
  if (text.includes('gitee.com')) return 'gitee';
  if (text.includes('gitlab.com') || text.includes('gitlab')) return 'gitlab';
  if (text.includes('github.com')) return 'github';
  return '';
}

function _normalizeGitPlatform(rawPlatform = '', repoInput = '') {
  const direct = String(rawPlatform || '').trim().toLowerCase();
  if (direct) {
    if (!SUPPORTED_GIT_PLATFORMS.has(direct)) {
      throw new Error(`不支持的平台: ${rawPlatform}（支持: github | gitee | gitlab）`);
    }
    return direct;
  }
  return _inferGitPlatformFromRepo(repoInput) || 'github';
}

function _normalizeRepoSlug(repoInput = '') {
  const raw = String(repoInput || '').trim();
  if (!raw) return '';

  let slug = raw;
  slug = slug.replace(/^git@[^:]+:/i, '');
  slug = slug.replace(/^ssh:\/\/git@[^/]+\//i, '');
  slug = slug.replace(/^https?:\/\/[^/]+\//i, '');
  slug = slug.replace(/^\/*/, '').replace(/\/*$/, '');
  slug = slug.replace(/\.git$/i, '');
  return slug;
}

function _buildGitRemoteUrl(repoInput, platform, options = {}) {
  const raw = String(repoInput || '').trim();
  if (!raw) return '';
  if (/^[a-z]+:\/\//i.test(raw) || raw.startsWith('git@') || raw.startsWith('ssh://')) {
    return raw;
  }

  const slug = _normalizeRepoSlug(raw);
  if (!slug.includes('/')) {
    throw new Error(`仓库格式不合法: ${repoInput}（示例: owner/repo）`);
  }

  const hostByPlatform = {
    github: 'github.com',
    gitee: 'gitee.com',
    gitlab: 'gitlab.com',
  };
  const host = hostByPlatform[platform] || hostByPlatform.github;
  const preferSsh = _isTruthyFlag(options.ssh) || String(options.protocol || '').trim().toLowerCase() === 'ssh';
  return preferSsh
    ? `git@${host}:${slug}.git`
    : `https://${host}/${slug}.git`;
}

async function _runPublishGitPush(projectRoot, args = [], options = {}) {
  const cwd = path.resolve(options.root || options['project-root'] || projectRoot || process.cwd());
  _runGitCommandSync(cwd, ['rev-parse', '--is-inside-work-tree']);

  const rawPositional = Array.isArray(args) ? args.slice() : [];
  if (rawPositional.length > 0 && GIT_PUSH_ACTIONS.has(String(rawPositional[0]).toLowerCase())) {
    rawPositional.shift();
  }

  const repoInput = String(options.repo || options.url || rawPositional[0] || '').trim();
  const explicitPlatform = String(options.platform || options.provider || '').trim().toLowerCase();
  const platform = _normalizeGitPlatform(explicitPlatform, repoInput);
  const remoteName = String(
    options.remote
    || options['remote-name']
    || (explicitPlatform ? platform : 'origin')
  ).trim() || 'origin';

  const autoCommit = _isTruthyFlag(options['auto-commit']) || _isTruthyFlag(options.autocommit);
  const setUpstream = _isTruthyFlag(options['set-upstream']) || _isTruthyFlag(options.upstream) || _isTruthyFlag(options.u);
  const dryRun = _isTruthyFlag(options['dry-run']);
  const forceWithLease = _isTruthyFlag(options['force-with-lease']) || _isTruthyFlag(options['with-lease']);

  const currentBranch = _runGitCommandSync(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = String(options.branch || options.b || currentBranch || 'main').trim() || 'main';

  const statusBefore = _runGitCommandSync(cwd, ['status', '--porcelain']);
  if (statusBefore && !dryRun) {
    if (!autoCommit) {
      throw new Error('检测到未提交改动。请先提交，或加 --auto-commit 自动提交后推送');
    }
    const commitMessage = String(
      options['commit-message']
      || options.m
      || `chore: sync before publish push (${new Date().toISOString().slice(0, 10)})`
    ).trim();
    printInfo('检测到未提交改动，正在自动提交...');
    _runGitCommandSync(cwd, ['add', '-A']);
    _runGitCommandSync(cwd, ['commit', '-m', commitMessage], { timeout: 120000 });
    printSuccess(`已自动提交: ${commitMessage}`);
  }

  let remoteUrl = '';
  try {
    remoteUrl = _runGitCommandSync(cwd, ['remote', 'get-url', remoteName]);
  } catch {
    remoteUrl = '';
  }

  if (!remoteUrl) {
    if (!repoInput) {
      throw new Error(`远程 ${remoteName} 不存在，且未提供 --repo。示例: --repo owner/repo`);
    }
    const targetUrl = _buildGitRemoteUrl(repoInput, platform, options);
    _runGitCommandSync(cwd, ['remote', 'add', remoteName, targetUrl]);
    remoteUrl = targetUrl;
    printSuccess(`已添加远程: ${remoteName} -> ${_maskRemoteUrl(remoteUrl)}`);
  } else if (repoInput) {
    const targetUrl = _buildGitRemoteUrl(repoInput, platform, options);
    if (_canonicalGitRemoteUrl(remoteUrl) !== _canonicalGitRemoteUrl(targetUrl)) {
      const allowUpdateRemote = _isTruthyFlag(options['force-remote']) || _isTruthyFlag(options['update-remote']);
      if (!allowUpdateRemote) {
        throw new Error(`远程 ${remoteName} 已存在且地址不同。加 --force-remote 可自动更新远程地址`);
      }
      _runGitCommandSync(cwd, ['remote', 'set-url', remoteName, targetUrl]);
      remoteUrl = targetUrl;
      printWarn(`已更新远程 ${remoteName}: ${_maskRemoteUrl(remoteUrl)}`);
    }
  }

  const pushArgs = ['push'];
  if (setUpstream) pushArgs.push('-u');
  if (forceWithLease) pushArgs.push('--force-with-lease');
  pushArgs.push(remoteName, branch);

  printInfo(`准备推送: ${remoteName}/${branch} (${platform})`);
  printInfo(`远程地址: ${_maskRemoteUrl(remoteUrl || '(unknown)')}`);

  if (dryRun) {
    printInfo(`Dry run: git ${pushArgs.join(' ')}`);
    return {
      dryRun: true,
      remoteName,
      remoteUrl,
      branch,
      platform,
    };
  }

  await _runCommandLive('git', pushArgs, {
    cwd,
    activity: `推送到 ${remoteName}/${branch}`,
  });
  printSuccess(`推送完成: ${remoteName}/${branch}`);
  return {
    remoteName,
    remoteUrl,
    branch,
    platform,
  };
}

async function _runCommandLive(command, args, opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const env = opts.env || process.env;
  const activity = opts.activity || `${command} ${args.join(' ')}`;
  const heartbeatMs = _toInt(
    process.env.KHY_ACTIVITY_PULSE_MS || process.env.GATEWAY_ACTIVITY_PULSE_MS,
    HEARTBEAT_MS_DEFAULT,
    3000
  );

  printInfo(`开始: ${activity}`);
  const startedAt = Date.now();

  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timer = setInterval(() => {
      const elapsed = _formatDuration(Date.now() - startedAt);
      printInfo(`${activity} 进行中 (${elapsed})`);
    }, heartbeatMs);
    timer.unref?.();

    const cleanup = () => clearInterval(timer);

    child.stdout.on('data', (buf) => {
      try { process.stdout.write(String(buf)); } catch { /* ignore */ }
    });
    child.stderr.on('data', (buf) => {
      try { process.stderr.write(String(buf)); } catch { /* ignore */ }
    });
    child.on('error', (err) => {
      cleanup();
      reject(err);
    });
    child.on('close', (code) => {
      cleanup();
      if (code === 0) {
        printSuccess(`完成: ${activity}`);
        resolve();
      } else {
        reject(new Error(`${activity} 失败 (exit ${code})`));
      }
    });
  });
}

async function _runSelfBugFix(options = {}) {
  const maxRounds = _toInt(options['max-rounds'] || options.maxRounds, 5, 1);
  const autoFix = options['auto-fix'] !== false && String(options['auto-fix'] || '').toLowerCase() !== 'false';
  const autoApprove = _isTruthyFlag(options.yes) || _isTruthyFlag(options['auto-approve']) || _isTruthyFlag(options.autoApprove);

  printInfo(`自修复流程启动: review -> fix -> verify (maxRounds=${maxRounds})`);
  const { handleReview } = require('./review');
  await handleReview({
    maxRounds,
    autoFix,
    autoApprove,
    yes: autoApprove,
  });
}

async function _runSelfPipPublish(selfAction, options = {}) {
  const skipFix = _isTruthyFlag(options['skip-fix']) || _isTruthyFlag(options.skipFix);
  if (!skipFix) {
    await _runSelfBugFix(options);
  } else {
    printWarn('已跳过自修复阶段（--skip-fix）');
  }

  const targetRepo = String(selfAction || '').toLowerCase() === 'self-testpypi' ? 'testpypi' : 'pypi';
  const nextOptions = {
    ...options,
    yes: options.yes !== undefined ? options.yes : true,
  };
  delete nextOptions['skip-fix'];
  delete nextOptions.skipFix;

  printInfo(`进入自发布阶段: 发布到 ${targetRepo}`);
  return handlePublish(targetRepo, [], nextOptions);
}

function _printState(state) {
  printInfo(`项目目录: ${state.projectRoot}`);
  printInfo(`包名: ${state.packageName || '(未读取到)'}`);
  printInfo(`版本(pyproject): ${state.versions.pyproject || '-'}`);
  printInfo(`版本(khy_platform): ${state.versions.python || '-'}`);
  printInfo(`版本(backend): ${state.versions.backend || '-'}`);
  if (!state.versionAligned) {
    printWarn('版本号未对齐（pyproject / khy_platform / backend 不一致）');
    printInfo('可用 --version <x.y.z> 一键同步版本');
  }
}

function _printHelp() {
  console.log('');
  console.log('  用法:');
  console.log('    khy publish check [--root <path>]');
  console.log('    khy publish build [--root <path>] [--clean]');
  console.log('    khy publish pypi [--version <x.y.z>] [--yes] [--skip-build]');
  console.log('    khy publish testpypi [--version <x.y.z>] [--yes] [--skip-build]');
  console.log('    khy publish docker-bundle [--out <dir>] [--name <bundle-name>]');
  console.log('    khy publish pip-dir-bundle [--out <dir>] [--name <bundle-name>] [--pip-root <site-packages>]');
  console.log('    khy publish npm-dir-bundle [--out <dir>] [--name <bundle-name>] [--npm-root <path>]');
  console.log('    khy publish origin-code [--out <dir>] [--name <bundle-name>] [--pip-root <site-packages>] [--npm-root <path>]');
  console.log('    khy publish self-fix [--max-rounds <n>] [--yes]');
  console.log('    khy publish self-pypi [--version <x.y.z>] [--skip-fix] [--yes]');
  console.log('    khy publish self-testpypi [--version <x.y.z>] [--skip-fix] [--yes]');
  console.log('    khy publish git-push [<owner/repo|remote-url>] [--platform github|gitee|gitlab]');
  console.log('');
  console.log('  常用参数:');
  console.log('    --version <x.y.z>     同步 3 处版本号后再构建');
  console.log('    --yes                 跳过上传确认（CI/自动化）');
  console.log('    --token <token>       指定 PyPI token（也可用环境变量）');
  console.log('    --skip-build          直接上传 dist/*');
  console.log('    --skip-db-preflight   跳过自动迁移预检');
  console.log('    --strict-db-preflight 自动迁移预检失败时中止');
  console.log('    --root <path>         指定项目根目录');
  console.log('    --out <dir>           导出包输出目录（docker 默认 dist/docker-bundles，origin 默认 dist/origin-code）');
  console.log('    --name <bundle-name>  导出包名称（不含扩展名）');
  console.log('    --install <auto|pip|npm> 安装布局探测模式（默认 auto）');
  console.log('    --pip-root <path>     指定 pip 安装根目录(site-packages)');
  console.log('    --npm-root <path>     指定 npm 安装根目录（backend 或其上级）');
  console.log('    --repo <owner/repo>   Git 远程仓库（也支持完整 SSH/HTTPS URL）');
  console.log('    --platform <name>     github | gitee | gitlab');
  console.log('    --remote <name>       Git 远程名（默认 origin 或平台名）');
  console.log('    --branch <name>       推送分支（默认当前分支）');
  console.log('    --auto-commit         推送前自动 add+commit 所有改动');
  console.log('    --set-upstream        push 时附加 -u');
  console.log('    --force-remote        远程同名但 URL 不同，自动 set-url');
  console.log('    --dry-run             演练模式：git 仅打印推送命令；PyPI/TestPyPI 仅检查并打印上传命令，不实际上传');
  console.log('    --max-rounds <n>      自修复轮数上限（self-fix/self-pypi）');
  console.log('    --skip-fix            自发布时跳过自修复阶段');
  console.log('    --auto-approve        自修复自动确认（与 --yes 等价）');
  console.log('    --secret <value>      源码还原密钥（仅用于还原由自定义密钥加密的旧快照；发布不再需要密钥）');
  console.log('    --owner-secret <value> 同 --secret');
  console.log('');
  console.log('  环境变量:');
  console.log('    PYPI_TOKEN / TEST_PYPI_TOKEN / TWINE_USERNAME / TWINE_PASSWORD');
  console.log('    KHY_SOURCE_PUBLISH_SECRET / KHY_OWNER_SECRET');
  console.log('    KHY_PYTHON / KHY_ACTIVITY_PULSE_MS / KHY_PUBLISH_SKIP_DB_PREFLIGHT');
  console.log('');
}

async function _runDbMigrationPreflight(options = {}) {
  const skip = _isTruthyFlag(options['skip-db-preflight']) || _isTruthyFlag(process.env.KHY_PUBLISH_SKIP_DB_PREFLIGHT);
  if (skip) {
    printWarn('已跳过自动迁移预检');
    return { skipped: true };
  }

  const strict = _isTruthyFlag(options['strict-db-preflight']) || _isTruthyFlag(process.env.KHY_PUBLISH_STRICT_DB_PREFLIGHT);
  try {
    const { runAutoDbMigration } = require('../../bootstrap/dbAutoMigration');
    const result = await runAutoDbMigration({
      force: true,
      silent: true,
      reason: 'publish-preflight',
    });
    if (result && result.error) {
      const message = `自动迁移预检失败: ${result.error}`;
      if (strict) throw new Error(message);
      printWarn(`${message}（继续发布，可加 --strict-db-preflight 阻止发布）`);
      return { ok: false, error: result.error };
    }
    printInfo('自动迁移预检通过');
    return { ok: true };
  } catch (err) {
    const message = err && err.message ? err.message : String(err || 'unknown');
    if (strict) throw new Error(`自动迁移预检失败: ${message}`);
    printWarn(`自动迁移预检异常: ${message}（继续发布）`);
    return { ok: false, error: message };
  }
}

async function _confirmUpload(targetRepo, packageName, version, options) {
  if (options.yes || options.confirm) return true;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    printError('非交互环境请加 --yes 确认上传');
    return false;
  }
  const answer = await promptCompat([{
    type: 'confirm',
    name: 'ok',
    default: false,
    message: `确认上传 ${packageName || 'package'} ${version || ''} 到 ${targetRepo} ?`,
  }]);
  return !!answer.ok;
}

async function _runBuildAndCheck(projectRoot, pythonCmd, cleanDist) {
  if (cleanDist) {
    const distPath = path.join(projectRoot, 'dist');
    if (fs.existsSync(distPath)) {
      fs.rmSync(distPath, { recursive: true, force: true });
      printInfo('已清理 dist/');
    }
  }

  try {
    await _runCommandLive(pythonCmd, ['-m', 'build'], {
      cwd: projectRoot,
      activity: '构建 Python 包',
    });
  } catch (firstErr) {
    printWarn('隔离构建失败，尝试使用 --no-isolation 离线构建...');
    await _runCommandLive(pythonCmd, ['-m', 'build', '--no-isolation'], {
      cwd: projectRoot,
      activity: '构建 Python 包(无隔离)',
    });
  }

  const artifacts = _collectDistArtifacts(projectRoot);
  if (artifacts.length === 0) {
    throw new Error('构建完成但 dist/ 下未找到可发布产物');
  }
  printInfo(`构建产物: ${artifacts.join(', ')}`);

  await _runCommandLive(pythonCmd, ['-m', 'twine', 'check', ...artifacts], {
    cwd: projectRoot,
    activity: '校验构建产物(twine check)',
  });
  return artifacts;
}

async function handlePublish(subCommand, args = [], options = {}) {
  const fallbackAction = String(args[0] || '').toLowerCase();
  const action = String(subCommand || fallbackAction || '').toLowerCase() || 'pypi';
  if (![
    'check', 'build', 'pypi', 'testpypi', 'help',
    ...DOCKER_BUNDLE_ACTIONS,
    ...PIP_INSTALL_BUNDLE_ACTIONS,
    ...NPM_INSTALL_BUNDLE_ACTIONS,
    ...ORIGIN_CODE_ACTIONS,
    ...RESTORE_ACTIONS,
    ...GIT_PUSH_ACTIONS,
    ...SELF_FIX_ACTIONS,
    ...SELF_PUBLISH_ACTIONS,
  ].includes(action)) {
    printError(`未知 publish 子命令: ${action}`);
    _printHelp();
    _markFailure();
    return false;
  }
  if (action === 'help') {
    _printHelp();
    return true;
  }

  const startDir = options.root || options['project-root'] || process.cwd();
  const projectRoot = _findProjectRoot(startDir);

  let state = _readState(projectRoot);

  if (DOCKER_BUNDLE_ACTIONS.has(action)) {
    printInfo(`项目目录: ${projectRoot}`);
    try {
      _buildDockerBundle(projectRoot, state, options);
      return true;
    } catch (err) {
      printError(`Docker 部署包生成失败: ${err.message || err}`);
      _markFailure();
      return false;
    }
  }

  if (PIP_INSTALL_BUNDLE_ACTIONS.has(action)) {
    printInfo(`项目目录: ${projectRoot}`);
    try {
      _buildPipInstallBundle(projectRoot, state, options);
      return true;
    } catch (err) {
      printError(`pip 安装目录部署包生成失败: ${err.message || err}`);
      _markFailure();
      return false;
    }
  }

  if (NPM_INSTALL_BUNDLE_ACTIONS.has(action)) {
    printInfo(`项目目录: ${projectRoot}`);
    try {
      _buildPipInstallBundle(projectRoot, state, {
        ...options,
        install: options.install || 'npm',
      });
      return true;
    } catch (err) {
      printError(`npm 安装目录部署包生成失败: ${err.message || err}`);
      _markFailure();
      return false;
    }
  }

  if (RESTORE_ACTIONS.has(action)) {
    // `khy publish restore` — same code path as the top-level `khy restore`.
    return handleRestore(args.slice(1), options);
  }

  if (ORIGIN_CODE_ACTIONS.has(action)) {
    printInfo(`项目目录: ${projectRoot}`);
    try {
      // Source publishing is no longer password-gated — always emit the full,
      // real source bundle.
      _buildOriginCodeBundle(projectRoot, state, { ...options });
      return true;
    } catch (err) {
      printError(`origin code 还原包生成失败: ${err.message || err}`);
      _markFailure();
      return false;
    }
  }

  if (GIT_PUSH_ACTIONS.has(action)) {
    printInfo(`项目目录: ${projectRoot}`);
    try {
      // No password gate: push the real source for real (no forced dry-run).
      await _runPublishGitPush(projectRoot, args, { ...options });
      return true;
    } catch (err) {
      printError(`Git 推送失败: ${err.message || err}`);
      _markFailure();
      return false;
    }
  }

  if (SELF_FIX_ACTIONS.has(action)) {
    printInfo(`项目目录: ${projectRoot}`);
    try {
      await _runSelfBugFix(options);
      printSuccess('自修复流程执行完成');
      return true;
    } catch (err) {
      printError(`自修复失败: ${err.message || err}`);
      _markFailure();
      return false;
    }
  }

  if (SELF_PUBLISH_ACTIONS.has(action)) {
    printInfo(`项目目录: ${projectRoot}`);
    try {
      const normalized = action === 'self-release' ? 'self-pypi' : action;
      const ok = await _runSelfPipPublish(normalized, options);
      return !!ok;
    } catch (err) {
      printError(`自发布失败: ${err.message || err}`);
      _markFailure();
      return false;
    }
  }

  _printState(state);

  if (options.version) {
    _updateVersions(projectRoot, options.version);
    printSuccess(`版本已同步为 ${options.version}`);
    state = _readState(projectRoot);
    _printState(state);
  }

  const pythonCmd = _detectPython();
  if (!pythonCmd) {
    printError('未找到 Python 解释器（python3/python）');
    _markFailure();
    return false;
  }
  printInfo(`Python: ${pythonCmd}`);

  if (!_moduleReady(pythonCmd, 'build')) {
    printError('未安装 build 模块');
    printInfo(`运行: ${pythonCmd} -m pip install build`);
    _markFailure();
    return false;
  }
  if (!_moduleReady(pythonCmd, 'twine')) {
    printError('未安装 twine 模块');
    printInfo(`运行: ${pythonCmd} -m pip install twine`);
    _markFailure();
    return false;
  }

  if (!state.versionAligned && !options.force) {
    printError('版本未对齐，已中止。请使用 --version <x.y.z> 同步后重试，或加 --force 跳过。');
    _markFailure();
    return false;
  }

  try {
    await _runDbMigrationPreflight(options);
  } catch (err) {
    printError(err.message || String(err));
    _markFailure();
    return false;
  }

  if (action === 'check') {
    printSuccess('发布前检查通过');
    return true;
  }

  try {
    const cleanDist = options.clean !== false && String(options.clean || '').toLowerCase() !== 'false';
    if (action === 'build') {
      await _runBuildAndCheck(projectRoot, pythonCmd, cleanDist);
      printSuccess('构建流程完成');
      return true;
    }

    const targetRepo = action === 'testpypi' ? 'testpypi' : 'pypi';
    const uploadReady = _buildUploadEnv(targetRepo, options);
    if (!uploadReady.hasCredential) {
      printError(`未检测到 ${targetRepo} 上传凭据`);
      printInfo('可用方式:');
      printInfo('  1) 设置 PYPI_TOKEN / TEST_PYPI_TOKEN');
      printInfo('  2) 或配置 ~/.pypirc');
      printInfo('  3) 或命令加 --token <token>');
      _markFailure();
      return false;
    }

    const confirmed = await _confirmUpload(
      targetRepo,
      state.packageName,
      state.versions.pyproject,
      options
    );
    if (!confirmed) {
      printWarn('已取消上传');
      _markFailure();
      return false;
    }

    let artifacts = _collectDistArtifacts(projectRoot);
    const skipBuild = options['skip-build'] === true || String(options['skip-build'] || '').toLowerCase() === 'true';
    if (!skipBuild) {
      artifacts = await _runBuildAndCheck(projectRoot, pythonCmd, cleanDist);
    } else if (artifacts.length === 0) {
      printError('指定了 --skip-build，但 dist/ 下没有可上传文件');
      _markFailure();
      return false;
    }

    const uploadArgs = ['-m', 'twine', 'upload'];
    if (targetRepo === 'testpypi') {
      uploadArgs.push('--repository', 'testpypi');
    } else {
      uploadArgs.push('--repository', 'pypi');
    }
    const skipExisting = options['skip-existing'] !== false && String(options['skip-existing'] || '').toLowerCase() !== 'false';
    if (skipExisting) uploadArgs.push('--skip-existing');
    if (options['non-interactive'] || options.nonInteractive) uploadArgs.push('--non-interactive');
    uploadArgs.push(...artifacts);

    const uploadDryRun = _isTruthyFlag(options['dry-run']) || _isTruthyFlag(options.dryRun);
    if (uploadDryRun) {
      printInfo(`Dry run: ${pythonCmd} ${uploadArgs.join(' ')}`);
      printInfo(`Dry run: 目标仓库=${targetRepo}，产物数量=${artifacts.length}`);
      printSuccess('发布演练完成（未执行上传）');
      return true;
    }

    await _runCommandLive(pythonCmd, uploadArgs, {
      cwd: projectRoot,
      env: uploadReady.env,
      activity: `上传到 ${targetRepo}`,
    });

    const ver = state.versions.pyproject || '(unknown version)';
    printSuccess(`发布完成: ${state.packageName || 'package'} ${ver} -> ${targetRepo}`);
    // Close the release loop: post-verify all-green now auto-blesses (登记稳定版),
    // so the rollback target is recorded without the maintainer remembering it.
    // We point at it rather than auto-running heavy verification inside upload.
    printInfo('下一步（闭环「发布即登记稳定版」）：node maintenance/lib/ops.js post-verify');
    printInfo('  验证全绿会自动 bless，把本次版本登记为回滚目标（关闭自动登记设 KHY_AUTO_BLESS=0）。');
    return true;
  } catch (err) {
    printError(`发布失败: ${err.message || err}`);
    _markFailure();
    return false;
  }
}

module.exports = {
  handlePublish,
  // Top-level `khy restore` — decrypt + extract the embedded full-source snapshot.
  handleRestore,
  _restoreFromSnapshot,
  // Exposed for testability / reuse
  _findProjectRoot,
  _readState,
  _updateVersions,
  _detectPython,
  _runDbMigrationPreflight,
  // Exposed so the deploy orchestrator can build a Docker bundle and read back
  // its archivePath/bundleName directly instead of parsing CLI stdout.
  _buildDockerBundle,
};
