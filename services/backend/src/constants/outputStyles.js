'use strict';

/**
 * Output style configuration system.
 * Ported from Claude Code's outputStyles.ts architecture.
 */

const BUILT_IN_STYLES = {
  'senior-engineer': {
    name: 'senior-engineer',
    prompt: [
      'Think and respond like a senior software engineer.',
      'For technical tasks, structure output as: 1) conclusion/status, 2) concrete implementation steps, 3) verification and risk notes.',
      'During execution, sound like a steady pair-programming partner: keep transitions short, natural, and lightly interactive.',
      'When a meaningful tool result arrives, briefly say what it changed and where you will go next.',
      'When giving a reason, make it useful for the next decision, not just conversational filler.',
      'Prefer concrete details (file paths, commands, constraints, measurable checks) over abstract advice.',
      'State assumptions briefly when needed, then proceed with the most practical execution path.',
      'Be concise but rigorous; avoid vague wording and generic templates.',
      'Between tool calls, always include a brief text line explaining what happened and what comes next.',
      'Never let two tool cards appear back-to-back without intervening narration.',
    ].join(' '),
    keepCodingInstructions: true,
  },
  concise: {
    name: 'concise',
    prompt: 'Be extremely concise. Respond in as few words as possible while being complete. No filler, no pleasantries.',
    keepCodingInstructions: true,
  },
  verbose: {
    name: 'verbose',
    prompt: 'Provide detailed, thorough explanations. Include context, examples, and edge cases.',
    keepCodingInstructions: true,
  },
  'code-only': {
    name: 'code-only',
    prompt: 'Respond with code only. No explanations unless explicitly asked. Use comments in code for context.',
    keepCodingInstructions: true,
  },
};

/**
 * Get output style config by name.
 * @param {string} [styleName] - Name of the output style
 * @returns {Promise<{ name: string, prompt: string, keepCodingInstructions: boolean }|null>}
 */
async function getOutputStyleConfig(styleName) {
  if (!styleName) {
    styleName = process.env.KHY_OUTPUT_STYLE || null;
  }
  if (!styleName) return null;

  const builtin = BUILT_IN_STYLES[styleName];
  if (builtin) return builtin;

  // Custom styles can be defined in .khy/output-styles/
  try {
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    const stylePath = path.join(os.homedir(), '.khy', 'output-styles', `${styleName}.md`);
    if (fs.existsSync(stylePath)) {
      const content = fs.readFileSync(stylePath, 'utf-8');
      return {
        name: styleName,
        prompt: content.trim(),
        keepCodingInstructions: true,
      };
    }
  } catch { /* ignore */ }

  return null;
}

/** Names that disable styling entirely (CC parity). */
const STYLE_OFF_VALUES = ['off', 'none', 'false', '0'];

/**
 * Resolve the active output-style name from the in-process env, mirroring the
 * resolution khyUpgradeRuntime applies when building the system prompt.
 * Returns the literal name (incl. 'off' family) or the default.
 *
 * @returns {string} active style name (default: 'senior-engineer')
 */
function getActiveOutputStyleName() {
  const raw = String(process.env.KHY_OUTPUT_STYLE || 'senior-engineer').trim();
  return raw || 'senior-engineer';
}

/**
 * Validate a candidate style name. A name is valid if it disables styling, is a
 * built-in style, or resolves to a custom `.khy/output-styles/<name>.md` file.
 *
 * @param {string} name
 * @returns {boolean}
 */
function isValidStyleName(name) {
  const raw = String(name || '').trim();
  if (!raw) return false;
  const key = raw.toLowerCase();
  if (STYLE_OFF_VALUES.includes(key)) return true;
  if (BUILT_IN_STYLES[raw] || BUILT_IN_STYLES[key]) return true;
  try {
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    return fs.existsSync(path.join(os.homedir(), '.khy', 'output-styles', `${raw}.md`));
  } catch {
    return false;
  }
}

module.exports = {
  getOutputStyleConfig,
  getActiveOutputStyleName,
  isValidStyleName,
  BUILT_IN_STYLES,
  STYLE_OFF_VALUES,
};
