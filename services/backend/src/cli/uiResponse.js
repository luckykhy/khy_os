'use strict';

/**
 * uiResponse.js — Unified UI response protocol for TUI and Classic modes.
 *
 * Commands return structured response objects. The UI adapter layer renders
 * them appropriately based on the active mode (TUI or Classic).
 *
 * Response types:
 *   - info:    Display information to the user
 *   - confirm: Ask user to confirm an action
 *   - list:    Ask user to select from a list
 *   - form:    Ask user to fill a form
 *   - error:   Display an error message
 *   - success: Display a success message
 */

/**
 * Create an info response.
 * @param {object} opts
 * @param {string} [opts.title] - Optional title
 * @param {string} opts.message - Main message
 * @param {object} [opts.details] - Optional structured data
 * @returns {object} Response object
 */
function info({ title, message, details }) {
  return { type: 'info', title, message, details, timestamp: Date.now() };
}

/**
 * Create a success response.
 * @param {object} opts
 * @param {string} opts.message - Success message
 * @param {string} [opts.title] - Optional title
 * @returns {object} Response object
 */
function success({ message, title }) {
  return { type: 'success', title, message, timestamp: Date.now() };
}

/**
 * Create an error response.
 * @param {object} opts
 * @param {string} opts.message - Error message
 * @param {string} [opts.title] - Optional title
 * @param {string} [opts.code] - Optional error code
 * @returns {object} Response object
 */
function error({ message, title, code }) {
  return { type: 'error', title, message, code, timestamp: Date.now() };
}

/**
 * Create a confirmation request.
 * @param {object} opts
 * @param {string} opts.message - Question to ask
 * @param {string} [opts.title] - Optional title
 * @param {boolean} [opts.default=false] - Default answer
 * @param {boolean} [opts.danger=false] - Mark as dangerous action
 * @param {string} [opts.confirmLabel] - Label for confirm button
 * @param {string} [opts.cancelLabel] - Label for cancel button
 * @returns {object} Response object
 */
function confirm({ message, title, default: defaultValue = false, danger = false, confirmLabel, cancelLabel }) {
  return {
    type: 'confirm',
    title,
    message,
    default: defaultValue,
    danger,
    confirmLabel,
    cancelLabel,
    timestamp: Date.now(),
  };
}

/**
 * Create a list selection request.
 * @param {object} opts
 * @param {string} opts.message - Prompt message
 * @param {Array<{id: string, label: string, description?: string, disabled?: boolean}>} opts.items
 * @param {string} [opts.title] - Optional title
 * @param {string} [opts.searchable=false] - Enable search/filter
 * @returns {object} Response object
 */
function list({ message, items, title, searchable = false }) {
  return { type: 'list', title, message, items, searchable, timestamp: Date.now() };
}

/**
 * Create a form input request.
 * @param {object} opts
 * @param {string} [opts.title] - Form title
 * @param {Array<{name: string, label: string, type: 'text'|'password'|'email'|'number', required?: boolean, placeholder?: string}>} opts.fields
 * @returns {object} Response object
 */
function form({ title, fields }) {
  return { type: 'form', title, fields, timestamp: Date.now() };
}

/**
 * Check if running in TUI mode.
 * @returns {boolean}
 */
function isTuiActive() {
  return process.env.KHY_INK_TUI_ACTIVE === '1';
}

module.exports = {
  info,
  success,
  error,
  confirm,
  list,
  form,
  isTuiActive,
};
