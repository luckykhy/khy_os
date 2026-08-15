'use strict';

/**
 * modelAdaptationHttp —— 模型画像状态与显式热重载的可挂载 HTTP 处理器。
 *
 * 宿主通过依赖注入提供 authenticate / sendJson / registry。本模块不启动服务器,
 * 不绑定 aiManagementServer,因此可独立测试、独立回滚。未命中路由返回 false。
 */

const modelFeatureRegistry = require('./modelFeatureRegistry');

const STATUS_PATH = '/api/model-adaptation/status';
const RELOAD_PATH = '/api/model-adaptation/reload';

function defaultSendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function createModelAdaptationHttpHandler(deps = {}) {
  const registry = deps.registry && typeof deps.registry.getStatus === 'function'
    ? deps.registry
    : modelFeatureRegistry.getModelFeatureRegistry();
  const sendJson = typeof deps.sendJson === 'function' ? deps.sendJson : defaultSendJson;
  const authenticate = typeof deps.authenticate === 'function' ? deps.authenticate : () => true;

  return async function handleModelAdaptationHttp(req, res, pathname) {
    const method = String((req && req.method) || 'GET').toUpperCase();
    const route = String(pathname || '');

    if (route !== STATUS_PATH && route !== RELOAD_PATH) {
      return false;
    }

    let authenticated = false;
    try {
      const auth = await authenticate(req);
      authenticated = auth === true || Boolean(auth && auth.ok);
    } catch {
      authenticated = false;
    }

    if (!authenticated) {
      sendJson(res, 401, { success: false, error: 'unauthorized' });
      return true;
    }

    if (method === 'GET' && route === STATUS_PATH) {
      sendJson(res, 200, { success: true, data: registry.getStatus() });
      return true;
    }

    if (method === 'POST' && route === RELOAD_PATH) {
      const status = registry.reload({ reason: 'http' });
      sendJson(res, 200, {
        success: true,
        data: status,
        semantics: 'next-request',
      });
      return true;
    }

    sendJson(res, 405, { success: false, error: 'method_not_allowed' });
    return true;
  };
}

module.exports = {
  RELOAD_PATH,
  STATUS_PATH,
  createModelAdaptationHttpHandler,
  defaultSendJson,
};
