'use strict';
/**
 * Tool category single-source-of-truth.
 *
 * The 2026-09-05 regression: six `*ExtendedTool`s declared `category =
 * 'multimodal'`, but the ToolRegistry's valid-category whitelist predates the
 * addition, so all six were silently dropped at startup
 * (`[ToolRegistry] Failed to load ... invalid category "multimodal"`). The
 * source tree later added `multimodal` to the registry, but the stale dist
 * bundle (built 08-31) still rejects them.
 *
 * Two category lists live in source and must never drift apart:
 *   - `_baseTool.CATEGORIES`      (the registry's category table)
 *   - `_toolHealer.VALID_CATEGORIES` (the healer's whitelist)
 *
 * This test pins: (1) the two lists are byte-identical as a set, (2)
 * `multimodal` is present in both, and (3) every extended tool's declared
 * category is a valid key. If anyone adds a category to one list but not the
 * other (or ships a stale bundle), this fails.
 */

const fs = require('node:fs');
const path = require('node:path');

const { CATEGORIES } = require('../src/tools/_baseTool');
const { VALID_CATEGORIES } = require('../src/tools/_toolHealer');

const EXTENDED_TOOL_DIRS = [
  'EmbeddingExtendedTool',
  'ImageGenExtendedTool',
  'VideoGenExtendedTool',
  'OCRExtendedTool',
  'STTExtendedTool',
  'TTSExtendedTool',
];

function toolCategory(dirName) {
  const indexFile = path.join(__dirname, '..', 'src', 'tools', dirName, 'index.js');
  const src = fs.readFileSync(indexFile, 'utf8');
  const m = src.match(/category\s*=\s*['"]([a-z]+)['"]/i) || src.match(/category:\s*['"]([a-z]+)['"]/i);
  return m ? m[1] : null;
}

describe('tool category single-source-of-truth', () => {
  test('the registry CATEGORIES and healer VALID_CATEGORIES agree as a set', () => {
    const registryKeys = new Set(Object.keys(CATEGORIES));
    const healerList = new Set(VALID_CATEGORIES);
    expect(registryKeys).toEqual(healerList);
  });

  test('multimodal is a recognized category in BOTH lists (09-05 regression pin)', () => {
    expect(Object.keys(CATEGORIES)).toContain('multimodal');
    expect(VALID_CATEGORIES).toContain('multimodal');
  });

  test('every extended tool declares a category that is valid in the registry', () => {
    const valid = new Set(Object.keys(CATEGORIES));
    for (const dir of EXTENDED_TOOL_DIRS) {
      const cat = toolCategory(dir);
      expect(cat).not.toBeNull();
      expect(valid.has(cat)).toBe(true);
    }
  });

  test('all six extended tools are multimodal-category tools', () => {
    for (const dir of EXTENDED_TOOL_DIRS) {
      expect(toolCategory(dir)).toBe('multimodal');
    }
  });
});
