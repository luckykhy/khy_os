'use strict';

/**
 * Windows / PowerShell blind spots in the shell command risk gate.
 *
 * The gate had two verified gaps (measured before this change):
 *   A. shellToToolMapper's DESTRUCTIVE_COMMANDS table was POSIX-only, so
 *      `del` / `erase` / `rd` / `Remove-Item` fell through to the unknown-command
 *      default (medium) with isDestructive=false.
 *   B. shellSafetyValidator's INTERPRETER_EVAL_SPECS covered 9 interpreter
 *      families but not PowerShell, so `powershell -Command` and the opaque
 *      `powershell -EncodedCommand <base64>` produced no signal at all.
 *
 * This suite also locks the PRE-EXISTING behaviour that must not regress, so a
 * fix here cannot be achieved by loosening the gate elsewhere.
 *
 * Written for Jest (global describe/test/expect) to match the neighbouring
 * commandRiskClassifier.test.js. Note: jest.config.js classifies suites by
 * string markers, so this file must not quote the Node built-in test runner's
 * import call anywhere — not even in a comment — or it gets misrouted.
 */

const { classifyCommandRisk, RISK_ORDER } = require('../../src/services/commandRiskClassifier');

describe('commandRiskClassifier — Windows / cmd delete vocabulary', () => {
  test('del /s /q is destructive and at least high', () => {
    const v = classifyCommandRisk(String.raw`del /s /q C:\Users\x`);
    expect(v.isDestructive).toBe(true);
    expect(v.isReadOnly).toBe(false);
    expect(RISK_ORDER[v.risk]).toBeGreaterThanOrEqual(RISK_ORDER.high);
  });

  test('erase is destructive and at least high', () => {
    const v = classifyCommandRisk(String.raw`erase C:\secret.txt`);
    expect(v.isDestructive).toBe(true);
    expect(RISK_ORDER[v.risk]).toBeGreaterThanOrEqual(RISK_ORDER.high);
  });

  test('rd /s /q is destructive and at least high', () => {
    const v = classifyCommandRisk(String.raw`rd /s /q C:\data`);
    expect(v.isDestructive).toBe(true);
    expect(RISK_ORDER[v.risk]).toBeGreaterThanOrEqual(RISK_ORDER.high);
  });

  test('Remove-Item -Recurse -Force is destructive and at least high', () => {
    const v = classifyCommandRisk(String.raw`Remove-Item -Recurse -Force C:\Windows\Temp`);
    expect(v.isDestructive).toBe(true);
    expect(RISK_ORDER[v.risk]).toBeGreaterThanOrEqual(RISK_ORDER.high);
  });

  test('Remove-ItemProperty is destructive and at least high', () => {
    const v = classifyCommandRisk(
      String.raw`Remove-ItemProperty -Path HKCU:\Software\X -Name Y`
    );
    expect(v.isDestructive).toBe(true);
    expect(RISK_ORDER[v.risk]).toBeGreaterThanOrEqual(RISK_ORDER.high);
  });

  test('case-insensitive: DEL / REMOVE-ITEM both match', () => {
    expect(classifyCommandRisk(String.raw`DEL C:\x.txt`).isDestructive).toBe(true);
    expect(classifyCommandRisk(String.raw`REMOVE-ITEM C:\x`).isDestructive).toBe(true);
  });

  test('token-level only: prose containing the words is not destructive', () => {
    // Guard against substring matching — these are safe read-only commands that
    // merely contain the characters d-e-l / r-d / item in their arguments.
    const a = classifyCommandRisk('cat deleted-records.md');
    expect(a.isDestructive).toBe(false);
    expect(a.risk).toBe('safe');

    const b = classifyCommandRisk('git status --porcelain');
    expect(b.isDestructive).toBe(false);
    expect(b.risk).toBe('safe');
  });
});

describe('commandRiskClassifier — PowerShell inline execution', () => {
  test('powershell -Command is flagged as inline eval (at least high)', () => {
    const v = classifyCommandRisk('powershell -Command "Get-Date"');
    expect(RISK_ORDER[v.risk]).toBeGreaterThanOrEqual(RISK_ORDER.high);
    expect(v.reason.toLowerCase()).toMatch(/inline eval|encoded/i);
  });

  test('pwsh -Command is flagged too', () => {
    const v = classifyCommandRisk('pwsh -Command "Get-Date"');
    expect(RISK_ORDER[v.risk]).toBeGreaterThanOrEqual(RISK_ORDER.high);
  });

  test('powershell -EncodedCommand is critical (payload is opaque base64)', () => {
    const v = classifyCommandRisk(
      'powershell -EncodedCommand SQBFAF0AWwBQAFMAAF0APQBDAGgAYQByAGcAZQA='
    );
    expect(v.risk).toBe('critical');
    expect(RISK_ORDER[v.risk]).toBeGreaterThanOrEqual(RISK_ORDER.critical);
  });

  test('pwsh -EncodedCommand is critical', () => {
    const v = classifyCommandRisk('pwsh -EncodedCommand AABjAGMA');
    expect(v.risk).toBe('critical');
  });

  test('flag is matched regardless of case and position among other flags', () => {
    const a = classifyCommandRisk('Powershell -ENCODEDCOMMAND AABj');
    expect(a.risk).toBe('critical');

    const b = classifyCommandRisk('powershell -NoProfile -EncodedCommand AABj');
    expect(b.risk).toBe('critical');
  });

  test('-EncodedCommand is a strictly higher bar than a visible -Command', () => {
    // Visible payloads can be recursively analysed, so they stay at the generic
    // inline-eval warning level; the opaque form must not be relaxed to match.
    const visible = classifyCommandRisk('powershell -Command "Get-Date"');
    const opaque = classifyCommandRisk('powershell -EncodedCommand AABj');
    expect(RISK_ORDER[opaque.risk]).toBeGreaterThan(RISK_ORDER[visible.risk]);
  });
});

describe('commandRiskClassifier — pre-existing behaviour must not regress', () => {
  test('POSIX rm -rf stays critical and destructive', () => {
    const v = classifyCommandRisk('rm -rf /tmp/foo');
    expect(v.risk).toBe('critical');
    expect(v.isDestructive).toBe(true);
    expect(v.isReadOnly).toBe(false);
  });

  test('cat stays safe and read-only', () => {
    const v = classifyCommandRisk('cat package.json');
    expect(v.risk).toBe('safe');
    expect(v.isReadOnly).toBe(true);
    expect(v.isDestructive).toBe(false);
  });

  test('git status stays safe', () => {
    expect(classifyCommandRisk('git status').risk).toBe('safe');
  });

  test('unknown command still defaults to medium', () => {
    expect(classifyCommandRisk('frobnicate --wibble').risk).toBe('medium');
  });

  test('empty / invalid command still fails closed to critical', () => {
    expect(classifyCommandRisk('').risk).toBe('critical');
    expect(classifyCommandRisk(null).risk).toBe('critical');
  });

  test('command substitution is still flagged', () => {
    expect(classifyCommandRisk('echo $(rm -rf /)').hasCommandSubstitution).toBe(true);
  });

  test('existing inline-eval families are unchanged (python3 -c, node -e)', () => {
    expect(RISK_ORDER[classifyCommandRisk('python3 -c "print(1)"').risk]).toBeGreaterThanOrEqual(
      RISK_ORDER.high
    );
    expect(RISK_ORDER[classifyCommandRisk('node -e "process.exit(0)"').risk]).toBeGreaterThanOrEqual(
      RISK_ORDER.high
    );
  });

  test('bash -c still recurses into the payload (rm -rf -> critical)', () => {
    expect(classifyCommandRisk('bash -c "rm -rf /"').risk).toBe('critical');
  });

  test('compound command still takes the strictest segment', () => {
    const v = classifyCommandRisk('cat foo.txt && rm -rf bar');
    expect(v.risk).toBe('critical');
    expect(v.isDestructive).toBe(true);
  });

  test('query flags are not treated as inline eval (python --version)', () => {
    // -c is the eval flag for python; --version must not trip it.
    const v = classifyCommandRisk('python --version');
    expect(v.risk).not.toBe('critical');
    expect(RISK_ORDER[v.risk]).toBeLessThan(RISK_ORDER.high);
  });
});
