/**
 * Schema Compressor — compress JSON Schema tool definitions to minimize tokens.
 *
 * Converts verbose JSON Schema into a compact type notation:
 *   { "type": "object", "properties": { "name": { "type": "string" }, "age": { "type": "integer" } } }
 *   → {name:s,age:i}
 *
 * Type abbreviations:
 *   s = string, i = integer, n = number, b = boolean, a = array, o = object, ? = nullable
 *
 * Typical compression: 60-80% token reduction on tool schemas.
 */

const TYPE_MAP = {
  string: 's',
  integer: 'i',
  number: 'n',
  boolean: 'b',
  array: 'a',
  object: 'o',
  null: '0',
};

/**
 * Compress a JSON Schema into compact type notation.
 */
function compressSchema(schema) {
  if (!schema || typeof schema !== 'object') return String(schema);
  return _compressNode(schema);
}

function _compressNode(node) {
  if (!node || typeof node !== 'object') return '?';

  // Handle anyOf / oneOf (nullable patterns)
  if (node.anyOf || node.oneOf) {
    const variants = (node.anyOf || node.oneOf)
      .filter(v => v.type !== 'null')
      .map(v => _compressNode(v));
    const hasNull = (node.anyOf || node.oneOf).some(v => v.type === 'null');
    const base = variants.join('|');
    return hasNull ? `${base}?` : base;
  }

  // Enum → literal values
  if (node.enum) {
    return node.enum.map(v => JSON.stringify(v)).join('|');
  }

  // Const
  if (node.const !== undefined) {
    return JSON.stringify(node.const);
  }

  const type = node.type;

  // Object with properties
  if (type === 'object' && node.properties) {
    const required = new Set(node.required || []);
    const parts = [];
    for (const [key, val] of Object.entries(node.properties)) {
      const compressed = _compressNode(val);
      const opt = required.has(key) ? '' : '?';
      parts.push(`${key}:${compressed}${opt}`);
    }
    return `{${parts.join(',')}}`;
  }

  // Array with items
  if (type === 'array') {
    if (node.items) {
      return `[${_compressNode(node.items)}]`;
    }
    return '[?]';
  }

  // Simple type
  if (type && TYPE_MAP[type]) {
    // Include constraints that affect semantics
    const extras = [];
    if (node.format) extras.push(node.format);
    if (node.minimum !== undefined) extras.push(`>=${node.minimum}`);
    if (node.maximum !== undefined) extras.push(`<=${node.maximum}`);
    if (node.pattern) extras.push(`/${node.pattern}/`);
    if (node.maxLength) extras.push(`max${node.maxLength}`);

    const base = TYPE_MAP[type];
    return extras.length > 0 ? `${base}(${extras.join(',')})` : base;
  }

  // Array type
  if (Array.isArray(type)) {
    return type.map(t => TYPE_MAP[t] || t).join('|');
  }

  // Fallback
  return TYPE_MAP[type] || '?';
}

/**
 * Decompress compact notation back to JSON Schema (best-effort).
 */
function decompressSchema(compact) {
  // Reverse map for basic reconstruction
  const REVERSE = { s: 'string', i: 'integer', n: 'number', b: 'boolean', a: 'array', o: 'object' };

  if (!compact || typeof compact !== 'string') return {};

  if (compact.startsWith('{') && compact.endsWith('}')) {
    const inner = compact.slice(1, -1);
    const props = {};
    const required = [];

    for (const part of _splitTopLevel(inner)) {
      const colonIdx = part.indexOf(':');
      if (colonIdx === -1) continue;
      const key = part.slice(0, colonIdx);
      let valStr = part.slice(colonIdx + 1);
      const optional = valStr.endsWith('?') && !valStr.endsWith('|?');
      if (optional) valStr = valStr.slice(0, -1);
      if (!optional) required.push(key);
      props[key] = decompressSchema(valStr);
    }

    const result = { type: 'object', properties: props };
    if (required.length > 0) result.required = required;
    return result;
  }

  if (compact.startsWith('[') && compact.endsWith(']')) {
    return { type: 'array', items: decompressSchema(compact.slice(1, -1)) };
  }

  if (REVERSE[compact]) return { type: REVERSE[compact] };

  return {};
}

/**
 * Split a comma-separated string respecting nested braces/brackets.
 */
function _splitTopLevel(str) {
  const parts = [];
  let depth = 0;
  let current = '';

  for (const ch of str) {
    if (ch === '{' || ch === '[') depth++;
    if (ch === '}' || ch === ']') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current) parts.push(current);
  return parts;
}

/**
 * Compress an OpenAI-style tool definition array.
 * Returns compressed tools + stats.
 */
function compressTools(tools) {
  if (!Array.isArray(tools)) return { tools, stats: null };

  const originalJson = JSON.stringify(tools);
  const compressed = tools.map(tool => {
    if (!tool.function?.parameters) return tool;
    return {
      ...tool,
      function: {
        ...tool.function,
        parameters: compressSchema(tool.function.parameters),
        _parametersCompact: true,
      },
    };
  });

  const compressedJson = JSON.stringify(compressed);
  const stats = {
    originalTokensEstimate: Math.ceil(originalJson.length / 4),
    compressedTokensEstimate: Math.ceil(compressedJson.length / 4),
    savedPercent: Math.round((1 - compressedJson.length / originalJson.length) * 100),
  };

  return { tools: compressed, stats };
}

module.exports = { compressSchema, decompressSchema, compressTools };
