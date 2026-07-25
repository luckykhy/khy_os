'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

// The module under test is an ESM file in the frontend tree, and this backend
// Jest setup has no ESM/babel module transform. The module is pure (no imports
// of its own), so we compile it as CommonJS in-process with a minimal ESM→CJS
// rewrite of its named function exports. The factory is built with `new
// Function` (evaluated in this test's realm) so the objects it returns share
// this realm's Object.prototype — required for assert.deepStrictEqual, which
// rejects cross-realm objects even when their contents are identical. This
// keeps the test self-contained without touching the global babel/jest config.
function loadModule() {
  const filePath = path.resolve(__dirname, '../../../apps/ai-frontend/src/views/aiChatEventUtils.js');
  let src = fs.readFileSync(filePath, 'utf8');

  const exportedNames = [];
  src = src.replace(/export\s+function\s+([A-Za-z0-9_$]+)/g, (_m, name) => {
    exportedNames.push(name);
    return `function ${name}`;
  });
  src += `\nmodule.exports = { ${exportedNames.join(', ')} };\n`;

  const factory = new Function('module', 'exports', 'require', src);
  const mod = { exports: {} };
  factory(mod, mod.exports, require);
  return mod.exports;
}

describe('AIChat control_request UI mapping', () => {
  let resolveAiChatThinkingEvent;
  let formatControlRequestText;

  beforeAll(() => {
    ({ resolveAiChatThinkingEvent, formatControlRequestText } = loadModule());
  });

  test('stream control_request maps to a control log item', async () => {
    const event = resolveAiChatThinkingEvent('stream', {
      type: 'control_request',
      requestId: 'req-12345678',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Bash',
      },
    });

    assert.deepStrictEqual(event, {
      type: 'control',
      text: '权限确认：AI 请求使用工具 Bash（req-1234）',
    });
  });

  test('ws control_request maps to the same visible control log item', async () => {
    const event = resolveAiChatThinkingEvent('ws', {
      type: 'control_request',
      requestId: 'req-abcdef12',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Bash',
      },
    });

    assert.deepStrictEqual(event, {
      type: 'control',
      text: '权限确认：AI 请求使用工具 Bash（req-abcd）',
    });
  });

  test('formatter falls back to readable command text for execute_command requests', async () => {
    const text = formatControlRequestText({
      requestId: 'req-99887766',
      request: {
        subtype: 'execute_command',
        command: 'npm run build -- --watch',
      },
    });

    assert.strictEqual(text, '权限确认：AI 请求执行命令 npm run build -- --watch（req-9988）');
  });
});
