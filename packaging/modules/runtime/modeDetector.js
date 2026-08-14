'use strict';

/**
 * Module runtime mode detector.
 *
 * Determines whether the current process is running as a standalone
 * module executable or as part of the combined khy platform.
 *
 * Environment variables:
 *   KHY_MODULE - Current module ID (e.g. 'khy-ai', 'khy-quant')
 *   KHY_MODE   - Runtime mode: 'standalone' | 'combined' (default: 'combined')
 */

const VALID_MODULES = ['khy-ai', 'khy-gateway', 'khy-quant', 'khy-server', 'khy-tools', 'khy'];

function getCurrentModule() {
  return process.env.KHY_MODULE || 'khy';
}

function getMode() {
  return process.env.KHY_MODE || 'combined';
}

function isStandalone() {
  return getMode() === 'standalone';
}

function isCombined() {
  return getMode() === 'combined';
}

function isModuleActive(moduleId) {
  const current = getCurrentModule();
  // 'khy' (full) includes all modules
  if (current === 'khy') return true;
  return current === moduleId;
}

function validateModule(moduleId) {
  if (!VALID_MODULES.includes(moduleId)) {
    throw new Error(`Invalid module ID: "${moduleId}". Valid modules: ${VALID_MODULES.join(', ')}`);
  }
}

module.exports = {
  VALID_MODULES,
  getCurrentModule,
  getMode,
  isStandalone,
  isCombined,
  isModuleActive,
  validateModule,
};
