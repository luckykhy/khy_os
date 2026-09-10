'use strict';

/**
 * tui/uiAdapter.js — TUI renderer for unified UI responses.
 *
 * Renders response objects using Ink/React components.
 *
 * NOTE: TUI mode cannot use inquirer (it conflicts with Ink for stdin).
 * For confirm/list/form, we use simple stderr-based fallbacks that don't
 * block the Ink event loop. Full implementations integrate with
 * PermissionsPrompt, ModelPicker, and FormFlow components via uiBridge.
 *
 * 错误/信息渲染与 CLI formatters.js 对齐: 统一前缀 + 可选 title + 结构化输出。
 */

/**
 * Show info message in TUI.
 * @param {object} response
 */
function showInfo(response) {
  const prefix = response.title ? response.title + ': ' : '';
  process.stderr.write(`  i ${prefix}${response.message}\n`);
}

/**
 * Show success message in TUI.
 * @param {object} response
 */
function showSuccess(response) {
  process.stderr.write(`  ✓ ${response.message}\n`);
}

/**
 * Show error message in TUI.
 * 与 CLI printErrorPanel 对齐: 显示 title + message + code(如有)。
 * @param {object} response
 */
function showError(response) {
  const title = response.title || '';
  const code = response.code ? ` (${response.code})` : '';
  if (title) {
    process.stderr.write(`  ✗ ${title}${code}: ${response.message}\n`);
  } else {
    process.stderr.write(`  ✗ ${response.message}${code}\n`);
  }
}

/**
 * Show confirmation in TUI.
 * NOTE: This is a simplified fallback. Full implementation would use PermissionsPrompt.
 * @param {object} response
 * @returns {Promise<boolean>}
 */
async function showConfirm(response) {
  // Try native TUI component first (if App refs available)
  try {
    const bridge = require('./uiBridge');
    if (bridge.hasAppRefs()) {
      return bridge.showConfirmNative(response);
    }
  } catch {
    // Fall through to simple fallback
  }

  // TUI cannot use inquirer (conflicts with Ink). Use simple stderr prompt.
  // In production, this would integrate with PermissionsPrompt component.
  const prefix = response.danger ? '⚠ ' : '';
  process.stderr.write(`${prefix}${response.message} [y/N]: `);

  // Check if stdin is a TTY (setRawMode available)
  const stdin = process.stdin;
  if (typeof stdin.setRawMode !== 'function') {
    // Non-TTY environment: return default value
    process.stderr.write('\n');
    return response.default === true;
  }

  // Simple stdin read (non-blocking for Ink)
  return new Promise((resolve) => {
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();

    const onData = (chunk) => {
      const char = chunk.toString().toLowerCase();
      cleanup();
      if (char === 'y' || char === 'yes') {
        resolve(true);
      } else {
        resolve(false);
      }
    };

    const cleanup = () => {
      stdin.removeListener('data', onData);
      stdin.pause();
      if (!wasRaw) stdin.setRawMode(false);
    };

    stdin.once('data', onData);
  });
}

/**
 * Show list selection in TUI.
 * NOTE: Simplified fallback. Full implementation would use ModelPicker.
 * @param {object} response
 * @returns {Promise<string>} Selected item id
 */
async function showList(response) {
  // Try native TUI component first (if App refs available)
  try {
    const bridge = require('./uiBridge');
    if (bridge.hasAppRefs()) {
      return bridge.showListNative(response);
    }
  } catch {
    // Fall through to simple fallback
  }

  // TUI cannot use inquirer. Use simple numbered list on stderr.
  process.stderr.write(`${response.message}\n`);
  response.items.forEach((item, i) => {
    const desc = item.description ? ` (${item.description})` : '';
    process.stderr.write(`  ${i + 1}. ${item.label}${desc}\n`);
  });
  process.stderr.write('Enter number: ');

  // Check if stdin is a TTY (setRawMode available)
  const stdin = process.stdin;
  if (typeof stdin.setRawMode !== 'function') {
    // Non-TTY environment: return null (cancelled)
    process.stderr.write('\n');
    return null;
  }

  return new Promise((resolve) => {
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();

    let buf = '';
    const onData = (chunk) => {
      const char = chunk.toString();
      if (char === '\r' || char === '\n') {
        cleanup();
        const idx = parseInt(buf, 10) - 1;
        if (idx >= 0 && idx < response.items.length) {
          resolve(response.items[idx].id);
        } else {
          resolve(null);
        }
      } else if (char === '\x03') {
        // Ctrl+C
        cleanup();
        resolve(null);
      } else if (/\d/.test(char)) {
        buf += char;
      }
    };

    const cleanup = () => {
      stdin.removeListener('data', onData);
      stdin.pause();
      if (!wasRaw) stdin.setRawMode(false);
    };

    stdin.on('data', onData);
  });
}

/**
 * Show form input in TUI.
 * NOTE: Simplified fallback. Full implementation would use FormFlow.
 * @param {object} response
 * @returns {Promise<object>} Form values
 */
async function showForm(response) {
  // Try native TUI component first (if App refs available)
  try {
    const bridge = require('./uiBridge');
    if (bridge.hasAppRefs()) {
      return bridge.showFormNative(response);
    }
  } catch {
    // Fall through to simple fallback
  }

  // Simple fallback for non-TTY environments
  const result = {};
  for (const field of response.fields) {
    const value = await promptField(field);
    result[field.name] = value;
  }
  return result;
}

/**
 * Prompt a single field in TUI.
 * @param {object} field - Field definition
 * @returns {Promise<string>}
 */
function promptField(field) {
  return new Promise((resolve) => {
    const label = field.label + (field.required ? ' *' : '');
    process.stderr.write(`${label}: `);

    // Check if stdin is a TTY (setRawMode available)
    const stdin = process.stdin;
    if (typeof stdin.setRawMode !== 'function') {
      // Non-TTY environment: return null
      process.stderr.write('\n');
      resolve(null);
      return;
    }

    const wasRaw = stdin.isRaw;
    stdin.setRawMode(field.type === 'password');
    stdin.resume();

    let buf = '';
    const onData = (chunk) => {
      const char = chunk.toString();
      if (char === '\r' || char === '\n') {
        cleanup();
        if (!buf && field.required) {
          process.stderr.write(`${field.label} is required.\n`);
          // Re-prompt
          promptField(field).then(resolve);
        } else {
          resolve(buf);
        }
      } else if (char === '\x03') {
        // Ctrl+C
        cleanup();
        resolve(null);
      } else if (char === '\x7f') {
        // Backspace
        buf = buf.slice(0, -1);
      } else if (char >= ' ') {
        buf += char;
      }
    };

    const cleanup = () => {
      stdin.removeListener('data', onData);
      stdin.pause();
      if (!wasRaw) stdin.setRawMode(false);
    };

    stdin.on('data', onData);
  });
}

module.exports = {
  showInfo,
  showSuccess,
  showError,
  showConfirm,
  showList,
  showForm,
  promptField,
};
