'use strict';

/**
 * TUI Self-Heal — runtime ReferenceError auto-repair for React hooks.
 *
 * Catches patterns like `ReferenceError: gatewayProgress is not defined` that
 * occur when a setState setter is used without its useState declaration, then
 * injects the missing `const [xxx, setXxx] = React.useState(null);` line.
 *
 * Scope: only heals `setXxx` usage without matching `const [xxx, setXxx]` — the
 * safest, most deterministic fix. Refuses anything else.
 *
 * @module services/tuiSelfHeal
 */

const fs = require('fs');
const path = require('path');

/**
 * Try to heal a TUI crash error. Returns a result object:
 *   { healed: boolean, reason: string, detail?: string, file?: string }
 */
function tryHealTuiError(err) {
  if (!err || !(err instanceof ReferenceError)) {
    return { healed: false, reason: 'not-reference-error' };
  }

  const match = /^(\w+) is not defined$/.exec(String(err.message || '').trim());
  if (!match) {
    return { healed: false, reason: 'unrecognized-message' };
  }
  const varName = match[1];

  // Determine if this is a setter name (setFoo) or a state name (foo)
  let stateName;
  let setterName;

  if (/^set[A-Z]/.test(varName)) {
    // setter used without declaration: setFoo is not defined
    setterName = varName;
    stateName = varName.charAt(3).toLowerCase() + varName.slice(4);
  } else {
    // state variable used without declaration: foo is not defined
    // Check if a corresponding setter is used in the file
    stateName = varName;
    setterName = 'set' + varName.charAt(0).toUpperCase() + varName.slice(1);
  }

  // Parse stack to find the offending file
  const stack = err.stack || '';
  const fileMatch = stack.match(/\s+at\s+.+\s+\(([^)]+\.js):\d+:\d+\)/);
  if (!fileMatch) {
    return { healed: false, reason: 'no-file-in-stack' };
  }
  const filePath = fileMatch[1];

  // Read the file
  let src;
  try {
    src = fs.readFileSync(filePath, 'utf8');
  } catch {
    return { healed: false, reason: 'file-unreadable', file: filePath };
  }

  // Verify the setter is actually used in the file (confirms this is a missing useState)
  const setterRegex = new RegExp(`\\b${escapeRegex(setterName)}\\s*\\(`, 'g');
  if (!setterRegex.test(src)) {
    return { healed: false, reason: 'setter-not-used', detail: setterName };
  }

  // Check if the state variable is already declared
  const declaredRegex = new RegExp(
    `const\\s*\\[\\s*${escapeRegex(stateName)}\\s*,`,
    'm'
  );
  if (declaredRegex.test(src)) {
    return { healed: false, reason: 'already-declared', detail: stateName };
  }

  // Find insertion point: look for other useState declarations in the component
  // We want to insert near them for code locality.
  const lines = src.split('\n');
  let insertIndex = -1;

  // Strategy: find the first `const [something, setSomething] = React.useState(`
  // in the same function scope and insert right before it.
  const useStateRegex = /^\s*const\s*\[.*\]\s*=\s*React\.useState\(/;
  for (let i = 0; i < lines.length; i++) {
    if (useStateRegex.test(lines[i])) {
      insertIndex = i;
      break;
    }
  }

  // Fallback: find a `const xxx = React.useCallback` that uses our setter
  if (insertIndex === -1) {
    const useCallbackRegex = /^\s*const\s+\w+\s*=\s*React\.useCallback\(/;
    for (let i = 0; i < lines.length; i++) {
      if (useCallbackRegex.test(lines[i]) && src.includes(varName)) {
        insertIndex = i;
        break;
      }
    }
  }

  // Last resort: find any `const xxx = React.use` line
  if (insertIndex === -1) {
    const useRegex = /^\s*const\s+\w+\s*=\s*React\.use\w+/;
    for (let i = 0; i < lines.length; i++) {
      if (useRegex.test(lines[i])) {
        insertIndex = i;
        break;
      }
    }
  }

  if (insertIndex === -1) {
    return { healed: false, reason: 'no-insertion-point', file: filePath };
  }

  // Detect indentation of the target line
  const targetLine = lines[insertIndex];
  const indentMatch = /^(\s*)/.exec(targetLine);
  const indent = indentMatch ? indentMatch[1] : '  ';

  // Build the injection — include a comment flagging it as self-healed so it's
  // visible in diffs / git blame if the dev later reviews.
  const injection = `${indent}// [tui-self-heal] injected missing useState for ${setterName}\n${indent}const [${stateName}, ${setterName}] = React.useState(null);`;

  lines.splice(insertIndex, 0, injection);

  // Write back
  try {
    fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
  } catch {
    return { healed: false, reason: 'write-failed', file: filePath };
  }

  return {
    healed: true,
    reason: 'injected-usestate',
    file: filePath,
    detail: `Injected \`const [${stateName}, ${setterName}] = React.useState(null);\` at line ${insertIndex + 1}`,
    stateName,
    setterName,
  };
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = {
  tryHealTuiError,
};
