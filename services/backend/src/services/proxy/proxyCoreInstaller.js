'use strict';

/**
 * proxyCoreInstaller.js — 「装完即用」mihomo(clash-meta)内核自动获取器(single source of truth)。
 *
 * 背景(用户诉求 2026-07-11「pip/npm 安装后自动装 mihomo」):raw 协议节点(vmess/vless/trojan/ss/ssr)
 * 需本机内核承载。proxyCoreManager.start() 在二进制缺失时返回 core-missing 指引 —— 对小白/单机用户
 * 仍是一道手动坎。本模块把「获取内核」这一步自动化,让选中 raw 节点即用。
 *
 * 获取优先级(从最安全到需联网,逐级降级,任一成功即停):
 *   1) 已装:BINARY_PATH 已存在可执行文件 → 直接复用(method:'existing')。
 *   2) 采纳本机现成内核(**不联网、离线可证**):若 PATH 上已有 mihomo/clash-meta(用户自己经包管理器
 *      装过、已建立信任),复制进 ~/.khyquant/bin 并赋可执行权限(method:'adopted')。
 *   3) 官方 HTTPS 固定版本下载(门 KHY_PROXY_CORE_AUTO_INSTALL,default-on):从
 *      github.com/MetaCubeX/mihomo 的**固定版本**资产 URL 下载 —— 这与 pip/npm 下载 khy 本体是**同一
 *      信任模型**(TLS 认证 github.com + 固定版本/资产路径 = 已知工件)。下载复用 deviceAppsDownloader
 *      (SSRF 守卫 + 仅 http(s) + 逐跳重定向主机名封锁 + 字节级进度)。
 *
 * 完整性(诚实边界,B2 纪律):
 *   - ASSETS[*].sha256 是**可选**的纵深防御指纹。为真实值时 → 对下载的压缩包做 SHA256 校验,不符即
 *     **fail-closed**(删除临时文件、绝不解压、绝不 chmod、绝不落地),防 GitHub 侧工件被替换。
 *   - 为 null 时 → 退化为「官方 HTTPS 固定 URL」的传输级完整性(等同包管理器下载 khy 本体的信任),
 *     method 标 'downloaded'、integrity 标 'https-official' —— 如实告知,绝不谎称已做指纹校验。
 *   - 真实指纹在发布期由维护者填入 ASSETS(有网机器 `sha256sum <asset.gz>`),填后自动升级为
 *     'sha256-pinned'。**本仓不预置伪造指纹**(错误指纹会让自动安装永远静默失败)。
 *
 * 诚实边界(续):真实隧道 E2E 需有网机器,无法在离线沙盒证绿;故所有 IO 依赖(fs / 下载 / 解压 /
 * 哈希 / spawn / 平台探测)经 _deps 注入,测试喂 fake 即可全离线证明「采纳/下载/校验/解压/落地/
 * fail-closed/门控回退」全链路。绝不抛:任何失败 fail-soft 返回结构化结果。
 *
 * 门控 KHY_PROXY_CORE_AUTO_INSTALL(default-on,仅 0/false/off/no 关):关 → 联网下载一步被跳过
 *   (采纳本机现成内核仍尝试,因其零联网、零风险);彻底关闭自动获取请同时不装本机内核。
 *
 * @module services/proxy/proxyCoreInstaller
 */

const path = require('path');
const os = require('os');
const zlib = require('zlib');
const crypto = require('crypto');

const { isFlagEnabled } = require('../flagRegistry');

const FLAG = 'KHY_PROXY_CORE_AUTO_INSTALL';

// 固定内核版本(发布期 bump)。URL 走官方 GitHub HTTPS 固定资产路径。
const PINNED_VERSION = 'v1.18.10';
const RELEASE_BASE = `https://github.com/MetaCubeX/mihomo/releases/download/${PINNED_VERSION}`;

// 平台(process.platform:process.arch)→ 资产映射。
// linux-amd64 取 `-compatible`(v1 微架构,兼容性最好,避开老 CPU 上 v3 指令集崩溃)。
// kind:'gz' 走 zlib.gunzip 原生解压(零新依赖);win 的 .zip 需外部解压 → 当前给手动指引(不静默失败)。
// sha256:null = 未预置指纹(见文件头「完整性」诚实边界),下载退化为 HTTPS 传输级完整性。
const ASSETS = {
  'linux:x64': { file: `mihomo-linux-amd64-compatible-${PINNED_VERSION}.gz`, kind: 'gz', sha256: null },
  'linux:arm64': { file: `mihomo-linux-arm64-${PINNED_VERSION}.gz`, kind: 'gz', sha256: null },
  'darwin:x64': { file: `mihomo-darwin-amd64-${PINNED_VERSION}.gz`, kind: 'gz', sha256: null },
  'darwin:arm64': { file: `mihomo-darwin-arm64-${PINNED_VERSION}.gz`, kind: 'gz', sha256: null },
  'win32:x64': { file: `mihomo-windows-amd64-${PINNED_VERSION}.zip`, kind: 'zip', sha256: null },
};

// PATH 上可能的现成内核可执行名(mihomo 系 + clash-meta 历史名)。
const PATH_CANDIDATES = ['mihomo', 'clash-meta', 'clash.meta', 'Clash.Meta', 'clash'];

// 可注入依赖(测试喂 fake;生产用真实模块)。
const _deps = {
  fs: require('fs'),
  spawnSync: require('child_process').spawnSync,
  gunzip: (buf) => zlib.gunzipSync(buf),
  sha256: (buf) => crypto.createHash('sha256').update(buf).digest('hex'),
  download: (url, dest, onProgress, opts) =>
    require('../deviceApps/deviceAppsDownloader').downloadWithProgress(url, dest, onProgress, opts),
  isFlagEnabled,
  platform: () => process.platform,
  arch: () => process.arch,
  homedir: () => os.homedir(),
  env: () => process.env,
};

/** 测试注入钩子:浅合并覆盖依赖,返回还原函数。 */
function _setDeps(overrides = {}) {
  const prev = {};
  for (const k of Object.keys(overrides)) {
    prev[k] = _deps[k];
    _deps[k] = overrides[k];
  }
  return function restore() {
    for (const k of Object.keys(prev)) _deps[k] = prev[k];
  };
}

/** 门是否开(default-on;不可用时 fail-closed 视为关,因联网下载是需谨慎的对外动作)。 */
function isEnabled(env) {
  try {
    return _deps.isFlagEnabled(FLAG, env || _deps.env());
  } catch {
    return false;
  }
}

/** 内核落地路径(与 proxyCoreManager.BINARY_PATH 同一处;由 _binaryPath ⟷ manager 的一致性测护住)。 */
function _binaryPath() {
  const name = _deps.platform() === 'win32' ? 'mihomo.exe' : 'mihomo';
  return path.join(_deps.homedir(), '.khyquant', 'bin', name);
}

/** 目标是否已装(可执行)。 */
function isInstalled() {
  try {
    _deps.fs.accessSync(_binaryPath(), _deps.fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** 解析当前平台的资产(含完整 URL);不支持的平台 → null。 */
function resolveAsset(platform, arch) {
  const key = `${platform}:${arch}`;
  const a = ASSETS[key];
  if (!a) return null;
  return { file: a.file, kind: a.kind, sha256: a.sha256, url: `${RELEASE_BASE}/${a.file}`, key };
}

/**
 * 「内核从哪里下载」人可读描述符(纯函数·零 IO·绝不抛)——本模块既是自动下载的 SSOT
 * (PINNED_VERSION / RELEASE_BASE / ASSETS / 落地路径),就该是**告诉人去哪下**的唯一真源。
 *
 * 背景(用户诉求 2026-07-13「网页中代理的二进制要去哪里下载」):此前 core-missing 指引与前端
 * 横幅都只说「请下载 mihomo 放到 ~/.khyquant/bin/」却**从不给 URL**,而确切官方固定 URL 早已
 * 在本文件里(ASSETS + RELEASE_BASE)。这是「能力存在但没接线」:数据在,却没接到人面前。
 * 本函数把它拼成一个描述符,供 coreManager.getStatus 与前端横幅原样呈现,不再让用户自己猜。
 *
 * @param {string} [platform] 覆盖平台探测(缺省用真实 process.platform),便于单机演练全宿主。
 * @param {string} [arch] 覆盖架构探测。
 * @returns {{
 *   version: string, releasesPage: string, binDir: string, dest: string,
 *   supported: boolean, assetFile?: string, url?: string, kind?: string,
 *   platform: string, arch: string,
 * }} supported=false 时(冷门平台)无 url/assetFile,但 releasesPage/dest 始终给,永远给得出下一步。
 */
function describeCoreDownload(platform, arch) {
  const p = platform || _deps.platform();
  const a = arch || _deps.arch();
  const dest = _binaryPath();
  const binDir = path.dirname(dest);
  const base = {
    version: PINNED_VERSION,
    releasesPage: 'https://github.com/MetaCubeX/mihomo/releases',
    binDir,
    dest,
    platform: p,
    arch: a,
  };
  const asset = resolveAsset(p, a);
  if (!asset) {
    // 冷门平台无预置资产:仍给 releases 总页 + 落地路径,让用户自选对应资产,绝不留死路。
    return { ...base, supported: false };
  }
  return {
    ...base,
    supported: true,
    assetFile: asset.file,
    url: asset.url,
    kind: asset.kind,
  };
}

function _safeUnlink(p) {
  try {
    _deps.fs.unlinkSync(p);
  } catch {
    /* ignore */
  }
}

/** 在 PATH 上查现成内核可执行文件,返回首个命中的绝对路径,或 null。 */
function _whichCore() {
  const isWin = _deps.platform() === 'win32';
  const finder = isWin ? 'where' : 'which';
  for (const name of PATH_CANDIDATES) {
    try {
      const r = _deps.spawnSync(finder, [name], { encoding: 'utf-8', timeout: 5000 });
      if (r && r.status === 0 && r.stdout) {
        const first = String(r.stdout)
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean)[0];
        if (first) return first;
      }
    } catch {
      /* 单个候选查失败不影响其余 */
    }
  }
  return null;
}

/**
 * 采纳本机 PATH 上现成的 mihomo/clash-meta(零联网、零风险)。
 * @returns {{success:boolean, method?:string, path?:string, source?:string, reason?:string, error?:string}}
 */
function adoptFromPath() {
  const src = _whichCore();
  if (!src) return { success: false, reason: 'not-on-path' };
  try {
    const dest = _binaryPath();
    _deps.fs.mkdirSync(path.dirname(dest), { recursive: true });
    const buf = _deps.fs.readFileSync(src);
    _deps.fs.writeFileSync(dest, buf);
    try {
      _deps.fs.chmodSync(dest, 0o755);
    } catch {
      /* windows 无 chmod 概念 */
    }
    return { success: true, method: 'adopted', path: dest, source: src };
  } catch (err) {
    return { success: false, reason: 'adopt-failed', error: err && err.message ? err.message : String(err) };
  }
}

/**
 * 从官方 HTTPS 固定版本下载并落地内核(门控 + 完整性 + fail-closed)。
 * @param {{ env?:object, onProgress?:Function, timeoutMs?:number }} [opts]
 * @returns {Promise<object>} 结构化结果,绝不抛。
 */
async function downloadCore(opts = {}) {
  const env = opts.env || _deps.env();
  if (!isEnabled(env)) return { success: false, reason: 'disabled' };

  const asset = resolveAsset(_deps.platform(), _deps.arch());
  if (!asset) {
    return { success: false, reason: 'unsupported-platform', platform: _deps.platform(), arch: _deps.arch() };
  }
  const dest = _binaryPath();
  if (asset.kind !== 'gz') {
    // .zip(win)需外部解压,当前给手动指引而非静默失败。
    return {
      success: false,
      reason: 'unpack-unsupported',
      guidance: `请手动下载 ${asset.url},解压出 mihomo.exe 放到 ${dest}`,
      url: asset.url,
    };
  }

  const tmp = `${dest}.download`;
  try {
    _deps.fs.mkdirSync(path.dirname(dest), { recursive: true });
  } catch (err) {
    return { success: false, reason: 'mkdir-failed', error: err && err.message ? err.message : String(err) };
  }
  _safeUnlink(tmp); // 清理可能的上次残留

  // 1) 下载压缩包到临时文件(SSRF 守卫等由 deviceAppsDownloader 承担)。
  try {
    await _deps.download(asset.url, tmp, opts.onProgress, { timeoutMs: opts.timeoutMs });
  } catch (err) {
    _safeUnlink(tmp);
    return { success: false, reason: 'download-failed', error: err && err.message ? err.message : String(err), url: asset.url };
  }

  // 2) 读回压缩字节。
  let comp;
  try {
    comp = _deps.fs.readFileSync(tmp);
  } catch (err) {
    _safeUnlink(tmp);
    return { success: false, reason: 'read-failed', error: err && err.message ? err.message : String(err) };
  }

  // 3) 可选 SHA256 纵深防御(校验压缩包本身 = GitHub 分发的工件)。不符 → fail-closed。
  if (asset.sha256) {
    let digest;
    try {
      digest = _deps.sha256(comp);
    } catch (err) {
      _safeUnlink(tmp);
      return { success: false, reason: 'hash-failed', error: err && err.message ? err.message : String(err) };
    }
    if (String(digest).toLowerCase() !== String(asset.sha256).toLowerCase()) {
      _safeUnlink(tmp);
      return { success: false, reason: 'sha256-mismatch', expected: asset.sha256, actual: digest, url: asset.url };
    }
  }

  // 4) 解压 → 二进制。
  let bin;
  try {
    bin = _deps.gunzip(comp);
  } catch (err) {
    _safeUnlink(tmp);
    return { success: false, reason: 'unpack-failed', error: err && err.message ? err.message : String(err) };
  }

  // 5) 落地 + 赋可执行权限。
  try {
    _deps.fs.writeFileSync(dest, bin);
    try {
      _deps.fs.chmodSync(dest, 0o755);
    } catch {
      /* windows */
    }
  } catch (err) {
    _safeUnlink(tmp);
    return { success: false, reason: 'write-failed', error: err && err.message ? err.message : String(err) };
  }
  _safeUnlink(tmp);
  return {
    success: true,
    method: asset.sha256 ? 'downloaded-verified' : 'downloaded',
    integrity: asset.sha256 ? 'sha256-pinned' : 'https-official',
    path: dest,
    url: asset.url,
    version: PINNED_VERSION,
  };
}

/**
 * 编排:已装 → 采纳本机 → 联网下载(门控)。绝不抛,fail-soft 返回结构化结果。
 * @param {{ env?:object, onProgress?:Function, timeoutMs?:number }} [opts]
 * @returns {Promise<object>}
 */
async function install(opts = {}) {
  try {
    if (isInstalled()) return { success: true, method: 'existing', path: _binaryPath() };

    // 采纳本机现成内核(零联网,永远尝试)。
    const adopted = adoptFromPath();
    if (adopted.success) return adopted;

    // 联网下载(门控)。
    const env = opts.env || _deps.env();
    if (!isEnabled(env)) {
      return {
        success: false,
        reason: 'disabled',
        guidance: `自动下载内核未启用(${FLAG}=0)。请手动下载 mihomo 放到 ${_binaryPath()},`
          + `或设 ${FLAG}=1 后重试。`,
      };
    }
    return await downloadCore(opts);
  } catch (err) {
    // 兜底 fail-soft:绝不让自动安装阻断上层流程。
    return { success: false, reason: 'error', error: err && err.message ? err.message : String(err) };
  }
}

module.exports = {
  install,
  downloadCore,
  adoptFromPath,
  isInstalled,
  isEnabled,
  resolveAsset,
  describeCoreDownload,
  FLAG,
  PINNED_VERSION,
  RELEASE_BASE,
  ASSETS,
  PATH_CANDIDATES,
  _binaryPath,
  _setDeps,
};
