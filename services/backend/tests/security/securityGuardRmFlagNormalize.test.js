'use strict';

/**
 * securityGuardRmFlagNormalize.test.js — R2 of /goal「做5轮khyos最值得治理的地方」(fourth batch).
 *
 * securityGuardService is the SECOND security layer (analyzeInput → analyzeCommand,
 * reached via queryEngine). Its DANGEROUS_COMMAND_PATTERNS `rm -rf ~` rule keys on
 * the canonical `-rf` cluster only. The consumer lowercases before matching, so
 * UPPERCASE (`-Rf`/`-rF`) is already covered — but ORDER (`rm -fr ~`), SPLIT flags
 * (`rm -r -f ~`), LONG form (`rm --recursive --force ~`) and EXTRA-flag clusters
 * (`rm -rfv ~`) all miss → a home-directory wipe classified safe. The strict superset
 * (KHY_SECURITY_GUARD_RM_FLAG_NORMALIZE, default ON) replaces just the home-dir entry
 * with an order/split/long-form-tolerant regex; OFF byte-reverts to the original table.
 */

const guard = require('../../src/services/securityGuardService');

function withEnv(key, value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, key);
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try { return fn(); } finally {
    if (had) process.env[key] = prev; else delete process.env[key];
  }
}

const ON = (fn) => withEnv('KHY_SECURITY_GUARD_RM_FLAG_NORMALIZE', undefined, fn);
const OFF = (fn) => withEnv('KHY_SECURITY_GUARD_RM_FLAG_NORMALIZE', '0', fn);

// analyzeCommand → true when a recursive_delete threat was flagged.
function flagsHomeWipe(cmd) {
  const r = guard.analyzeCommand(cmd);
  return !r.safe && (r.threats || []).some((t) => t.type === 'recursive_delete');
}

describe('exports the gated strict table + selector', () => {
  test('DANGEROUS_COMMAND_PATTERNS_STRICT and _selectDangerousPatterns are exported', () => {
    expect(Array.isArray(guard.DANGEROUS_COMMAND_PATTERNS_STRICT)).toBe(true);
    expect(typeof guard._selectDangerousPatterns).toBe('function');
  });

  test('selector returns strict ON, original OFF', () => {
    ON(() => expect(guard._selectDangerousPatterns()).toBe(guard.DANGEROUS_COMMAND_PATTERNS_STRICT));
    OFF(() => expect(guard._selectDangerousPatterns()).toBe(guard.DANGEROUS_COMMAND_PATTERNS));
  });

  test('strict is a same-length superset (only the home-dir entry is swapped)', () => {
    expect(guard.DANGEROUS_COMMAND_PATTERNS_STRICT.length).toBe(guard.DANGEROUS_COMMAND_PATTERNS.length);
  });
});

describe('R2: home-dir rm order/split/long-form now flagged critical (ON)', () => {
  const spellings = [
    'rm -rf ~',                    // canonical (already caught)
    'rm -fr ~',                    // reversed order — was MISSED
    'rm -Rf ~',                    // uppercase R (lower already covered)
    'rm -rF ~',                    // uppercase F
    'rm -r -f ~',                  // split flags — was MISSED
    'rm --recursive --force ~',    // long form — was MISSED
    'rm --force --recursive ~',    // long form reversed
    'rm -rfv ~',                   // extra flag cluster — was MISSED
  ];
  test.each(spellings)('%s → recursive_delete critical', (cmd) => {
    ON(() => expect(flagsHomeWipe(cmd)).toBe(true));
  });

  test('non-destructive rm variants stay unflagged (no false positives)', () => {
    ON(() => {
      expect(flagsHomeWipe('rm -r ~')).toBe(false);   // recursive only, no force
      expect(flagsHomeWipe('rm -f ~')).toBe(false);   // force only, no recursive
      expect(flagsHomeWipe('rm -i ~')).toBe(false);   // interactive
      expect(flagsHomeWipe('rm ~/tmp/file')).toBe(false);
    });
  });

  test('the root-filesystem rule is hardened by the same swap', () => {
    ON(() => {
      expect(flagsHomeWipe('rm -rf /')).toBe(true);
      expect(flagsHomeWipe('rm -fr /')).toBe(true);   // combined-reversed root cluster — was MISSED
      expect(flagsHomeWipe('rm -rfv /')).toBe(true);  // extra-flag root cluster — was MISSED
      expect(flagsHomeWipe('rm -rf /home')).toBe(false); // a path, not root — not swept in
    });
  });
});

describe('R2: OFF byte-reverts (order/split/long-form holes reopen)', () => {
  test('canonical still flagged, siblings revert to safe', () => {
    OFF(() => {
      expect(flagsHomeWipe('rm -rf ~')).toBe(true);   // canonical still caught
      expect(flagsHomeWipe('rm -fr ~')).toBe(false);  // hole reopens
      expect(flagsHomeWipe('rm -r -f ~')).toBe(false);
      expect(flagsHomeWipe('rm --recursive --force ~')).toBe(false);
      expect(flagsHomeWipe('rm -rfv ~')).toBe(false);
      // root combined-reversed hole also reopens under legacy
      expect(flagsHomeWipe('rm -rf /')).toBe(true);   // canonical root still caught
      expect(flagsHomeWipe('rm -fr /')).toBe(false);  // legacy root hole reopens
    });
  });
});

describe('R2: fail-soft', () => {
  test('analyzeCommand never throws on odd input under either gate state', () => {
    ON(() => expect(() => guard.analyzeCommand('')).not.toThrow());
    OFF(() => expect(() => guard.analyzeCommand('   ')).not.toThrow());
  });
});
