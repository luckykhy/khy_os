/**
 * KHY Trae Bridge — 将 Trae 登录态桥接到 KHY OS CLI
 *
 * 工作原理:
 *   1. Trae 在 Sandbox 中注册了 AuthenticationProvider 'icube.marscode'
 *   2. 本扩展调用 vscode.authentication.getSession('icube.marscode', [])
 *      获取 session.accessToken (即 iCubeAuthInfo 解密后的 token)
 *   3. 将 token 写到约定路径 <globalStorage>/khy-trae-bridge/auth.json
 *   4. KHY CLI 的 readMarsCodeAuthProviderToken() 自动读取此文件
 *
 * 约定输出格式:
 *   { accessToken, host, userId, username, region, ts }
 *
 * 刷新策略:
 *   - 启动后立即同步
 *   - 每 10 分钟定时刷新
 *   - 监听 onDidChangeSessions 事件即时更新
 *   - 手动命令 khy-trae-bridge.sync
 */
'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

// ── 常量 ──
const PROVIDER_ID = 'icube.marscode';
const BRIDGE_DIR_NAME = 'khy-trae-bridge';
const AUTH_FILENAME = 'auth.json';
const REFRESH_INTERVAL_MS = 10 * 60 * 1000; // 10 分钟

// 区域 → 原生 API 主机映射 (与 KHY traeOfficialArtifacts.js TRAE_REGION_HOST_MAP 一致)
const REGION_HOST_MAP = {
  cn: 'grow-normal.trae.ai',
  sg: 'growsg-normal.trae.ai',
  va: 'growva-normal.trae.ai',
  usttp: 'grow-normal.traeapi.us',
};

let _timer = null;
let _channel = null;
let _lastSyncOk = false;

// ── 激活入口 ──

function activate(context) {
  _channel = vscode.window.createOutputChannel('KHY Trae Bridge');

  const bridgePath = resolveBridgePath(context);
  log(`桥接文件路径: ${bridgePath}`);

  // 立即同步一次
  syncToken(bridgePath);

  // 定时刷新
  _timer = setInterval(() => syncToken(bridgePath), REFRESH_INTERVAL_MS);
  context.subscriptions.push({ dispose() { clearInterval(_timer); } });

  // 监听登录/登出事件
  context.subscriptions.push(
    vscode.authentication.onDidChangeSessions(e => {
      if (e.provider.id === PROVIDER_ID) {
        log('检测到 icube.marscode 会话变更，立即同步');
        syncToken(bridgePath);
      }
    })
  );

  // 手动同步命令
  context.subscriptions.push(
    vscode.commands.registerCommand('khy-trae-bridge.sync', async () => {
      const ok = await syncToken(bridgePath);
      if (ok) {
        vscode.window.showInformationMessage('KHY Trae Bridge: 登录态同步成功');
      } else {
        vscode.window.showWarningMessage('KHY Trae Bridge: 未检测到 Trae 登录态，请先在 Trae 中登录');
      }
    })
  );

  // 状态栏指示
  const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
  statusItem.command = 'khy-trae-bridge.sync';
  statusItem.text = '$(key) KHY Bridge';
  statusItem.tooltip = '点击手动同步 Trae 登录态到 KHY CLI';
  statusItem.show();
  context.subscriptions.push(statusItem);

  log('扩展激活完成');
}

// ── 核心同步逻辑 ──

let _firstAttempt = true;

async function syncToken(bridgePath) {
  try {
    // 策略：
    //   1. 首次尝试 silent: true（不弹窗，仅检查已授权的会话）
    //   2. silent 失败后尝试 createIfNone: false（获取已有但未对本扩展授权的会话）
    //   3. 以上都失败且是首次调用时，用 createIfNone: true 触发授权弹窗
    //      （Trae 会弹出 "扩展 KHY Trae Bridge 想要使用 icube.marscode 登录" 确认框）
    let session = null;

    // 第一步：静默获取（VS Code >= 1.87 支持 silent 选项）
    try {
      session = await vscode.authentication.getSession(PROVIDER_ID, [], { silent: true });
    } catch {
      // silent 不支持或失败 → 继续
    }

    // 第二步：常规获取（不创建）
    if (!session) {
      session = await vscode.authentication.getSession(PROVIDER_ID, [], { createIfNone: false });
    }

    // 第三步：首次启动且前两步都没拿到 → 弹窗请求用户授权
    if (!session && _firstAttempt) {
      _firstAttempt = false;
      log('首次启动未检测到已授权会话，请求用户授权...');
      try {
        session = await vscode.authentication.getSession(PROVIDER_ID, [], { createIfNone: true });
      } catch (authErr) {
        // 用户拒绝授权或 provider 不支持
        log(`用户授权请求失败: ${authErr.message || authErr}`);
      }
    }
    _firstAttempt = false;

    if (!session || !session.accessToken) {
      log('未找到 icube.marscode 会话 — 用户可能未登录或拒绝了授权');
      _lastSyncOk = false;
      writeBridgeFile(bridgePath, {
        accessToken: null,
        status: 'no_session',
        ts: Date.now(),
      });
      return false;
    }

    // session.accessToken 可能是:
    //   A) 纯 token 字符串 (直接可用)
    //   B) iCubeAuthInfo 完整 JSON 字符串 (需要解析提取 .token 字段)
    //   C) JSON 对象的 toString 结果 "[object Object]" (需要序列化)
    const rawToken = session.accessToken;
    let extractedToken = rawToken;
    let extractedRefreshToken = null;
    let extractedExpiresAt = null;
    let extractedHost = null;
    let extractedUserId = null;
    let extractedRegion = null;
    let tokenFormat = 'raw'; // raw | json_parsed | json_blob

    // 尝试 JSON 解析 — iCubeAuthInfo 包含 { token, host, userId, userRegion, ... }
    if (typeof rawToken === 'string' && (rawToken.startsWith('{') || rawToken.startsWith('['))) {
      try {
        const parsed = JSON.parse(rawToken);
        if (parsed && typeof parsed === 'object') {
          // iCubeAuthInfo 结构: { token, refreshToken, expiredAt, host, userId, userRegion, account, ... }
          if (parsed.token) {
            extractedToken = parsed.token;
            extractedRefreshToken = parsed.refreshToken || null;
            extractedExpiresAt = parsed.expiredAt ? new Date(parsed.expiredAt).toISOString() : (parsed.expiresAt || null);
            extractedHost = parsed.host || null;
            extractedUserId = parsed.userId || null;
            extractedRegion = parsed.userRegion || null;
            tokenFormat = 'json_parsed';
            log(`从 accessToken JSON 中提取: token=${extractedToken.slice(0, 16)}..., host=${extractedHost}, region=${extractedRegion}`);
          } else if (parsed.accessToken) {
            // 可能是嵌套的 { accessToken: "..." } 格式
            extractedToken = parsed.accessToken;
            extractedRefreshToken = parsed.refreshToken || null;
            extractedExpiresAt = parsed.expiresAt || null;
            extractedHost = parsed.host || null;
            extractedUserId = parsed.userId || null;
            extractedRegion = parsed.region || parsed.userRegion || null;
            tokenFormat = 'json_parsed';
            log(`从 accessToken 嵌套 JSON 中提取: token=${extractedToken.slice(0, 16)}...`);
          }
        }
      } catch {
        // 不是有效 JSON → 当作纯 token 使用
      }
    } else if (typeof rawToken === 'object' && rawToken !== null) {
      // 极端情况: accessToken 本身就是对象（某些 provider 实现）
      if (rawToken.token) {
        extractedToken = rawToken.token;
        extractedRefreshToken = rawToken.refreshToken || null;
        extractedExpiresAt = rawToken.expiredAt ? new Date(rawToken.expiredAt).toISOString() : (rawToken.expiresAt || null);
        extractedHost = rawToken.host || null;
        extractedUserId = rawToken.userId || null;
        extractedRegion = rawToken.userRegion || null;
        tokenFormat = 'json_blob';
      }
    }

    // 记录原始 token 格式用于调试
    log(`accessToken 格式: ${tokenFormat}, 长度: ${String(rawToken).length}, 前缀: ${String(rawToken).slice(0, 32)}...`);

    // 检测区域和原生主机 (JSON 解析出的值优先)
    const detected = detectRegion();
    const finalRegion = extractedRegion || detected.region;
    const finalHost = extractedHost || detected.host;

    const data = {
      accessToken: extractedToken,
      refreshToken: extractedRefreshToken,
      expiresAt: extractedExpiresAt,
      rawAccessToken: tokenFormat !== 'raw' ? rawToken : undefined, // 保留原始值供调试
      userId: extractedUserId || session.account?.id || null,
      username: session.account?.label || null,
      host: finalHost,
      region: finalRegion,
      tokenFormat,
      ts: Date.now(),
    };

    writeBridgeFile(bridgePath, data);

    if (!_lastSyncOk) {
      log(`首次同步成功 — userId: ${data.userId}, region: ${data.region}, host: ${data.host}`);
    }
    _lastSyncOk = true;
    return true;
  } catch (err) {
    log(`同步失败: ${err.message || err}`);
    _lastSyncOk = false;
    return false;
  }
}

// ── 区域检测 ──

function detectRegion() {
  const appName = String(vscode.env.appName || '');

  // 仅 Trae CN (国内版) 使用 CN 端点 — appName 含 "Trae CN" 或 "国内版"
  if (/trae\s*cn/i.test(appName) || /国内/i.test(appName)) {
    return { region: 'cn', host: REGION_HOST_MAP.cn };
  }

  // 国际版: 中国用户走新加坡 (最近节点)，其他走弗吉尼亚
  const lang = String(vscode.env.language || '').toLowerCase();
  if (lang.startsWith('zh')) {
    return { region: 'sg', host: REGION_HOST_MAP.sg };
  }

  return { region: 'va', host: REGION_HOST_MAP.va };
}

// ── 文件操作 ──

function resolveBridgePath(context) {
  // context.globalStorageUri 指向本扩展自己的 globalStorage
  // 上级目录是所有扩展共享的 globalStorage 根
  // KHY 约定读取 <globalStorageRoot>/khy-trae-bridge/auth.json
  const globalStorageRoot = path.dirname(context.globalStorageUri.fsPath);
  return path.join(globalStorageRoot, BRIDGE_DIR_NAME, AUTH_FILENAME);
}

function writeBridgeFile(bridgePath, data) {
  const dir = path.dirname(bridgePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(bridgePath, JSON.stringify(data, null, 2), 'utf8');
}

// ── 日志 ──

function log(msg) {
  if (_channel) {
    _channel.appendLine(`[${new Date().toISOString()}] ${msg}`);
  }
}

// ── 停用 ──

function deactivate() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
}

module.exports = { activate, deactivate };
