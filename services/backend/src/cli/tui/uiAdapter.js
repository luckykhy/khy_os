'use strict';

/**
 * tui/uiAdapter.js — TUI renderer for unified UI responses.
 *
 * Renders response objects using Ink/React components.
 */

/**
 * Show info message in TUI.
 * @param {object} response
 */
function showInfo(response) {
  // In TUI mode, use stderr for notifications (visible in TUI's log area)
  process.stderr.write(`[INFO] ${response.title ? response.title + ': ' : ''}${response.message}\n`);
}

/**
 * Show success message in TUI.
 * @param {object} response
 */
function showSuccess(response) {
  if (showHint && typeof showHint === 'function') {
    showHint(response.message);
  } else {
    process.stderr.write(`[SUCCESS] ${response.message}\n`);
  }
}

/**
 * Show error message in TUI.
 * @param {object} response
 */
function showError(response) {
  if (showHint && typeof showHint === 'function') {
    showHint(`错误: ${response.message}`);
  } else {
    process.stderr.write(`[ERROR] ${response.title ? response.title + ': ' : ''}${response.message}\n`);
  }
}

/**
 * Show confirmation dialog in TUI.
 * @param {object} response
 * @returns {Promise<boolean>}
 */
function showConfirm(response) {
  // In TUI mode, this would integrate with PermissionsPrompt component
  // For now, fallback to classic inquirer (the component handles the UI)
  const classicAdapter = require('../classic/uiAdapter');
  return classicAdapter.showConfirm(response);
}

/**
 * Show list selection in TUI.
 * @param {object} response
 * @returns {Promise<string>} Selected item id
 */
function showList(response) {
  // In TUI mode, this would integrate with ModelPicker component
  const classicAdapter = require('../classic/uiAdapter');
  return classicAdapter.showList(response);
}

/**
 * Show form input in TUI.
 * @param {object} response
 * @returns {Promise<object>} Form values
 */
function showForm(response) {
  // In TUI mode, this would integrate with FormFlow component
  const classicAdapter = require('../classic/uiAdapter');
  return classicAdapter.showForm(response);
}

module.exports = {
  showInfo,
  showSuccess,
  showError,
  showConfirm,
  showList,
  showForm,
};
