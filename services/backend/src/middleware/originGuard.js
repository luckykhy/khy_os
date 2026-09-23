'use strict';

/**
 * originGuard.js — 本地控制面守卫(纯叶子:零依赖、可确定性单测、绝不抛)。
 *
 * 定位:有些端点**必须保持公开**(典型是 /api/daemon/* —— 登录页要在用户拿到任何
 * 凭据之前就能拉起守护进程),因此不能挂 authMiddleware;但它们同样不能裸奔。
 * 本模块提供两个正交的守卫,叠加使用:
 *
 *   requireLoopback — 只接受来自本机回环地址的连接(挡局域网与远程调用方)
 *   originGuard     — 拒绝不可信的浏览器来源(挡恶意网页的跨站调用)
 *
 * 为什么单独成叶子而不是挂在 middleware/auth.js 里:auth.js 顶部 require 了
 * `../models`(Sequelize/DB)。让一个纯函数守卫去拉整条 ORM 初始化链,会把
 * 「只测守卫」的用例从毫秒级拖到十几秒级(实测 daemon 路由测试单项 17s)。
 * 守卫是纯逻辑,不该为别人的依赖买单。
 *
 * 威胁模型:loopback 绑定**不构成安全边界** —— 用户浏览器里的任意网页都能
 * fetch 到 127.0.0.1。真正的防线是 Origin 校验(页面脚本无法伪造 Origin)。
 */

const ALLOWED_ORIGINS_ENV = 'KHY_ALLOWED_ORIGINS';

/** 取请求来源 IP(兼容 IPv4-mapped IPv6,如 ::ffff:127.0.0.1)。 */
function remoteAddress(req) {
  const raw = (req && req.socket && req.socket.remoteAddress) || '';
  return String(raw).trim().toLowerCase();
}

/** 该 IP 是否为本机回环。 */
function isLoopbackAddress(ip) {
  const a = String(ip || '')
    .trim()
    .toLowerCase();
  if (!a) {
    return false;
  }
  const bare = a.startsWith('::ffff:') ? a.slice(7) : a;
  return (
    bare === '::1' || bare === 'localhost' || bare.startsWith('127.') || bare === '0:0:0:0:0:0:0:1'
  );
}

/** 显式来源白名单(逗号分隔,大小写不敏感)。 */
function parseAllowedOrigins(env = process.env) {
  return String((env && env[ALLOWED_ORIGINS_ENV]) || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * 该浏览器来源是否可信。
 *
 * 放行:显式白名单 / `null` / `file://` / loopback 的 http(s) 来源。
 *
 * `null` 与 `file://` **必须**放行 —— Electron 生产构建用 loadFile() 加载渲染进程,
 * 其 fetch 携带的 Origin 即 `null`;拒绝会直接打断桌面端。这二者的残余风险由
 * requireLoopback 兜底:攻击者仍需在目标机器上运行浏览器,而非从局域网/远程发起。
 * 若要收紧到「连本机网页也不放行」,需要引入登录前 token,那是另一个量级的改动。
 */
function isTrustedBrowserOrigin(origin, env = process.env) {
  const o = String(origin == null ? '' : origin)
    .trim()
    .toLowerCase();
  if (!o) {
    return true; // 无 Origin → 非浏览器客户端(CLI / 脚本 / SDK)
  }
  if (parseAllowedOrigins(env).includes(o)) {
    return true;
  }
  if (o === 'null' || o === 'file://') {
    return true;
  }
  try {
    const u = new URL(o);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return false;
    }
    // IPv6 字面量经 URL 解析后 hostname 带方括号(`[::1]`),剥掉再判定。
    const hostname = u.hostname.replace(/^\[/, '').replace(/\]$/, '');
    return isLoopbackAddress(hostname);
  } catch {
    return false;
  }
}

/** 仅允许本机回环来源。 */
const requireLoopback = (req, res, next) => {
  if (!isLoopbackAddress(remoteAddress(req))) {
    return res.status(403).json({ success: false, message: '仅允许本机访问' });
  }
  return next();
};

/** 拒绝不可信的浏览器来源(跨站调用)。 */
const originGuard = (req, res, next) => {
  if (!isTrustedBrowserOrigin(req.headers && req.headers.origin)) {
    return res.status(403).json({ success: false, message: '请求来源不被允许' });
  }
  return next();
};

module.exports = {
  ALLOWED_ORIGINS_ENV,
  remoteAddress,
  isLoopbackAddress,
  parseAllowedOrigins,
  isTrustedBrowserOrigin,
  requireLoopback,
  originGuard,
};
