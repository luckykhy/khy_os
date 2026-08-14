'use strict';

const fs = require('fs');
const path = require('path');

describe('pair-programming voice regression', () => {
  test('senior-engineer output style keeps pair-programming guidance', () => {
    const { BUILT_IN_STYLES } = require('../src/constants/outputStyles');
    expect(BUILT_IN_STYLES['senior-engineer'].prompt).toContain('steady pair-programming partner');
    expect(BUILT_IN_STYLES['senior-engineer'].prompt).toContain('briefly say what it changed');
    expect(BUILT_IN_STYLES['senior-engineer'].prompt).toContain('useful for the next decision');
  });

  test('runtime tool lifecycle prompt keeps collaborative progress guidance', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../src/services/khyUpgradeRuntime.js'),
      'utf8'
    );

    expect(source).toContain('Sound like a steady pair-programming partner working alongside the user');
    expect(source).toContain('Prefer first-person transition lines that feel like live collaboration');
    expect(source).toContain('After a meaningful tool result');
    expect(source).toContain('make it decision-shaping');
    expect(source).toContain('On failure, name the likely blocker briefly and immediately hint at the next adjustment');
    expect(source).toContain('Do NOT over-explain');
  });
});
