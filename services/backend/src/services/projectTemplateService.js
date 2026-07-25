'use strict';

/**
 * projectTemplateService.js
 *
 * Loads, matches, and renders project templates from src/templates/.
 * Templates produce scaffoldFiles-compatible output for batch project creation.
 */

const fs = require('fs');
const path = require('path');

const TEMPLATES_DIR = path.join(__dirname, '..', 'templates');

let _cache = null;

function loadTemplates() {
  if (_cache) return _cache;
  const templates = [];
  try {
    const files = fs.readdirSync(TEMPLATES_DIR).filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(TEMPLATES_DIR, file), 'utf-8');
        const tmpl = JSON.parse(raw);
        tmpl._filename = file;
        templates.push(tmpl);
      } catch { /* skip invalid templates */ }
    }
  } catch { /* templates dir may not exist */ }
  _cache = templates;
  return templates;
}

function clearCache() {
  _cache = null;
}

/**
 * Find a template whose triggers match user text (case-insensitive).
 * @param {string} userText
 * @returns {object|null} matched template or null
 */
function matchTemplate(userText) {
  if (!userText) return null;
  const lower = String(userText).toLowerCase();
  const templates = loadTemplates();
  for (const tmpl of templates) {
    if (!Array.isArray(tmpl.triggers)) continue;
    for (const trigger of tmpl.triggers) {
      if (lower.includes(String(trigger).toLowerCase())) {
        return tmpl;
      }
    }
  }
  return null;
}

/**
 * Render a template with variable values, producing scaffoldFiles-ready output.
 * @param {string} templateName - Template name (without .json)
 * @param {object} variables - Variable overrides { groupId: 'com.myapp', artifactId: 'myapp' }
 * @returns {{ directories: string[], files: Array<{path: string, content: string}>, variables: object }}
 */
function renderTemplate(templateName, variables = {}) {
  const templates = loadTemplates();
  const tmpl = templates.find(t => t.name === templateName);
  if (!tmpl) {
    throw new Error(`Template not found: ${templateName}. Available: ${templates.map(t => t.name).join(', ')}`);
  }

  // Merge user variables with defaults
  const vars = {};
  if (tmpl.variables) {
    for (const [key, def] of Object.entries(tmpl.variables)) {
      vars[key] = variables[key] || def.default || '';
    }
  }
  // Merge any extra user variables not in schema
  for (const [key, val] of Object.entries(variables)) {
    if (!(key in vars)) vars[key] = val;
  }

  // Compute derived variables
  if (vars.groupId) {
    vars.groupPath = vars.groupId.replace(/\./g, '/');
  }

  // Render all placeholders
  const render = (text) => {
    let result = String(text || '');
    for (const [key, val] of Object.entries(vars)) {
      result = result.split(`{${key}}`).join(val);
    }
    return result;
  };

  const directories = (tmpl.directories || []).map(render);
  const files = (tmpl.files || []).map(f => ({
    path: render(f.path),
    content: render(f.content || ''),
  }));

  return {
    name: tmpl.name,
    description: tmpl.description,
    directories,
    files,
    variables: vars,
  };
}

/**
 * List all available templates.
 * @returns {Array<{name: string, description: string, triggers: string[], variables: object}>}
 */
function listTemplates() {
  return loadTemplates().map(t => ({
    name: t.name,
    description: t.description,
    triggers: t.triggers || [],
    variables: t.variables || {},
  }));
}

module.exports = {
  loadTemplates,
  clearCache,
  matchTemplate,
  renderTemplate,
  listTemplates,
};
