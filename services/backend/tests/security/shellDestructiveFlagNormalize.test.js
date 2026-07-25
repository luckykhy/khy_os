'use strict';

/**
 * shellDestructiveFlagNormalize.test.js — R1–R4 of /goal「做5轮khyos最值得治理的地方」.
 *
 * The destructive-command table in shellSafetyValidator had 4 flag-spelling /
 * order / case-sensitive holes that let common destructive spellings slip past
 * classification (analyzeCommand → safe:true):
 *   R1 rm 关键级只认 r-before-f 的 `-[a-z]*r[a-z]*f` → `rm -fr` / `rm -Rf`(大写)/
 *      `rm -rF` / `rm -r -f`(分开)全漏 critical(最危险:递归强删被放行);
 *   R2 git clean 只认 `-f` 子串、不覆盖 `--force`;
 *   R3 dd 只认 `if=` → `dd of=/dev/sda`(反向写盘)漏 critical;
 *   R4 chmod 只认八进制 777 → 符号式 `chmod a+rwx` / `chmod o+w` 漏 warning。
 * Gated by KHY_SHELL_DESTRUCTIVE_FLAG_NORMALIZE (default ON, strict superset);
 * OFF byte-reverts to the original DESTRUCTIVE_PATTERNS.
 */

const validator = require('../../src/services/shellSafetyValidator');

function withEnv(key, value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, key);
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try { return fn(); } finally {
    if (had) process.env[key] = prev; else delete process.env[key];
  }
}

const ON = (fn) => withEnv('KHY_SHELL_DESTRUCTIVE_FLAG_NORMALIZE', undefined, fn);
const OFF = (fn) => withEnv('KHY_SHELL_DESTRUCTIVE_FLAG_NORMALIZE', '0', fn);

// analyzeCommand → severity of the destructive risk, or null if none flagged.
function destructiveSeverity(cmd) {
  const report = validator.analyzeCommand(cmd);
  const risk = (report.risks || []).find((r) => r.type === 'destructive_command');
  return risk ? risk.severity : null;
}

describe('exports the gated strict table + selector', () => {
  test('DESTRUCTIVE_PATTERNS_STRICT and _selectDestructivePatterns are exported', () => {
    expect(Array.isArray(validator.DESTRUCTIVE_PATTERNS_STRICT)).toBe(true);
    expect(typeof validator._selectDestructivePatterns).toBe('function');
  });

  test('selector returns strict ON, original OFF', () => {
    ON(() => expect(validator._selectDestructivePatterns()).toBe(validator.DESTRUCTIVE_PATTERNS_STRICT));
    OFF(() => expect(validator._selectDestructivePatterns()).toBe(validator.DESTRUCTIVE_PATTERNS));
  });

  test('strict is a superset (>= original length)', () => {
    expect(validator.DESTRUCTIVE_PATTERNS_STRICT.length).toBeGreaterThanOrEqual(validator.DESTRUCTIVE_PATTERNS.length);
  });
});

describe('R1: rm recursive-force order/case holes now classify critical (ON)', () => {
  const criticalSpellings = [
    'rm -rf /tmp/x',      // canonical (was already caught)
    'rm -fr /tmp/x',      // reversed order — was MISSED
    'rm -Rf /tmp/x',      // uppercase R — was MISSED
    'rm -rF /tmp/x',      // uppercase F — was MISSED
    'rm -r -f /tmp/x',    // split flags — was MISSED
    'rm --recursive --force /tmp/x',
    'rm -rfv /tmp/x',     // extra flag cluster — was MISSED
  ];
  test.each(criticalSpellings)('%s → critical', (cmd) => {
    ON(() => expect(destructiveSeverity(cmd)).toBe('critical'));
  });

  test('plain rm -r (no force) stays warning, rm -f (no recursive) not critical', () => {
    ON(() => {
      expect(destructiveSeverity('rm -r /tmp/x')).toBe('warning');
      expect(destructiveSeverity('rm -f file')).not.toBe('critical');
    });
  });

  test('OFF byte-reverts: reversed/uppercase spellings are NOT critical', () => {
    OFF(() => {
      // canonical still critical
      expect(destructiveSeverity('rm -rf /tmp/x')).toBe('critical');
      // but the holes reopen under the legacy table
      expect(destructiveSeverity('rm -fr /tmp/x')).not.toBe('critical');
      expect(destructiveSeverity('rm -Rf /tmp/x')).not.toBe('critical');
    });
  });
});

describe('R2: git clean force cluster', () => {
  test.each(['git clean -xdf', 'git clean -fdx', 'git clean -f', 'git clean --force'])(
    'ON: %s → warning',
    (cmd) => ON(() => expect(destructiveSeverity(cmd)).toBe('warning')),
  );

  test('OFF: -xdf (f not hyphen-adjacent) reopens the gap', () => {
    OFF(() => {
      // legacy `.*-f` needs a hyphen immediately before f: -fdx / -f / --force still caught
      expect(destructiveSeverity('git clean -fdx')).toBe('warning');
      expect(destructiveSeverity('git clean --force')).toBe('warning');
      // but `-xdf` has f preceded by `d`, no `-f` substring → legacy MISSED it
      expect(destructiveSeverity('git clean -xdf')).not.toBe('warning');
    });
  });
});

describe('R3: dd reverse disk write (of=)', () => {
  test('ON: dd of=<device> without if= → critical', () => {
    ON(() => {
      expect(destructiveSeverity('dd of=/dev/sda bs=1M')).toBe('critical');
      expect(destructiveSeverity('dd if=/dev/zero of=/dev/sda')).toBe('critical');
    });
  });

  test('OFF: of=-only reverts to unflagged (legacy keyed on if=)', () => {
    OFF(() => {
      expect(destructiveSeverity('dd if=/dev/zero of=/dev/sda')).toBe('critical'); // still if=
      expect(destructiveSeverity('dd of=/dev/sda bs=1M')).not.toBe('critical');    // hole reopens
    });
  });
});

describe('R4: chmod symbolic world-writable', () => {
  test.each(['chmod a+rwx file', 'chmod o+w file', 'chmod a+w file', 'chmod -R a+rwx dir', 'chmod ugo+w file'])(
    'ON: %s → warning',
    (cmd) => ON(() => expect(destructiveSeverity(cmd)).toBe('warning')),
  );

  test('ON: octal 777 still warning (original entry preserved)', () => {
    ON(() => expect(destructiveSeverity('chmod 777 file')).toBe('warning'));
  });

  test('ON: owner/group-only + non-write symbolic are NOT flagged (no false positive)', () => {
    ON(() => {
      expect(destructiveSeverity('chmod u+w file')).toBeNull();
      expect(destructiveSeverity('chmod g+w file')).toBeNull();
      expect(destructiveSeverity('chmod a+x file')).toBeNull();
      expect(destructiveSeverity('chmod 644 file')).toBeNull();
    });
  });

  test('OFF: symbolic world-writable reopens (legacy only knew octal 777)', () => {
    OFF(() => {
      expect(destructiveSeverity('chmod 777 file')).toBe('warning'); // octal still caught
      expect(destructiveSeverity('chmod a+rwx file')).toBeNull();    // symbolic hole reopens
    });
  });
});

describe('non-destructive commands never flagged (both gate states)', () => {
  test.each(['ls -la', 'git status', 'rm file', 'echo hi', 'grep -r foo .'])('%s → no destructive risk', (cmd) => {
    ON(() => expect(destructiveSeverity(cmd)).toBeNull());
    OFF(() => expect(destructiveSeverity(cmd)).toBeNull());
  });
});

describe('fail-soft', () => {
  test('analyzeCommand never throws on odd input', () => {
    expect(() => validator.analyzeCommand('')).not.toThrow();
    expect(() => validator.analyzeCommand('   ')).not.toThrow();
  });
});
