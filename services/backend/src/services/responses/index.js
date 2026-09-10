'use strict';

/**
 * Responses API service — parse and validate structured responses from models.
 */

/**
 * Parse a model response for structured data.
 * Extracts JSON from markdown code blocks or raw JSON.
 * @param {string} response
 * @returns {object}
 */
function parseResponse(response) {
  if (!response || typeof response !== 'string') {
    return { success: false, error: 'Invalid response' };
  }

  // Try direct JSON parse first
  try {
    const data = JSON.parse(response);
    return { success: true, data, format: 'json' };
  } catch (e) {
    // Not direct JSON, try extracting from code blocks
  }

  // Try to extract JSON from markdown code blocks
  const codeBlockMatch = response.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/i);
  if (codeBlockMatch) {
    try {
      const data = JSON.parse(codeBlockMatch[1].trim());
      return { success: true, data, format: 'markdown_json' };
    } catch (e) {
      // Code block content is not valid JSON
    }
  }

  // Try to extract JSON from the response (find first { to last })
  const jsonMatch = response.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (jsonMatch) {
    try {
      const data = JSON.parse(jsonMatch[1]);
      return { success: true, data, format: 'extracted_json' };
    } catch (e) {
      // Extracted content is not valid JSON
    }
  }

  return { success: false, error: 'No valid JSON found in response' };
}

/**
 * Extract JSON from model response.
 * @param {string} response
 * @returns {object}
 */
function extractJson(response) {
  return parseResponse(response);
}

/**
 * Validate response against JSON schema.
 * Simple validation without external library.
 * @param {string} response
 * @param {object} schema
 * @returns {object}
 */
function validateSchema(response, schema) {
  const parsed = parseResponse(response);
  if (!parsed.success) {
    return parsed;
  }

  const data = parsed.data;
  const errors = [];

  if (schema.type === 'object' && typeof data !== 'object') {
    errors.push(`Expected object, got ${typeof data}`);
  }

  if (schema.required && Array.isArray(schema.required)) {
    for (const field of schema.required) {
      if (!(field in data)) {
        errors.push(`Missing required field: ${field}`);
      }
    }
  }

  if (schema.properties && typeof data === 'object') {
    for (const [key, prop] of Object.entries(schema.properties)) {
      if (key in data) {
        const value = data[key];
        if (prop.type === 'string' && typeof value !== 'string') {
          errors.push(`Field ${key}: expected string, got ${typeof value}`);
        } else if (prop.type === 'number' && typeof value !== 'number') {
          errors.push(`Field ${key}: expected number, got ${typeof value}`);
        } else if (prop.type === 'array' && !Array.isArray(value)) {
          errors.push(`Field ${key}: expected array, got ${typeof value}`);
        } else if (prop.type === 'boolean' && typeof value !== 'boolean') {
          errors.push(`Field ${key}: expected boolean, got ${typeof value}`);
        }
      }
    }
  }

  if (errors.length > 0) {
    return { success: false, errors };
  }

  return { success: true, data, valid: true };
}

module.exports = {
  parseResponse,
  extractJson,
  validateSchema,
};
