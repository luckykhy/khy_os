'use strict';

/**
 * permissionService.js — Unified permission prompt logic for TUI and Classic.
 *
 * This module handles the permission request flow:
 * 1. Determine what to ask (tool name, action description, risk level)
 * 2. Build choices (allow, always allow, deny)
 * 3. Format the prompt content
 *
 * The actual rendering is delegated to the UI adapter layer.
 */

const { confirm, info } = require('../uiResponse');

/**
 * Build a permission request for a tool action.
 * @param {object} opts
 * @param {string} opts.toolName - Name of the tool requesting permission
 * @param {string} opts.action - Description of the action (e.g., "execute shell command")
 * @param {string} [opts.command] - The actual command to be executed
 * @param {'low'|'medium'|'high'|'critical'} [opts.risk='medium'] - Risk level
 * @param {boolean} [opts.canAlwaysAllow=false] - Whether "always allow" is an option
 * @returns {object} Response object for the UI adapter
 */
function buildPermissionRequest({ toolName, action, command, risk = 'medium', canAlwaysAllow = false }) {
  const riskColors = { low: 'green', medium: 'yellow', high: 'red', critical: 'red' };
  const riskEmoji = { low: '✓', medium: '⚠', high: '⛔', critical: '⛔' };

  const riskLabel = riskColors[risk] || 'yellow';
  const emoji = riskEmoji[risk] || '⚠';

  let message = `${emoji} ${toolName}: ${action}`;
  if (command) {
    message += `\n   ${command}`;
  }

  // Build choices
  const choices = [
    { id: 'allow', label: '允许', description: '仅本次' },
  ];

  if (canAlwaysAllow) {
    choices.push({ id: 'always', label: '始终允许', description: '此工具不再询问' });
  }

  choices.push({ id: 'deny', label: '拒绝', description: '取消操作' });

  return {
    type: 'permission',
    title: '权限请求',
    message,
    risk,
    choices,
    toolName,
    action,
    command,
    timestamp: Date.now(),
  };
}

/**
 * Resolve a permission response from user input.
 * @param {object} response - The permission request response
 * @param {string|string[]} userInput - User's choice (e.g., 'allow', 'always', 'deny' or aliases)
 * @returns {'allow'|'always'|'deny'} Resolved permission
 */
function resolvePermission(response, userInput) {
  const input = String(userInput).toLowerCase().trim();

  // Aliases for allow
  const allowAliases = ['1', 'y', 'yes', 'allow', 'a', 'always', '是', '允许', '同意'];
  // Aliases for deny
  const denyAliases = ['2', 'n', 'no', 'deny', 'd', '否', '拒绝', '取消'];
  // Aliases for always allow
  const alwaysAliases = ['3', 'always', 's', '是,始终', '始终允许'];

  if (alwaysAliases.includes(input)) {
    return 'always';
  }
  if (denyAliases.includes(input)) {
    return 'deny';
  }
  if (allowAliases.includes(input)) {
    return 'allow';
  }

  // Default to deny for unrecognized input
  return 'deny';
}

/**
 * Check if a permission should be auto-approved based on stored rules.
 * @param {object} opts
 * @param {string} opts.toolName - Tool name
 * @param {string} [opts.command] - Command string
 * @param {object} [opts.permissionStore] - Permission store instance
 * @returns {boolean}
 */
function shouldAutoApprove({ toolName, command, permissionStore }) {
  if (!permissionStore) {
    return false;
  }

  try {
    // Check if tool is in always-allow list
    if (typeof permissionStore.isAlwaysAllowed === 'function') {
      return permissionStore.isAlwaysAllowed(toolName, command);
    }

    // Check by risk classification
    if (typeof permissionStore.classify === 'function') {
      const classification = permissionStore.classify(toolName, command);
      return classification === 'safe';
    }
  } catch {
    /* fail closed - require explicit permission */
  }

  return false;
}

module.exports = {
  buildPermissionRequest,
  resolvePermission,
  shouldAutoApprove,
};
