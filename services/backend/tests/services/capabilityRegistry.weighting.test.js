'use strict';

const { CapabilityRegistry } = require('../../src/services/gateway/capabilityRegistry');

describe('capabilityRegistry — capability-weighted selection (B3)', () => {
  const reqs = { text: 2, code: 3, tool_use: 2 };

  test('no weighting leaves the legacy capability ranking unchanged', () => {
    const reg = new CapabilityRegistry();
    const ranked = reg.bestAdaptersFor(reqs, { onlyAvailable: false, limit: 3 });
    for (const r of ranked) {
      expect(r.weight).toBe(0);
      expect(r.effective).toBe(r.score);
    }
    // Sorted by score descending.
    for (let i = 1; i < ranked.length; i++) {
      expect(ranked[i - 1].effective).toBeGreaterThanOrEqual(ranked[i].effective);
    }
  });

  test('rework rate + load weighting can reorder near-equal adapters', () => {
    const reg = new CapabilityRegistry();
    const weighting = {
      stats: {
        claude: { reworkRate: 0.9, activeCount: 5 }, // flaky + busy → penalized
        codex:  { reworkRate: 0.0, activeCount: 0 }, // reliable + idle → boosted
      },
    };
    const ranked = reg.bestAdaptersFor(reqs, { onlyAvailable: false, limit: 5, weighting });
    const claude = ranked.find(r => r.key === 'claude');
    const codex = ranked.find(r => r.key === 'codex');
    expect(codex.weight).toBeGreaterThan(claude.weight);
    // codex starts a point behind claude on raw capability but should overtake.
    expect(codex.effective).toBeGreaterThan(claude.effective);
  });

  test('skill-tag match adds a bounded boost', () => {
    const reg = new CapabilityRegistry();
    const weighting = {
      skills: ['python', 'async'],
      profiles: {
        codex: { skills: ['python', 'async', 'rust'] }, // 2 matches → +1.0
        claude: { skills: ['go'] },                      // 0 matches → +0
      },
    };
    const ranked = reg.bestAdaptersFor(reqs, { onlyAvailable: false, limit: 5, weighting });
    expect(ranked.find(r => r.key === 'codex').weight).toBeCloseTo(1.0, 5);
    expect(ranked.find(r => r.key === 'claude').weight).toBe(0);
  });

  test('skill-tag boost is capped at +1.5', () => {
    const reg = new CapabilityRegistry();
    const weighting = {
      skills: ['a', 'b', 'c', 'd', 'e'],
      profiles: { codex: { skills: ['a', 'b', 'c', 'd', 'e'] } }, // 5 matches → cap 1.5
    };
    const ranked = reg.bestAdaptersFor(reqs, { onlyAvailable: false, limit: 5, weighting });
    expect(ranked.find(r => r.key === 'codex').weight).toBeCloseTo(1.5, 5);
  });
});
