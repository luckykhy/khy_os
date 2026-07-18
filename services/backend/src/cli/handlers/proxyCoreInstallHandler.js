'use strict';

/**
 * proxy core CLI face — an explicit, headless-friendly surface for the mihomo
 * proxy-core install capability.
 *
 * Why this leaf exists: `proxyCoreInstaller.install()` (adopt-local / gated
 * official-HTTPS download + SHA256 verify + land in ~/.khyquant/bin/) was fully
 * built and tested, but its ONLY caller was `proxyCoreManager.start(node)` —
 * i.e. it fired as a side-effect of *starting a raw node* that lacked the
 * binary. A fresh headless / off-machine user (pip install, no Web UI) had no
 * way to *proactively* provision the core without first configuring and
 * starting a vmess/vless node. This wires the capability to an explicit
 * command: `khy proxy core install` / `khy proxy core status`.
 *
 * Every non-success path surfaces the exact official download URL + landing
 * path (via proxyCoreInstaller.describeCoreDownload), so the user is never left
 * stuck — matching the "去哪下载" transparency contract already on the Web
 * banner and `khy doctor`.
 *
 * HOW-TO-EXTEND: to add an action, (1) write a pure `formatXxx(result)` mapper
 * here (result object → string[]), and (2) add an `action === 'xxx'` branch in
 * runCore(). Keep formatters pure (no network/FS) so they stay node:test-safe.
 */

const DEFAULT_INSTALLER = () => require('../../services/proxy/proxyCoreInstaller');

/**
 * Where-to-download tail lines (pure). Always yields the official URL (or the
 * releases page for cold platforms) + the exact landing path.
 * @param {object|null} descriptor proxyCoreInstaller.describeCoreDownload() result
 * @returns {string[]}
 */
function formatDownloadHint(descriptor) {
  const lines = [];
  if (!descriptor || typeof descriptor !== 'object') return lines;
  const url = descriptor.url || descriptor.releasesPage;
  const ver = descriptor.version ? ` ${descriptor.version}` : '';
  if (url) lines.push(`  下载地址(mihomo${ver}): ${url}`);
  if (descriptor.dest) lines.push(`  放入路径: ${descriptor.dest}`);
  if (descriptor.supported === false) {
    lines.push('  当前平台无预置资产,请在 releases 页自选对应架构手动下载。');
  }
  return lines;
}

/**
 * Map an install() result to a small render descriptor (pure).
 * @param {object} result proxyCoreInstaller.install() structured result
 * @param {object|null} descriptor describeCoreDownload() result (for the failure tail)
 * @returns {{ok:boolean, lines:string[]}}
 */
function formatCoreInstallResult(result, descriptor) {
  const r = result && typeof result === 'object' ? result : { success: false, reason: 'no-result' };
  if (r.success) {
    if (r.method === 'existing') return { ok: true, lines: [`✓ 代理内核已就位: ${r.path}`] };
    if (r.method === 'adopted') {
      const src = r.source ? ` (来源 ${r.source})` : '';
      return { ok: true, lines: [`✓ 已采纳本机现成内核: ${r.path}${src}`] };
    }
    if (r.method === 'downloaded' || r.method === 'downloaded-verified') {
      const ver = r.version ? ` ${r.version}` : '';
      const tag = r.integrity ? ` [${r.integrity}]` : '';
      return { ok: true, lines: [`✓ 已下载并安装代理内核 mihomo${ver}${tag}: ${r.path}`] };
    }
    return { ok: true, lines: [`✓ 代理内核已安装: ${r.path || '(未知路径)'}`] };
  }
  // Failure — always append where-to-download so the user is never stuck.
  const head = r.reason === 'disabled'
    ? '⚠ 自动下载内核未启用。'
    : `⚠ 无法自动安装代理内核(${r.reason || 'unknown'})。`;
  const lines = [head];
  if (r.guidance) lines.push(`  ${r.guidance}`);
  if (r.error) lines.push(`  详情: ${r.error}`);
  lines.push('  你可以手动下载:');
  lines.push(...formatDownloadHint(descriptor));
  return { ok: false, lines };
}

/**
 * Map an install-status snapshot to lines (pure, zero network).
 * @param {{installed:boolean, path:string|null, descriptor:object|null}} snap
 * @returns {string[]}
 */
function formatCoreStatus(snap) {
  const s = snap && typeof snap === 'object' ? snap : {};
  const lines = [];
  if (s.installed) {
    lines.push(`✓ 代理内核已安装: ${s.path || '(未知路径)'}`);
    return lines;
  }
  lines.push('✗ 未检测到代理内核(mihomo / clash-meta)。');
  lines.push('  运行 `khy proxy core install` 自动安装,或手动下载:');
  lines.push(...formatDownloadHint(s.descriptor));
  return lines;
}

/**
 * Run `proxy core <action>`. Fail-soft: never throws; on any internal error it
 * degrades to a structured "where to download" message. DI for tests.
 * @param {{action?:string, env?:object, out?:Function, installer?:object}} [opts]
 * @returns {Promise<{action:string, ok:boolean, result?:object}>}
 */
async function runCore(opts = {}) {
  const action = String(opts.action || 'status').toLowerCase();
  const env = opts.env || process.env;
  const out = typeof opts.out === 'function' ? opts.out : (line) => console.log(line);
  const installer = opts.installer || DEFAULT_INSTALLER();

  let descriptor = null;
  try { descriptor = installer.describeCoreDownload(); } catch { descriptor = null; }

  if (action === 'install' || action === 'download' || action === 'ensure') {
    let result;
    try {
      result = await installer.install({ env });
    } catch (err) {
      result = { success: false, reason: 'install-threw', error: err && err.message ? err.message : String(err) };
    }
    const rendered = formatCoreInstallResult(result, descriptor);
    rendered.lines.forEach((l) => out(l));
    return { action: 'install', ok: rendered.ok, result };
  }

  // Default: status — pure read, zero network.
  let installed = false;
  let binPath = null;
  try { installed = !!installer.isInstalled(); } catch { installed = false; }
  try {
    binPath = typeof installer._binaryPath === 'function'
      ? installer._binaryPath()
      : (descriptor && descriptor.dest) || null;
  } catch { binPath = (descriptor && descriptor.dest) || null; }
  formatCoreStatus({ installed, path: binPath, descriptor }).forEach((l) => out(l));
  return { action: 'status', ok: installed };
}

module.exports = { runCore, formatCoreInstallResult, formatCoreStatus, formatDownloadHint };
