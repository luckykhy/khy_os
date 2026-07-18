/**
 * catalogPrompt — LLM-facing projection of the workflow node catalog.
 *
 * The projection is DERIVED from NODE_CATALOG (single source of truth), so these
 * tests assert it covers every catalog node type and every category, and that
 * the output contract states the hard rules the generator depends on. No drift:
 * adding a node type to nodeCatalog must flow into the prompt automatically.
 */
'use strict';

const {
  getNodeSpecs,
  getOutputContract,
  buildCatalogPrompt,
} = require('@khy/shared/workflow/catalogPrompt');
const { NODE_CATALOG, CATEGORIES } = require('@khy/shared/workflow/nodeCatalog');

describe('catalogPrompt projection', () => {
  test('getNodeSpecs covers every catalog node type, no extras', () => {
    const specTypes = getNodeSpecs().map((s) => s.type).sort();
    const catTypes = NODE_CATALOG.map((n) => n.type).sort();
    expect(specTypes).toEqual(catTypes);
    // Sanity: the four known node types we rely on most must be present.
    expect(specTypes).toEqual(expect.arrayContaining(['start', 'end', 'ifElse', 'loop']));
  });

  test('each spec exposes ports + config fields from the catalog node', () => {
    const byType = new Map(NODE_CATALOG.map((n) => [n.type, n]));
    for (const spec of getNodeSpecs()) {
      const node = byType.get(spec.type);
      expect(node).toBeTruthy();
      expect(spec.label).toBe(node.label);
      expect(spec.category).toBe(node.category);
      expect(spec.inputs).toEqual((node.inputs || []).map((p) => p.id));
      expect(spec.outputs).toEqual((node.outputs || []).map((p) => p.id));
    }
  });

  test('buildCatalogPrompt mentions every node type and category', () => {
    const prompt = buildCatalogPrompt();
    for (const n of NODE_CATALOG) {
      expect(prompt).toContain(n.type);
    }
    for (const c of CATEGORIES) {
      // Categories that actually contain nodes must appear by label.
      if (NODE_CATALOG.some((n) => n.category === c.id)) {
        expect(prompt).toContain(c.label);
      }
    }
  });

  test('output contract states the validator hard rules', () => {
    const contract = getOutputContract();
    expect(contract).toMatch(/start/);
    expect(contract).toMatch(/end/);
    expect(contract).toContain('branch-true');
    expect(contract).toContain('branch-false');
    expect(contract).toContain('loop-body');
    expect(contract).toContain('loop-done');
    expect(contract).toContain('"connections"');
    expect(contract).toContain('"nodes"');
  });

  test('branch/loop nodes advertise their special ports', () => {
    const specs = new Map(getNodeSpecs().map((s) => [s.type, s]));
    expect(specs.get('ifElse').outputs).toEqual(
      expect.arrayContaining(['branch-true', 'branch-false']),
    );
    expect(specs.get('loop').outputs).toEqual(
      expect.arrayContaining(['loop-body', 'loop-done']),
    );
  });
});
