'use strict';

/**
 * uiFacade.js — Single entry point for UI interactions.
 *
 * This is the ONLY module that command handlers should import for UI.
 * It automatically dispatches to the correct UI adapter based on mode.
 *
 * Usage (same code works in both TUI and Classic):
 *
 *   const ui = require('./uiFacade');
 *
 *   // Show info
 *   await ui.info('Operation complete');
 *
 *   // Ask for confirmation
 *   const ok = await ui.confirm('Delete this file?', { danger: true });
 *   if (!ok) return;
 *
 *   // Show list selection
 *   const model = await ui.selectModel('Choose a model', models);
 *
 *   // Show form
 *   const values = await ui.askForm('Login', [
 *     { name: 'user', label: 'Username', required: true },
 *     { name: 'pass', label: 'Password', type: 'password' }
 *   ]);
 */

const { renderResponse } = require('./uiAdapter');
const { info, success, error, confirm, list, form } = require('./uiResponse');
const { isTuiActive } = require('./uiResponse');

/**
 * Show an info message.
 * @param {string} message
 * @param {string} [title]
 * @returns {Promise<void>}
 */
async function showInfo(message, title) {
  return renderResponse(info({ message, title }));
}

/**
 * Show a success message.
 * @param {string} message
 * @returns {Promise<void>}
 */
async function showSuccess(message) {
  return renderResponse(success({ message }));
}

/**
 * Show an error message.
 * @param {string} message
 * @param {string} [title]
 * @param {string} [code]
 * @returns {Promise<void>}
 */
async function showError(message, title, code) {
  return renderResponse(error({ message, title, code }));
}

/**
 * Ask for confirmation.
 * @param {string} message
 * @param {object} [opts]
 * @param {boolean} [opts.danger=false]
 * @param {boolean} [opts.default=false]
 * @returns {Promise<boolean>}
 */
async function askConfirm(message, opts = {}) {
  const response = confirm({
    message,
    danger: opts.danger,
    default: opts.default,
  });
  return renderResponse(response);
}

/**
 * Show a list and ask user to select one.
 * @param {string} message - Prompt message
 * @param {Array<{id: string, label: string, description?: string}>} items
 * @returns {Promise<string>} Selected item id (or null if cancelled)
 */
async function askList(message, items) {
  const response = list({ message, items });
  return renderResponse(response);
}

/**
 * Show a form and collect input.
 * @param {string} title - Form title
 * @param {Array<{name: string, label: string, type?: string, required?: boolean, placeholder?: string}>} fields
 * @returns {Promise<object>} Form values (or null if cancelled)
 */
async function askForm(title, fields) {
  const response = form({ title, fields });
  return renderResponse(response);
}

/**
 * Check if running in TUI mode.
 * @returns {boolean}
 */
function isTui() {
  return isTuiActive();
}

module.exports = {
  info: showInfo,
  success: showSuccess,
  error: showError,
  confirm: askConfirm,
  list: askList,
  form: askForm,
  isTui,
};
