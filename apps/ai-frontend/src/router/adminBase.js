/**
 * adminBase.js — 路由部署基址判定（纯函数，无副作用，便于单测）。
 *
 * 背景：前端可能被部署在 /admin/<任意段>/... 这类子路径下（例如后端把前端
 * 静态资源挂到 /admin/khy/ 后），detectRouterBase() 需要把 /admin/<seg>/...
 * 识别为部署基址前缀。但它不能把 /admin/ 下**已注册的站内路由**（如
 * /admin/channel-apis）也当成基址，否则 router base 会坍缩成
 * /admin/channel-apis 再往上拼一层，站内页直接 404。
 *
 * 需排除的段由路由表派生（collectAdminRouteSegments），不维护手工白名单 ——
 * 历史上这里是一个手写的 IN_APP_ADMIN_SEGMENTS 集合，每加一个 /admin/xxx
 * 站内页都要回来补一段，漏补就是一次 404。
 *
 * 本模块刻意不依赖 window / import.meta.env / vue-router，所有输入走参数，
 * 所以 test/adminBase.test.mjs 可以直接用 node --test 断言。
 */

/**
 * 收集所有落在 /admin/ 下的站内路由的首段。
 *
 * 递归遍历嵌套 children，用父路径拼接出绝对路径 —— 与 vue-router 合成最终
 * path 的方式一致。只取首段（/admin/<seg> 之后的那一段），因为部署基址
 * 判定只关心第一段。
 *
 * @param {Array<object>} allRoutes 路由表（顶层数组）
 * @param {Set<string>} [out] 累加容器，便于复用
 * @returns {Set<string>} 小写首段集合
 */
export function collectAdminRouteSegments(allRoutes, out = new Set()) {
  const walk = (records, parentPath) => {
    for (const record of records) {
      const own = String(record.path || '');
      const base = parentPath === '/' ? '/' : `${parentPath.replace(/\/$/, '')}/`;
      const abs = /^\//.test(own) ? own : base + own;
      if (/^\/admin(?:\/|$)/i.test(abs)) {
        out.add(String(abs.split('/')[2] || '').toLowerCase());
      }
      if (Array.isArray(record.children)) walk(record.children, abs);
    }
  };
  walk(Array.isArray(allRoutes) ? allRoutes : [], '');
  return out;
}

/**
 * 计算 createWebHistory() 该用的基址。
 *
 * 判定顺序（首个命中即停）：
 *   1. 环境变量 VITE_AI_ROUTER_BASE 显式指定，且当前路径确实在其下；
 *   2. /admin/<seg> 部署基址，前提是 <seg> 不是已注册的站内路由段；
 *   3. 兜底 '/'。
 *
 * @param {object} params
 * @param {string} [params.pathname] 当前 location.pathname
 * @param {string} [params.envBase]  VITE_AI_ROUTER_BASE 原始值
 * @param {Set<string>} [params.adminSegments] collectAdminRouteSegments 的结果
 * @returns {string} 以 / 开头的基址
 */
export function resolveRouterBase({ pathname, envBase = '', adminSegments = new Set() } = {}) {
  const path = String(pathname || '/');

  // 归一化必须发生在「当前路径是否位于其下」的比较之前：VITE_AI_ROUTER_BASE
  // 写成 sub/app（漏前导斜杠）是常见配置笔误，若在比较后才补 '/' 会永远匹配
  // 不上，静默退化成 '/'，表现为整站路由错位而没有任何报错。
  const base = String(envBase || '')
    .trim()
    .replace(/\/+$/, '');
  const absBase = base.startsWith('/') ? base : `/${base}`;
  if (absBase && (path === absBase || path.startsWith(`${absBase}/`))) {
    return absBase;
  }

  const match = path.match(/^\/admin\/([^/]+)(?:\/|$)/i);
  const segment = match && match[1] ? match[1].toLowerCase() : '';
  if (segment && !adminSegments.has(segment)) {
    return `/admin/${match[1]}`;
  }

  return '/';
}
