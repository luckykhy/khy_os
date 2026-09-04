'use strict';

/**
 * uiAdapter.js — Unified UI adapter layer.
 *
 * Dispatches UI responses to the appropriate renderer based on active mode.
 * This ensures TUI and Classic modes share the same command logic while
 * rendering appropriately for their environment.
 */

const { isTuiActive } = require('./uiResponse');

/**
 * Render a UI response in the appropriate mode.
 * @param {object} response - Response object from uiResponse functions
 * @returns {Promise<any>} - Resolves with user input (for confirm/list/form) or void
 */
async function renderResponse(response) {
  if (!response || !response.type) {
    return;
  }

  if (isTuiActive()) {
    return renderTui(response);
  } else {
    return renderClassic(response);
  }
}

/**
 * Render response in TUI mode (Ink/React).
 * @param {object} response
 * @returns {Promise<any>}
 */
async function renderTui(response) {
  const tuiAdapter = require('./tui/uiAdapter');

  switch (response.type) {
    case 'info':
      return tuiAdapter.showInfo(response);
    case 'success':
      return tuiAdapter.showSuccess(response);
    case 'error':
      return tuiAdapter.showError(response);
    case 'confirm':
      return tuiAdapter.showConfirm(response);
    case 'list':
      return tuiAdapter.showList(response);
    case 'form':
      return tuiAdapter.showForm(response);
    default:
      // Fallback to console for unknown types
      console.log(`[${response.type}] ${response.title || ''}: ${response.message}`);
  }
}

/**
 * Render response in Classic mode (readline/inquirer).
 * @param {object} response
 * @returns {Promise<any>}
 */
async function renderClassic(response) {
  const classicAdapter = require('./classic/uiAdapter');

  switch (response.type) {
    case 'info':
      return classicAdapter.showInfo(response);
    case 'success':
      return classicAdapter.showSuccess(response);
    case 'error':
      return classicAdapter.showError(response);
    case 'confirm':
      return classicAdapter.showConfirm(response);
    case 'list':
      return classicAdapter.showList(response);
    case 'form':
      return classicAdapter.showForm(response);
    default:
      console.log(`[${response.type}] ${response.title || ''}: ${response.message}`);
  }
}

module.exports = { renderResponse };
