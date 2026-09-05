'use strict';

/**
 * tui/uiBridge.js — Bridge between unified protocol and native TUI components.
 *
 * Instead of using the simplified stdin-based fallbacks in uiAdapter.js,
 * this module provides functions that integrate with the existing
 * PermissionsPrompt, ModelPicker, and FormFlow components.
 *
 * This allows the unified protocol to use the full TUI experience
 * when running in TUI mode, while falling back to inquirer in classic mode.
 */

let _appRefs = null;

/**
 * Set the App component references for overlay management.
 * @param {object} refs - References to App state setters
 */
function setAppRefs(refs) {
  _appRefs = refs;
}

/**
 * Show confirmation using PermissionsPrompt component.
 * @param {object} response - Response object
 * @returns {Promise<boolean>}
 */
function showConfirmNative(response) {
  return new Promise((resolve) => {
    if (!_appRefs || !_appRefs.setPermissionRequest) {
      // Fallback to simple stdin
      const { showConfirm } = require('./uiAdapter');
      return showConfirm(response).then(resolve);
    }

    _appRefs.setPermissionRequest({
      toolName: response.title || 'Confirm',
      action: response.message,
      risk: response.danger ? 'high' : 'medium',
      onResolve: (result) => {
        resolve(result === 'allow' || result === 'always');
      },
    });
  });
}

/**
 * Show list selection using ModelPicker component.
 * @param {object} response - Response object
 * @returns {Promise<string>} Selected item id
 */
function showListNative(response) {
  return new Promise((resolve) => {
    if (!_appRefs || !_appRefs.setModelPicker) {
      // Fallback to simple stdin
      const { showList } = require('./uiAdapter');
      return showList(response).then(resolve);
    }

    _appRefs.setModelPicker({
      items: response.items.map((item) => ({
        id: item.id,
        name: item.label,
        description: item.description,
        disabled: item.disabled,
      })),
      message: response.message,
      onResolve: (result) => {
        resolve(result);
      },
    });
  });
}

/**
 * Show form using FormFlow component.
 * @param {object} response - Response object
 * @returns {Promise<object>} Form values
 */
function showFormNative(response) {
  return new Promise((resolve) => {
    if (!_appRefs || !_appRefs.setFormFlow) {
      // Fallback to simple stdin
      const { showForm } = require('./uiAdapter');
      return showForm(response).then(resolve);
    }

    _appRefs.setFormFlow({
      title: response.title,
      fields: response.fields.map((f) => ({
        name: f.name,
        label: f.label,
        type: f.type,
        required: f.required,
        placeholder: f.placeholder,
      })),
      onResolve: (result) => {
        resolve(result);
      },
    });
  });
}

module.exports = {
  setAppRefs,
  showConfirmNative,
  showListNative,
  showFormNative,
};
