'use strict';
const {
  heal,
  healCategory,
  healRisk,
  healEnum,
  healType,
  isEnabled,
  VALID_CATEGORIES,
  VALID_RISK_LEVELS,
  VALID_INTERRUPT_BEHAVIORS,
  _levenshtein,
  _closestOption,
} = require('../../src/tools/_toolHealer');
// ── Env gating helper ─────────────────────────────────────────────────
function withEnv(key, val, fn) {
  const prev = process.env[key];
  if (val === undefined) delete process.env[key];
  else process.env[key] = val;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
}
// ── Levenshtein ───────────────────────────────────────────────────────
// ── _closestOption ────────────────────────────────────────────────────
// ── E2: healCategory ─────────────────────────────────────────────────
test('healCategory: typo "protocel" �?fuzzy to "mcp" or "custom"', () => {
  const result = healCategory('protocel');
  expect(result.repaired).toBe(true);
  expect(['mcp').toBeTruthy();
  expect(['fuzzy').toBeTruthy();
});
test('healCategory: "training" is valid', () => {
  const result = healCategory('training');
  expect(result.repaired).toBe(false);
  expect(result.value).toBe('training');
});
test('healCategory: "realtime" is valid', () => {
  const result = healCategory('realtime');
  expect(result.repaired).toBe(false);
  expect(result.value).toBe('realtime');
});
// ── E3: healRisk ──────────────────────────────────────────────────────
test('healRisk: typo "mdeium" �?fuzzy to "medium"', () => {
  const result = healRisk('mdeium');
  expect(result.repaired).toBe(true);
  expect(result.value).toBe('medium');
  expect(result.confidence).toBe('fuzzy');
});
test('healRisk: typo "hgh" �?fuzzy to "high"', () => {
  const result = healRisk('hgh');
  expect(result.repaired).toBe(true);
  expect(result.value).toBe('high');
});
test('healRisk: "critical" is valid', () => {
  const result = healRisk('critical');
  expect(result.repaired).toBe(false);
  expect(result.value).toBe('critical');
});
// ── E4: healEnum ──────────────────────────────────────────────────────
// ── E5: healType ──────────────────────────────────────────────────────
test('healType: string "true" �?boolean true', () => {
  const result = healType('true', 'boolean');
  expect(result.repaired).toBe(true);
  expect(result.value).toBe(true);
});
test('healType: string "false" �?boolean false', () => {
  const result = healType('false', 'boolean');
  expect(result.repaired).toBe(true);
  expect(result.value).toBe(false);
});
test('healType: string "yes" �?boolean true', () => {
  const result = healType('yes', 'boolean');
  expect(result.repaired).toBe(true);
  expect(result.value).toBe(true);
});
test('healType: string "0" �?boolean false', () => {
  const result = healType('0', 'boolean');
  expect(result.repaired).toBe(true);
  expect(result.value).toBe(false);
});
test('healType: string "42" �?number 42', () => {
  const result = healType('42', 'number');
  expect(result.repaired).toBe(true);
  expect(result.value).toBe(42);
});
test('healType: boolean true �?string "true"', () => {
  const result = healType(true, 'string');
  expect(result.repaired).toBe(true);
  expect(result.value).toBe('true');
});
test('healType: number 42 �?string "42"', () => {
  const result = healType(42, 'string');
  expect(result.repaired).toBe(true);
  expect(result.value).toBe('42');
});
// ── Unified heal() entry point ────────────────────────────────────────
test('heal: dispatches to healCategory for "category"', () => {
  const result = heal('category', 'dta');
  expect(result.repaired).toBe(true);
  expect(result.value).toBe('data');
});
test('heal: dispatches to healRisk for "risk"', () => {
  const result = heal('risk', 'mdeium');
  expect(result.repaired).toBe(true);
  expect(result.value).toBe('medium');
});
test('heal: dispatches to healEnum for "enum"', () => {
  const result = heal('enum', 'cancle', { validOptions: VALID_INTERRUPT_BEHAVIORS, fallback: 'cancel' });
  expect(result.repaired).toBe(true);
  expect(result.value).toBe('cancel');
});
test('heal: dispatches to healType for "type"', () => {
  const result = heal('type', 'true', { targetType: 'boolean' });
  expect(result.repaired).toBe(true);
  expect(result.value).toBe(true);
});
// ── Valid registries ──────────────────────────────────────────────────
// ── E5: healType edge cases ─────────────────────────────────────────
test('healType: string "on" �?boolean true', () => {
  const result = healType('on', 'boolean');
  expect(result.repaired).toBe(true);
  expect(result.value).toBe(true);
});
test('healType: string "off" �?boolean false', () => {
  const result = healType('off', 'boolean');
  expect(result.repaired).toBe(true);
  expect(result.value).toBe(false);
});
test('healType: string "1" �?boolean true', () => {
  const result = healType('1', 'boolean');
  expect(result.repaired).toBe(true);
  expect(result.value).toBe(true);
});
test('healType: string "no" �?boolean false', () => {
  const result = healType('no', 'boolean');
  expect(result.repaired).toBe(true);
  expect(result.value).toBe(false);
});
test('healType: string "3.14" �?number 3.14', () => {
  const result = healType('3.14', 'number');
  expect(result.repaired).toBe(true);
  expect(result.value).toBe(3.14);
});
test('healType: string "notanumber" �?not repaired', () => {
  const result = healType('notanumber', 'number');
  expect(result.repaired).toBe(false);
  expect(result.value).toBe('notanumber');
});
// ── Gating ────────────────────────────────────────────────────────────
// ── Learned Patterns (修复学习) ─────────────────────────────────────
const {
  learnPattern,
  getLearnedPattern,
  hasLearnedPattern,
  getAllLearnedPatterns,
  clearLearnedPatterns,
  healCategoryWithLearning,
  healRiskWithLearning,
  healEnumWithLearning,
} = require('../../src/tools/_toolHealer');
// ── Monitoring / Stats ──────────────────────────────────────────────
const { clearCategoryRepairs } = require('../../src/tools/_baseTool');
const { getRepairStats } = require('../../src/tools/_baseTool');
// ── defineTool E2/E3/E4/E5 integration ───────────────────────────────
const { defineTool } = require('../../src/tools/_baseTool');
test('defineTool: type-mismatch (string "true" �?boolean) is self-healed', () => {
  const tool = defineTool({
    name: 'TestTool4',
    description: 'test',
    shouldDefer: 'true',  // string instead of boolean
    alwaysLoad: 'false',
    execute: async () => ({}),
  });
  // shouldDefer and alwaysLoad are direct properties (booleans)
  expect(tool.shouldDefer).toBe(true);
  expect(tool.alwaysLoad).toBe(false);
});
test('defineTool: type-mismatch (string "20000" �?number) is self-healed', () => {
  const tool = defineTool({
    name: 'TestTool5',
    description: 'test',
    maxResultSizeChars: '15000',  // string instead of number
    execute: async () => ({}),
  });
  expect(tool.maxResultSizeChars).toBe(15000);
});

describe('Tool Healer', () => {
  test('_levenshtein: identical strings �?0', async () => {
      expect(_levenshtein('cat', 'cat')).toBe(0);
  });

  test('_levenshtein: one edit �?1', async () => {
      expect(_levenshtein('cat', 'bat')).toBe(1);
      expect(_levenshtein('cat', 'cats')).toBe(1);
      expect(_levenshtein('cat', 'at')).toBe(1);
  });

  test('_levenshtein: empty string �?length of other', async () => {
      expect(_levenshtein('', 'hello')).toBe(5);
      expect(_levenshtein('hello', '')).toBe(5);
  });

  test('_closestOption: exact match', async () => {
      const result = _closestOption('data', ['data', 'analysis', 'custom']);
      expect(result.match).toBe('data');
      expect(result.dist).toBe(0);
  });

  test('_closestOption: fuzzy match within distance 2', async () => {
      const result = _closestOption('dta', ['data', 'analysis', 'custom']);
      expect(result.match).toBe('data');
      expect(result.dist <= 2).toBeTruthy();
  });

  test('_closestOption: prefix match', async () => {
      const result = _closestOption('anal', ['data', 'analysis', 'custom']);
      expect(result.match).toBe('analysis');
  });

  test('_closestOption: no match �?null', async () => {
      const result = _closestOption('xyz', ['data', 'analysis', 'custom']);
      expect(result).toBe(null);
  });

  test('_closestOption: empty value �?null', async () => {
      const result = _closestOption('', ['data', 'analysis']);
      expect(result).toBe(null);
  });

  test('healCategory: valid category �?not repaired', async () => {
      const result = healCategory('data');
      expect(result.repaired).toBe(false);
      expect(result.value).toBe('data');
      expect(result.confidence).toBe('exact');
  });

  test('healCategory: empty �?fallback to custom', async () => {
      const result = healCategory('');
      expect(result.repaired).toBe(true);
      expect(result.value).toBe('custom');
      expect(result.confidence).toBe('fallback');
  });

  test('healCategory: null �?fallback to custom', async () => {
      const result = healCategory(null);
      expect(result.repaired).toBe(true);
      expect(result.value).toBe('custom');
  });

  test('healCategory: case-insensitive', async () => {
      const result = healCategory('DATA');
      expect(result.repaired).toBe(false);
      expect(result.value).toBe('data');
  });

  test('healRisk: valid risk �?not repaired', async () => {
      const result = healRisk('medium');
      expect(result.repaired).toBe(false);
      expect(result.value).toBe('medium');
  });

  test('healRisk: empty �?fallback to medium', async () => {
      const result = healRisk('');
      expect(result.repaired).toBe(true);
      expect(result.value).toBe('medium');
  });

  test('healEnum: valid value �?not repaired', async () => {
      const result = healEnum('cancel', VALID_INTERRUPT_BEHAVIORS, 'cancel');
      expect(result.repaired).toBe(false);
      expect(result.value).toBe('cancel');
  });

  test('healEnum: invalid �?fuzzy match', async () => {
      const result = healEnum('cancle', VALID_INTERRUPT_BEHAVIORS, 'cancel');
      expect(result.repaired).toBe(true);
      expect(result.value).toBe('cancel');
  });

  test('healEnum: empty �?fallback', async () => {
      const result = healEnum('', VALID_INTERRUPT_BEHAVIORS, 'block');
      expect(result.repaired).toBe(true);
      expect(result.value).toBe('block');
  });

  test('healEnum: no match �?fallback', async () => {
      const result = healEnum('xyz', VALID_INTERRUPT_BEHAVIORS, 'cancel');
      expect(result.repaired).toBe(true);
      expect(result.value).toBe('cancel');
      expect(result.confidence).toBe('fallback');
  });

  test('healType: correct type �?not repaired', async () => {
      const result = healType(true, 'boolean');
      expect(result.repaired).toBe(false);
      expect(result.value).toBe(true);
  });

  test('healType: null �?not repaired', async () => {
      const result = healType(null, 'boolean');
      expect(result.repaired).toBe(false);
      expect(result.value).toBe(null);
  });

  test('healType: uncoercible string �?not repaired', async () => {
      const result = healType('hello', 'boolean');
      expect(result.repaired).toBe(false);
      expect(result.value).toBe('hello');
  });

  test('heal: unknown class �?not repaired', async () => {
      const result = heal('unknown', 'value');
      expect(result.repaired).toBe(false);
      expect(result.value).toBe('value');
  });

  test('heal: disabled via env �?not repaired', async () => {
      withEnv('KHY_TOOL_HEAL', '0', () => {
        const result = heal('category', 'dta');
        expect(result.repaired).toBe(false);
        expect(result.value).toBe('dta');
      });
  });

  test('VALID_CATEGORIES includes all expected keys', async () => {
      expect(VALID_CATEGORIES).toContain('data');
      expect(VALID_CATEGORIES).toContain('coordinator');
      expect(VALID_CATEGORIES).toContain('training');
      expect(VALID_CATEGORIES).toContain('realtime');
      expect(VALID_CATEGORIES).toContain('custom');
  });

  test('VALID_RISK_LEVELS matches RISK_LEVELS', async () => {
      assert.deepEqual(VALID_RISK_LEVELS, ['safe', 'low', 'medium', 'high', 'critical']);
  });

  test('VALID_INTERRUPT_BEHAVIORS includes cancel and block', async () => {
      expect(VALID_INTERRUPT_BEHAVIORS).toContain('cancel');
      expect(VALID_INTERRUPT_BEHAVIORS).toContain('block');
  });

  test('healType: array is array �?not repaired', async () => {
      const result = healType([1, 2, 3], 'array');
      expect(result.repaired).toBe(false);
      assert.deepEqual(result.value, [1, 2, 3]);
  });

  test('healType: undefined �?not repaired', async () => {
      const result = healType(undefined, 'boolean');
      expect(result.repaired).toBe(false);
      expect(result.value).toBe(undefined);
  });

  test('isEnabled returns true by default', async () => {
      withEnv('KHY_TOOL_HEAL', undefined, () => {
        expect(isEnabled()).toBe(true);
      });
  });

  test('isEnabled returns false when env=0', async () => {
      withEnv('KHY_TOOL_HEAL', '0', () => {
        expect(isEnabled()).toBe(false);
      });
  });

  test('learnPattern: registers a manual fix pattern', async () => {
      clearLearnedPatterns();
      learnPattern('category', 'protocel', 'mcp');
      expect(hasLearnedPattern('category', 'protocel')).toBe(true);
      expect(getLearnedPattern('category', 'protocel')).toBe('mcp');
  });

  test('learnPattern: with context', async () => {
      clearLearnedPatterns();
      learnPattern('enum', 'cancle', 'cancel', 'interruptBehavior');
      expect(hasLearnedPattern('enum', 'cancle', 'interruptBehavior')).toBe(true);
      expect(getLearnedPattern('enum', 'cancle', 'interruptBehavior')).toBe('cancel');
  });

  test('getLearnedPattern: returns undefined for unknown pattern', async () => {
      clearLearnedPatterns();
      expect(getLearnedPattern('category', 'unknown')).toBe(undefined);
  });

  test('getAllLearnedPatterns: returns all registered patterns', async () => {
      clearLearnedPatterns();
      learnPattern('category', 'protocel', 'mcp');
      learnPattern('risk', 'mdeium', 'medium');
      const all = getAllLearnedPatterns();
      expect(all.length).toBe(2);
      expect(all.some(p => p.key === 'category:protocel' && p.value === 'mcp').toBeTruthy());
      expect(all.some(p => p.key === 'risk:mdeium' && p.value === 'medium').toBeTruthy());
  });

  test('clearLearnedPatterns: clears all patterns', async () => {
      learnPattern('category', 'x', 'y');
      clearLearnedPatterns();
      expect(getLearnedPattern('category', 'x')).toBe(undefined);
  });

  test('healCategoryWithLearning: uses learned pattern first', async () => {
      clearLearnedPatterns();
      learnPattern('category', 'protocel', 'mcp');
      const result = healCategoryWithLearning('protocel');
      expect(result.repaired).toBe(true);
      expect(result.value).toBe('mcp');
      expect(result.confidence).toBe('learned');
  });

  test('healCategoryWithLearning: falls back to fuzzy if no learned', async () => {
      clearLearnedPatterns();
      const result = healCategoryWithLearning('dta');  // distance 1 from 'data'
      expect(result.repaired).toBe(true);
      expect(result.confidence).toBe('fuzzy');
      expect(result.value).toBe('data');
  });

  test('healRiskWithLearning: uses learned pattern', async () => {
      clearLearnedPatterns();
      learnPattern('risk', 'mdeium', 'medium');
      const result = healRiskWithLearning('mdeium');
      expect(result.repaired).toBe(true);
      expect(result.value).toBe('medium');
      expect(result.confidence).toBe('learned');
  });

  test('healEnumWithLearning: uses learned pattern', async () => {
      clearLearnedPatterns();
      learnPattern('enum', 'cancle', 'cancel', 'interruptBehavior');
      const result = healEnumWithLearning('cancle', ['cancel', 'block'], 'cancel', 'interruptBehavior');
      expect(result.repaired).toBe(true);
      expect(result.value).toBe('cancel');
      expect(result.confidence).toBe('learned');
  });

  test('learned pattern takes priority over fuzzy match', async () => {
      clearLearnedPatterns();
      // Register a specific mapping that differs from fuzzy
      learnPattern('category', 'protocel', 'custom');
      const result = healCategoryWithLearning('protocel');
      expect(result.value).toBe('custom');  // learned, not fuzzy 'mcp'
      expect(result.confidence).toBe('learned');
  });

  test('getRepairStats: empty log returns zeros', async () => {
      clearCategoryRepairs();
      const stats = getRepairStats();
      expect(stats.total).toBe(0);
      assert.deepEqual(stats.byTool, {});
      assert.deepEqual(stats.byField, {});
      expect(stats.failures).toBe(0);
  });

  test('getRepairStats: tracks repairs by tool/field/confidence', async () => {
      clearCategoryRepairs();
      const { defineTool: dt } = require('../../src/tools/_baseTool');
      dt({ name: 'StatTool1', description: 't', category: 'protocel', risk: 'mdeium', execute: async () => ({}) });
      dt({ name: 'StatTool2', description: 't', category: 'dta', execute: async () => ({}) });
      const stats = getRepairStats();
      expect(stats.total >= 3).toBeTruthy();
      expect(stats.byTool['StatTool1'] >= 2).toBeTruthy();
      expect(stats.byTool['StatTool2'] >= 1).toBeTruthy();
      expect(stats.byField['category'] >= 2).toBeTruthy();
      expect(stats.byField['risk'] >= 1).toBeTruthy();
      clearCategoryRepairs();
  });

  test('defineTool: invalid category is self-healed', async () => {
      const tool = defineTool({
        name: 'TestTool',
        description: 'test',
        category: 'protocel',  // typo �?should fuzzy-match
        execute: async () => ({}),
      });
      // Should not throw; category should be repaired to a valid value
      expect(VALID_CATEGORIES).toContain(tool.category);
  });

  test('defineTool: invalid risk is self-healed', async () => {
      const tool = defineTool({
        name: 'TestTool2',
        description: 'test',
        risk: 'mdeium',  // typo �?should fuzzy-match to medium
        execute: async () => ({}),
      });
      expect(['safe').toBeTruthy();
  });

  test('defineTool: invalid interruptBehavior is self-healed', async () => {
      const tool = defineTool({
        name: 'TestTool3',
        description: 'test',
        interruptBehavior: 'cancle',  // typo �?should fuzzy-match to cancel
        execute: async () => ({}),
      });
      expect(['cancel').toBeTruthy();
  });

  test('defineTool: aliases as string is wrapped into array', async () => {
      const tool = defineTool({
        name: 'TestTool6',
        description: 'test',
        aliases: 'single-alias',  // string instead of array
        execute: async () => ({}),
      });
      expect(Array.isArray(tool.aliases).toBeTruthy());
      assert.deepEqual(tool.aliases, ['single-alias']);
  });

  test('defineTool: multiple errors in one tool are all self-healed', async () => {
      const tool = defineTool({
        name: 'MultiErrorTool',
        description: 'test',
        category: 'protocel',       // E2: invalid category
        risk: 'mdeium',             // E3: invalid risk
        interruptBehavior: 'cancle', // E4: invalid enum
        shouldDefer: 'true',        // E5: type mismatch
        aliases: 'myalias',         // E6: type mismatch
        execute: async () => ({}),
      });
      expect(VALID_CATEGORIES).toContain(tool.category);
      expect(['safe').toBeTruthy();
      expect(['cancel').toBeTruthy();
      expect(tool.shouldDefer).toBe(true);
      expect(Array.isArray(tool.aliases).toBeTruthy());
      assert.deepEqual(tool.aliases, ['myalias']);
  });

});

