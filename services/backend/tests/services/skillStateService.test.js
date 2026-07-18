'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolate the state ledger into a throwaway data home before requiring the
// service (dataHome caches KHY_DATA_HOME on first use).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-skillstate-'));
process.env.KHY_DATA_HOME = TMP;

const skillState = require('../../src/services/skillStateService');

afterAll(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('skillStateService — enable/disable ledger (A2)', () => {
  test('unknown skills are enabled by default (fail-open)', () => {
    expect(skillState.isEnabled('never-seen')).toBe(true);
    expect(skillState.isEnabled('')).toBe(true);
  });

  test('setEnabled persists and isEnabled reflects it', () => {
    skillState.setEnabled('alpha', false);
    expect(skillState.isEnabled('alpha')).toBe(false);
    skillState.setEnabled('alpha', true);
    expect(skillState.isEnabled('alpha')).toBe(true);
  });

  test('setEnabled requires a name', () => {
    expect(() => skillState.setEnabled('', false)).toThrow();
  });

  test('list returns explicit entries with enabled + updatedAt', () => {
    skillState.setEnabled('beta', false);
    const rows = skillState.list();
    const beta = rows.find(r => r.name === 'beta');
    expect(beta).toBeTruthy();
    expect(beta.enabled).toBe(false);
    expect(typeof beta.updatedAt).toBe('string');
  });

  test('a corrupt ledger fails open (everything enabled, no throw)', () => {
    fs.writeFileSync(skillState._stateFile(), '{ this is not json', 'utf8');
    expect(skillState.isEnabled('alpha')).toBe(true);
    // And a subsequent write heals the file.
    skillState.setEnabled('gamma', false);
    expect(skillState.isEnabled('gamma')).toBe(false);
  });
});
