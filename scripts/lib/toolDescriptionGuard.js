'use strict';

/**
 * toolDescriptionGuard.js — tool-description quality guard (pure leaf: 零 IO、
 * 确定性、绝不抛). env gate KHY_TOOL_DESC_GUARD (default on; only explicit
 * 0/false/off/no disables → empty findings).
 *
 * Machine-enforces the Tool Description Guidelines documented at the top of
 * services/backend/src/tools/_baseTool.js so future edits cannot silently
 * degrade description quality below what the rewritten high-frequency tools
 * now guarantee. Input is an array of tool definitions (registry values —
 * the caller does all IO/require); output is a diagnostics array.
 *
 * Five rules (severity per spec; the CLI shell decides blocking policy):
 *   1. desc-missing        (error)   description empty or missing.
 *   2. desc-overlong       (warning) description longer than 600 characters.
 *   3. param-desc-missing  (error)   required parameter lacks a description.
 *   4. param-naming-mixed  (warning) snake_case and camelCase parameter names
 *      mixed within one tool (single-word names are style-neutral).
 *   5. enum-example-missing(warning) enum parameter has no `example` field.
 *
 * Supports both inputSchema shapes found in the registry: the flat defineTool
 * shape `{ key: { type, required, description, enum, example } }` and the
 * JSON-Schema shape `{ type: 'object', properties, required: [] }` used by
 * BaseTool subclasses.
 */

// ── env gate (default on; only 0/false/off/no disables) ─────────────
const OFF = new Set(['0', 'false', 'off', 'no']);
function isEnabled(env) {
  const v = (env || process.env || {}).KHY_TOOL_DESC_GUARD;
  return !(v !== undefined && OFF.has(String(v).trim().toLowerCase()));
}

// Single source for the length ceiling from the guidelines (<= 600 chars).
const MAX_DESCRIPTION_LENGTH = 600;

// Multi-word style probes. A name counts as snake_case only when an
// underscore separates word characters; camelCase only when a lower→upper
// transition exists. Plain single words ('path', 'symbol') match neither,
// so they never contribute to a mixed-style finding.
const SNAKE_RE = /[a-z0-9]_[a-z0-9]/i;
const CAMEL_RE = /[a-z][A-Z]/;

/** Trim if string, else ''. */
function _s(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * Normalize either inputSchema shape into a flat parameter list:
 * [{ name, required, description, enum, example }]. Returns [] for
 * missing/invalid schemas. Deterministic, never throws.
 * @param {object} tool
 * @returns {Array<{name:string, required:boolean, description:string, enumValues:Array|null, example:*}>}
 */
function extractParams(tool) {
  const schema = tool && tool.inputSchema;
  if (!schema || typeof schema !== 'object') return [];

  // JSON-Schema shape (BaseTool subclasses): { type:'object', properties, required:[] }.
  if (schema.type === 'object' && schema.properties && typeof schema.properties === 'object') {
    const requiredList = Array.isArray(schema.required) ? schema.required : [];
    return Object.keys(schema.properties).map((name) => {
      const spec = schema.properties[name] && typeof schema.properties[name] === 'object'
        ? schema.properties[name] : {};
      return {
        name,
        required: requiredList.includes(name),
        description: _s(spec.description),
        enumValues: Array.isArray(spec.enum) ? spec.enum : null,
        example: spec.example,
      };
    });
  }

  // Flat defineTool shape: { key: { type, required, description, enum, example } }.
  return Object.keys(schema).map((name) => {
    const spec = schema[name] && typeof schema[name] === 'object' ? schema[name] : {};
    return {
      name,
      required: spec.required === true,
      description: _s(spec.description),
      enumValues: Array.isArray(spec.enum) ? spec.enum : null,
      example: spec.example,
    };
  });
}

/**
 * Audit one tool definition; append findings to out. Never throws.
 * @param {object} tool
 * @param {Array} out
 */
function _auditTool(tool, out) {
  if (!tool || typeof tool !== 'object') {
    out.push({ severity: 'error', rule: 'desc-missing', tool: '(non-object)', message: 'registry entry is not an object — no description to audit' });
    return;
  }
  const label = _s(tool.name) || '(unnamed)';

  // Rule 1: description empty or missing → error.
  const desc = _s(tool.description);
  if (!desc) {
    out.push({ severity: 'error', rule: 'desc-missing', tool: label, message: 'description is empty or missing (model cannot know what the tool does)' });
  } else if (desc.length > MAX_DESCRIPTION_LENGTH) {
    // Rule 2: description over the 600-character guideline ceiling → warning.
    out.push({ severity: 'warning', rule: 'desc-overlong', tool: label, message: `description is ${desc.length} chars, exceeds the ${MAX_DESCRIPTION_LENGTH}-char guideline (trim to the three required elements)` });
  }

  const params = extractParams(tool);
  const snakeNames = [];
  const camelNames = [];
  for (const p of params) {
    // Rule 3: required parameter without a description → error.
    if (p.required && !p.description) {
      out.push({ severity: 'error', rule: 'param-desc-missing', tool: label, message: `required parameter '${p.name}' has no description (model cannot fill it correctly)` });
    }
    // Rule 5: enum parameter without an example field → warning.
    if (p.enumValues && p.example === undefined) {
      out.push({ severity: 'warning', rule: 'enum-example-missing', tool: label, message: `enum parameter '${p.name}' has no example field (add one so the model picks valid values)` });
    }
    if (SNAKE_RE.test(p.name)) snakeNames.push(p.name);
    else if (CAMEL_RE.test(p.name)) camelNames.push(p.name);
  }

  // Rule 4: snake_case and camelCase mixed within one tool → warning.
  if (snakeNames.length > 0 && camelNames.length > 0) {
    out.push({ severity: 'warning', rule: 'param-naming-mixed', tool: label, message: `parameter naming mixes snake_case (${snakeNames.join(', ')}) and camelCase (${camelNames.join(', ')}) — pick one style per tool` });
  }
}

/**
 * Audit an array of tool definitions. Pure function: deterministic, zero IO,
 * never throws. Gate off → empty findings.
 * @param {Array<object>} tools  registry values (defineTool or BaseTool instances)
 * @param {object} [env]
 * @returns {{findings:Array<{severity:string, rule:string, tool:string, message:string}>, errors:number, warnings:number, total:number}}
 */
function assessTools(tools, env = process.env) {
  const empty = { findings: [], errors: 0, warnings: 0, total: 0 };
  if (!isEnabled(env)) return empty;
  const list = Array.isArray(tools) ? tools : [];
  const findings = [];
  for (const tool of list) {
    try { _auditTool(tool, findings); }
    catch (e) {
      // Fail-soft: a broken entry becomes a finding, never an exception.
      findings.push({ severity: 'error', rule: 'guard', tool: _s(tool && tool.name) || '(unknown)', message: `description audit threw: ${e && e.message}` });
    }
  }
  const errors = findings.filter((f) => f.severity === 'error').length;
  const warnings = findings.filter((f) => f.severity === 'warning').length;
  return { findings, errors, warnings, total: list.length };
}

module.exports = {
  isEnabled,
  assessTools,
  extractParams,
  MAX_DESCRIPTION_LENGTH,
};
