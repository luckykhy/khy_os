'use strict';

const fs = require('fs');
const path = require('path');

describe('repl regression gate scope', () => {
  const replPath = path.resolve(__dirname, '../../src/cli/repl.js');

  test('declares regression gate state in outer loop scope before harness execution', () => {
    const source = fs.readFileSync(replPath, 'utf8');
    const declarationMatches = [...source.matchAll(/\blet _regressionGateResult = null;/g)];
    const loopIterationsIndex = source.indexOf('let loopIterations = 0;');
    const harnessIndex = source.indexOf('if (harnessEnabled) {');
    const summaryIndex = source.indexOf('if (_regressionGateResult) {');

    expect(declarationMatches).toHaveLength(1);
    expect(loopIterationsIndex).toBeGreaterThan(-1);
    expect(harnessIndex).toBeGreaterThan(-1);
    expect(summaryIndex).toBeGreaterThan(-1);

    const declarationIndex = declarationMatches[0].index;
    expect(declarationIndex).toBeGreaterThan(loopIterationsIndex);
    expect(declarationIndex).toBeLessThan(harnessIndex);
    expect(summaryIndex).toBeGreaterThan(harnessIndex);
  });
});
