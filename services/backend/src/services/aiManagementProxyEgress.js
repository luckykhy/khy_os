'use strict';

/**
 * aiManagementServer 的「代理出站桥 REST 处理器」子系统。
 *
 * 承载 /api/proxy-egress 的一簇 HTTP 处理器,把前端选中的**订阅节点对象**接到机器级真实出站
 * (proxyConfigService.activateNode / deactivate / getStatus)。填补此前的空白:订阅浏览器(A)只
 * 展示节点、无法把选中节点接到真实出站(B = proxyConfigService.applyProxy 写 HTTP_PROXY,被网关
 * _proxyTunnel 消费)。
 *
 * 三条出站路(诚实边界,由 proxyCoreConfigGen.classifyNodeEgress 决定):
 *   - direct-connect(http/https)→ 节点自身即 CONNECT 代理,无需内核,直接生效。
 *   - core-required(vmess/vless/trojan/ss/ssr)→ 需本机 mihomo 内核(门 KHY_PROXY_CORE);
 *     门关/内核缺失 → 原样透传结构化 guidance(**绝不谎报生效**)。
 *   - unsupported → 明确 reason。
 *
 * **反向边经依赖注入打破**(与 aiManagementProjects.js 同门同形):处理器体调宿主的
 * sendJson / sendError / parseBody / authenticateRequest。宿主加载时调一次 setProxyEgressDeps 注入。
 * 全走已认证每用户路径(resolveAuthUserId),无匿名端点。
 *
 * **刻意非纯零 IO 叶子**:懒加载 proxyConfigService;写 env / proxy.json。
 */

// 宿主注入的反向边(响应工具 + 认证),加载时由 setProxyEgressDeps 注入一次。
let sendJson = null;
let sendError = null;
let parseBody = null;
let authenticateRequest = null;
function setProxyEgressDeps(deps = {}) {
  if (typeof deps.sendJson === 'function') sendJson = deps.sendJson;
  if (typeof deps.sendError === 'function') sendError = deps.sendError;
  if (typeof deps.parseBody === 'function') parseBody = deps.parseBody;
  if (typeof deps.authenticateRequest === 'function') authenticateRequest = deps.authenticateRequest;
}

// 机器级出站真源(单机「本机主人」模式)。懒加载以对齐 daemon boot-order。
let _proxyConfig = null;
function getProxyConfig() {
  if (!_proxyConfig) _proxyConfig = require('./proxyConfigService');
  return _proxyConfig;
}

// 解析已认证用户 id(0 为本机主人旁路)。认证失败发 401 并返 null;合法 id 0 放行。
// 与 aiManagementProjects.resolveAuthUserId 同契约。
async function resolveAuthUserId(req, res) {
  const auth = req.authContext || await authenticateRequest(req);
  if (!auth || !auth.ok) {
    sendJson(res, 401, { success: false, message: (auth && auth.error) || 'Authentication required' });
    return null;
  }
  return auth.user?.id ?? 0;
}

// GET /api/proxy-egress — 当前出站状态(enabled/activeNode/coreStatus)。
async function handleGetProxyEgressStatus(req, res) {
  const userId = await resolveAuthUserId(req, res);
  if (userId === null) return;
  try {
    const data = getProxyConfig().getStatus();
    sendJson(res, 200, { success: true, data });
  } catch (err) {
    sendError(res, err.statusCode || 500, err.message || 'Failed to read proxy egress status');
  }
}

// POST /api/proxy-egress/enable { node, mixedPort? } — 用选中节点激活真实出站。
// 前端从订阅组里取**整个节点对象**传入(clash-native 字段:type/server/port/uuid/...)。
async function handleEnableProxyEgress(req, res) {
  const userId = await resolveAuthUserId(req, res);
  if (userId === null) return;
  try {
    const body = await parseBody(req);
    const node = body && typeof body === 'object' ? body.node : null;
    if (!node || typeof node !== 'object') {
      sendError(res, 400, '缺少节点对象(body.node)。请从订阅组中选择一个节点。');
      return;
    }
    const options = {};
    if (body.mixedPort !== undefined) options.mixedPort = body.mixedPort;
    const result = await getProxyConfig().activateNode(node, options);
    // activateNode 已带 success/reason/guidance;失败也返 200 让前端读结构化 reason(不谎报生效)。
    sendJson(res, 200, { success: !!result.success, data: result });
  } catch (err) {
    sendError(res, err.statusCode || 500, err.message || 'Failed to enable proxy egress');
  }
}

// POST /api/proxy-egress/disable — 停用出站(清 env + 停内核)。
async function handleDisableProxyEgress(req, res) {
  const userId = await resolveAuthUserId(req, res);
  if (userId === null) return;
  try {
    const result = await getProxyConfig().deactivate();
    sendJson(res, 200, { success: !!result.success, data: result });
  } catch (err) {
    sendError(res, err.statusCode || 500, err.message || 'Failed to disable proxy egress');
  }
}

module.exports = {
  handleGetProxyEgressStatus,
  handleEnableProxyEgress,
  handleDisableProxyEgress,
  // Internal (exported for tests)
  getProxyConfig,
  resolveAuthUserId,
  // Dependency injection
  setProxyEgressDeps,
};
