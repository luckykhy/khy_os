/**
 * API Adapter — thin wrapper around the existing MultiFreeService
 * to expose a unified interface for the gateway.
 */
const path = require('path');

let _service = null;
let _serviceCtor = null;

function loadServiceCtor() {
  if (_serviceCtor) return _serviceCtor;

  const candidatePaths = [
    path.resolve(__dirname, '../../multiFreeService'),
    path.resolve(__dirname, '../../../../../backend/src/services/multiFreeService'),
  ];

  const errors = [];
  for (const modulePath of candidatePaths) {
    try {
      _serviceCtor = require(modulePath);
      return _serviceCtor;
    } catch (err) {
      errors.push(`${modulePath}: ${err.message}`);
    }
  }

  throw new Error(`MultiFreeService load failed. Tried ${candidatePaths.length} locations. ${errors.join(' | ')}`);
}

function getService() {
  if (!_service) {
    const MultiFreeService = loadServiceCtor();
    _service = new MultiFreeService();
  }
  return _service;
}

/**
 * Check if any API provider is configured and available.
 */
function detect() {
  const svc = getService();
  const providers = svc.getAvailableProviders();
  return providers.length > 0;
}

/**
 * Generate a response through cloud API providers.
 */
async function generate(prompt, options = {}) {
  const svc = getService();
  const result = await svc.generateResponse(prompt, options);
  return {
    success: result.success,
    content: result.content || '',
    provider: result.provider || '',
    adapter: 'api',
    attempts: result.attempts || [],
  };
}

/**
 * Get adapter status for display.
 */
function getStatus() {
  const svc = getService();
  const status = svc.getStatus();
  return {
    name: 'API 云端服务',
    type: 'api',
    available: status.available,
    detail: status.available
      ? `${status.configuredProviders.length} 个提供商 (${status.provider})`
      : '未配置 API 密钥',
  };
}

/**
 * Reset the cached service instance (call after API keys change).
 */
function resetService() {
  _service = null;
  _serviceCtor = null;
}

function destroy() {
  _service = null;
  _serviceCtor = null;
}

module.exports = { detect, generate, getStatus, resetService, destroy };
