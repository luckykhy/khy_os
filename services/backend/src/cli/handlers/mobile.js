'use strict';

/**
 * `mobile` command — show a terminal QR code that a phone can scan to open the
 * KHY web interface over the local network.
 *
 * The QR encodes a LAN URL (http://<lan-ipv4>:<port><path>), so a phone on the
 * same Wi-Fi can scan it and reach the management UI without typing the address.
 *
 * Usage:
 *   khy mobile                 → QR for http://<lan-ip>:<mgmt-port>/admin/ai-gateway
 *   khy mobile 5173            → QR for http://<lan-ip>:5173 (e.g. Vite dev server)
 *   khy mobile 192.168.1.9:8080
 *   khy mobile https://my.host/path
 *   khy mobile --path /         → override the default entry path
 *
 * The phone must be on the SAME network, and the target server must bind to all
 * interfaces (0.0.0.0) — the AI management server does by default.
 */

const os = require('os');
const chalk = require('chalk');
const { printError, printInfo, printSuccess, printWarn } = require('../formatters');

const DEFAULT_ENTRY_PATH = '/admin/ai-gateway';

/**
 * Collect non-internal IPv4 addresses, ranked so the most likely LAN address
 * comes first: real private ranges on physical-looking interfaces beat virtual
 * adapters (docker/vEthernet/bridge/tailscale...).
 * @returns {{ best: string|null, candidates: Array<{name:string,address:string}> }}
 */
function getLanIPv4() {
  const ifaces = os.networkInterfaces();
  const candidates = [];
  for (const [name, list] of Object.entries(ifaces || {})) {
    for (const item of list || []) {
      // Node <18 reports family 'IPv4'; Node >=18 may report numeric 4.
      const isV4 = item.family === 'IPv4' || item.family === 4;
      if (!isV4 || item.internal) continue;
      candidates.push({ name, address: item.address });
    }
  }
  const isPrivate = (ip) =>
    /^10\./.test(ip) ||
    /^192\.168\./.test(ip) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(ip);
  const isVirtual = (name) =>
    /^(docker|br-|veth|virbr|vmnet|vboxnet|tailscale|zt|utun|tun|tap|vEthernet|Loopback)/i.test(name);
  const score = (c) =>
    (isPrivate(c.address) ? 2 : 0) + (isVirtual(c.name) ? 0 : 1);
  candidates.sort((a, b) => score(b) - score(a));
  return { best: candidates.length ? candidates[0].address : null, candidates };
}

/**
 * Resolve the target URL from positional tokens + options.
 * @param {string[]} tokens - command tokens (subCommand + args)
 * @param {object} options
 * @param {string} lanIp
 * @returns {string|null}
 */
function resolveTargetUrl(tokens, options, lanIp) {
  const path = options.path || DEFAULT_ENTRY_PATH;
  const arg = (tokens.find(Boolean) || '').trim();

  // 1) Full URL passed through verbatim.
  if (/^https?:\/\//i.test(arg)) return arg;

  // 2) host:port (e.g. 192.168.1.9:8080)
  if (/^[\w.-]+:\d{2,5}$/.test(arg)) return `http://${arg}`;

  if (!lanIp) return null;

  // 3) bare port → LAN ip + that port (no entry path; user targets a raw server)
  if (/^\d{2,5}$/.test(arg)) return `http://${lanIp}:${arg}`;

  // 4) default → management server port + entry path
  let port;
  try {
    const mgmt = require('../../services/aiManagementServer');
    port = (mgmt.isRunning && mgmt.isRunning() && mgmt.getPort)
      ? mgmt.getPort()
      : (parseInt(process.env.AI_MGMT_PORT, 10) || 9090);
  } catch {
    port = parseInt(process.env.AI_MGMT_PORT, 10) || 9090;
  }
  const normPath = path.startsWith('/') ? path : `/${path}`;
  return `http://${lanIp}:${port}${normPath}`;
}

/**
 * Render a scannable QR code for a URL to the terminal.
 * @param {string} url
 * @returns {Promise<string>}
 */
async function renderQr(url) {
  let QRCode;
  try {
    QRCode = require('qrcode');
  } catch {
    throw new Error('qrcode 依赖缺失，请运行: npm install qrcode');
  }
  // `small: true` uses half-block characters for a compact, phone-scannable QR.
  return QRCode.toString(url, { type: 'terminal', small: true, errorCorrectionLevel: 'M' });
}

/**
 * Print guidance about how the phone will authenticate against the AI
 * management server, based on the currently configured auth mode. Skipped for
 * non-management targets (bare ports / custom URLs) where we can't reason about
 * the auth model.
 * @param {string} url
 */
function printAuthHint(url) {
  // Only the default management entry path carries the admin UI we gate.
  if (!url.includes(DEFAULT_ENTRY_PATH)) return;

  const hasToken = !!String(process.env.AI_MGMT_AUTH_TOKEN || '').trim();
  const hasJwt = !!String(process.env.JWT_SECRET || '').trim();
  const lanAllowed = /^(1|true|yes|on)$/i.test(String(process.env.AI_MGMT_ALLOW_LAN || '').trim());

  if (hasToken || hasJwt) {
    printInfo('该服务已启用鉴权：手机打开后需在登录页输入账号/Token 后访问。');
    return;
  }
  if (lanAllowed) {
    printInfo('已开启 AI_MGMT_ALLOW_LAN：同局域网手机可免登录直接访问（仅信任网络建议开启）。');
    return;
  }
  printWarn('当前未配置鉴权：手机（局域网 IP）默认会被拒绝（仅本机放行）。');
  printInfo('如需手机免登录访问，请设置环境变量后重启后端：AI_MGMT_ALLOW_LAN=true');
  printInfo('或为服务配置正式鉴权（AI_MGMT_AUTH_TOKEN / JWT_SECRET）后在手机登录页登录。');
}

/**
 * `mobile` command entry point.
 * @param {string} subCommand
 * @param {string[]} args
 * @param {object} options
 */
async function handleMobile(subCommand, args = [], options = {}) {
  const tokens = [subCommand, ...(args || [])].filter(Boolean);
  const { best: lanIp, candidates } = getLanIPv4();

  const url = resolveTargetUrl(tokens, options, lanIp);
  if (!url) {
    printError('未检测到局域网 IPv4 地址。请确认已连接 Wi-Fi/有线网络，或显式指定：');
    printInfo('  khy mobile <端口>            例如 khy mobile 9090');
    printInfo('  khy mobile <主机:端口>       例如 khy mobile 192.168.1.9:9090');
    printInfo('  khy mobile <完整URL>         例如 khy mobile http://192.168.1.9:9090');
    return true;
  }

  let qr;
  try {
    qr = await renderQr(url);
  } catch (err) {
    printError(err.message || String(err));
    return true;
  }

  console.log('');
  printSuccess('手机扫码访问 KHY Web 界面');
  console.log('');
  console.log(qr);
  console.log('  ' + chalk.cyan.underline(url));
  console.log('');
  printInfo('请确保手机与本机处于同一 Wi-Fi / 局域网。');
  printInfo('目标服务需监听 0.0.0.0（AI 管理服务默认如此）；若未启动，先运行 khy app / 启动后端。');
  printAuthHint(url);
  if (candidates.length > 1) {
    const others = candidates.slice(1).map((c) => `${c.address} (${c.name})`).join(', ');
    printWarn(`检测到多个网卡，已选用 ${candidates[0].address} (${candidates[0].name})。其他候选：${others}`);
    printInfo('如选错网卡，可指定：khy mobile <主机:端口> 或 khy mobile <完整URL>');
  }
  return true;
}

module.exports = { handleMobile, getLanIPv4, resolveTargetUrl, renderQr };
