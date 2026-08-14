'use strict';

/**
 * Tests for the completion-time audit → fix → re-audit closed loop.
 *
 * Teaching scenario: at the end of a real engineering task (files modified /
 * execution plan / Goal mode), Khy automatically dispatches the read-only AUDIT
 * agent to find problems, the editing FIX agent to close CRITICAL/HIGH ones,
 * then RE-AUDITs to confirm — fully automatic, bounded, transparent leftovers.
 *
 * Pins the pure leaves (parser, trigger gate, prompt builder) and the DI
 * orchestration (runAuditFixCycle + buildAnnotation) with a stub dispatcher, so
 * no model / AgentTool machinery is needed.
 *
 * Uses node:test (run with `node --test`); jest auto-ignores node:test files.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const parser = require('../src/services/auditFixLoop/auditParser');
const triggerGate = require('../src/services/auditFixLoop/triggerGate');
const promptBuilder = require('../src/services/auditFixLoop/promptBuilder');
const loop = require('../src/services/auditFixLoop');

const AUDIT_2_ACTIONABLE = `### [CRITICAL] Path traversal
**Location:** src/x.js:42
**Problem:** user input concatenated into path
**Impact:** arbitrary file read
**Confidence:** high
**Suggested direction:** validate against an allowlist

### [HIGH] Missing await
**Location:** src/y.js:10
**Problem:** promise not awaited
**Impact:** race
**Confidence:** medium
**Suggested direction:** add await

### [NIT] naming
**Location:** src/z.js:1
**Problem:** foo
**Impact:** none
**Confidence:** low
**Suggested direction:** rename

AUDIT: 3 findings (1 critical, 1 high, 0 medium, 0 low, 1 nit)`;

describe('auditParser.parseAuditReport', () => {
  test('parses findings + counts from structured blocks and summary line', () => {
    const r = parser.parseAuditReport(AUDIT_2_ACTIONABLE);
    assert.equal(r.total, 3);
    assert.deepEqual(r.counts, { critical: 1, high: 1, medium: 0, low: 0, nit: 1 });
    assert.equal(r.hasSummaryLine, true);
    assert.equal(r.findings[0].severity, 'critical');
    assert.equal(r.findings[0].location, 'src/x.js:42');
    assert.match(r.findings[0].suggested, /allowlist/);
  });

  test('strips stray markdown markers from field values', () => {
    const r = parser.parseAuditReport('### [HIGH] x\n**Location:** c.js:5\n**Problem:** p\nAUDIT: 1 findings (0 critical, 1 high, 0 medium, 0 low, 0 nit)');
    assert.equal(r.findings[0].location, 'c.js:5');
    assert.equal(r.findings[0].problem, 'p');
  });

  test('hasActionableFindings is true only when critical+high > 0', () => {
    assert.equal(parser.hasActionableFindings(parser.parseAuditReport(AUDIT_2_ACTIONABLE)), true);
    const lowOnly = parser.parseAuditReport('### [LOW] minor\n**Location:** a:1\nAUDIT: 1 findings (0 critical, 0 high, 0 medium, 1 low, 0 nit)');
    assert.equal(parser.hasActionableFindings(lowOnly), false);
  });

  test('clean audit (0 findings) is non-actionable', () => {
    const clean = parser.parseAuditReport('Traced fully, reached every branch.\nAUDIT: 0 findings');
    assert.equal(clean.total, 0);
    assert.equal(parser.hasActionableFindings(clean), false);
  });

  test('trusts parsed headers over a miscounted summary line', () => {
    // Two real CRITICAL blocks but a lying "0 critical" summary line.
    const txt = '### [CRITICAL] a\n**Location:** a:1\n### [CRITICAL] b\n**Location:** b:2\nAUDIT: 0 findings (0 critical, 0 high, 0 medium, 0 low, 0 nit)';
    const r = parser.parseAuditReport(txt);
    assert.equal(r.counts.critical, 2);
    assert.equal(parser.hasActionableFindings(r), true);
  });

  test('actionableFindings returns CRITICAL before HIGH, drops the rest', () => {
    const a = parser.actionableFindings(parser.parseAuditReport(AUDIT_2_ACTIONABLE));
    assert.equal(a.length, 2);
    assert.equal(a[0].severity, 'critical');
    assert.equal(a[1].severity, 'high');
  });

  test('safe on empty / non-string input', () => {
    for (const v of ['', null, undefined, 42]) {
      const r = parser.parseAuditReport(v);
      assert.equal(r.total, 0);
      assert.equal(parser.hasActionableFindings(r), false);
    }
  });
});

describe('auditParser.parseFixReport', () => {
  test('counts FIXED / DEFERRED / NOT-A-DEFECT from block statuses', () => {
    const fix = `### [CRITICAL] Path traversal — FIXED
**Location:** src/x.js:42
**Change:** added allowlist check
**Verified:** node -c passes

### [HIGH] Missing await — NOT-A-DEFECT
**Location:** src/y.js:10
**Change:** already awaited upstream

FIX: 1 fixed, 0 deferred, 1 not-a-defect (of 2 actionable findings)`;
    const r = parser.parseFixReport(fix);
    assert.equal(r.fixed, 1);
    assert.equal(r.notDefect, 1);
    assert.equal(r.deferred, 0);
    assert.equal(r.total, 2);
    assert.equal(r.hasSummaryLine, true);
  });

  test('falls back to the summary line when no status blocks are present', () => {
    const r = parser.parseFixReport('FIX: 2 fixed, 1 deferred, 0 not-a-defect (of 3 actionable findings)');
    assert.equal(r.fixed, 2);
    assert.equal(r.deferred, 1);
    assert.equal(r.total, 3);
  });
});

describe('auditParser.summarizeCounts', () => {
  test('renders only non-zero buckets in Chinese', () => {
    assert.equal(parser.summarizeCounts({ critical: 1, high: 2, medium: 0, low: 0, nit: 1 }), '1 严重 / 2 高 / 1 nit');
    assert.equal(parser.summarizeCounts({ critical: 0, high: 0, medium: 0, low: 0, nit: 0 }), '');
  });
});

describe('triggerGate.shouldAudit', () => {
  const ENV_KEYS = ['KHY_AUDIT_FIX_LOOP', 'KHY_AUDIT_FIX_MIN_FILES', 'KHY_AUDIT_FIX_MAX_ROUNDS'];
  let saved;
  beforeEach(() => { saved = {}; for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; } });
  afterEach(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

  test('fires when files were modified', () => {
    const d = triggerGate.shouldAudit({ modifiedFileCount: 1 });
    assert.equal(d.audit, true);
    assert.equal(d.reason, 'modified-files');
  });

  test('fires on an execution plan even with zero edits', () => {
    assert.equal(triggerGate.shouldAudit({ hasExecutionPlan: true }).audit, true);
  });

  test('fires in Goal mode even with zero edits', () => {
    assert.equal(triggerGate.shouldAudit({ goalModeActive: true }).audit, true);
  });

  test('does NOT fire on trivial chat (no edits, no plan, not goal)', () => {
    const d = triggerGate.shouldAudit({ modifiedFileCount: 0 });
    assert.equal(d.audit, false);
    assert.equal(d.reason, 'trivial');
  });

  test('NEVER fires inside a sub-agent (no recursion)', () => {
    const d = triggerGate.shouldAudit({ modifiedFileCount: 5, isSubagent: true });
    assert.equal(d.audit, false);
    assert.equal(d.reason, 'subagent');
  });

  test('respects KHY_AUDIT_FIX_LOOP=0 disable', () => {
    process.env.KHY_AUDIT_FIX_LOOP = '0';
    assert.equal(triggerGate.shouldAudit({ modifiedFileCount: 3 }).audit, false);
    assert.equal(triggerGate.isEnabled(), false);
  });

  test('respects a higher KHY_AUDIT_FIX_MIN_FILES floor', () => {
    process.env.KHY_AUDIT_FIX_MIN_FILES = '3';
    assert.equal(triggerGate.shouldAudit({ modifiedFileCount: 2 }).audit, false);
    assert.equal(triggerGate.shouldAudit({ modifiedFileCount: 3 }).audit, true);
  });

  test('maxRounds is bounded [1,5] with default 2', () => {
    assert.equal(triggerGate.maxRounds(), 2);
    process.env.KHY_AUDIT_FIX_MAX_ROUNDS = '99';
    assert.equal(triggerGate.maxRounds(), 5);
    process.env.KHY_AUDIT_FIX_MAX_ROUNDS = '0';
    assert.equal(triggerGate.maxRounds(), 1);
  });
});

describe('promptBuilder', () => {
  test('audit prompt contains task, files, and the required summary-line instruction', () => {
    const p = promptBuilder.buildAuditPrompt({ taskDescription: 'add a parser', files: ['a.js', 'b.js'] });
    assert.match(p, /add a parser/);
    assert.match(p, /a\.js/);
    assert.match(p, /AUDIT: <n> findings/);
  });

  test('re-audit prompt (round>1) tells the auditor to re-inspect from scratch', () => {
    const p = promptBuilder.buildAuditPrompt({ taskDescription: 't', files: ['a.js'], round: 2, priorFix: { fixed: 1, deferred: 0, notDefect: 0 } });
    assert.match(p, /RE-AUDIT round 2/);
    assert.match(p, /do not assume the fixes are correct/i);
  });

  test('fix prompt lists the actionable findings and forbids scope creep', () => {
    const report = parser.parseAuditReport(AUDIT_2_ACTIONABLE);
    const p = promptBuilder.buildFixPrompt({ taskDescription: 't', files: ['src/x.js'], report, actionable: parser.actionableFindings(report) });
    assert.match(p, /Path traversal/);
    assert.match(p, /Missing await/);
    assert.match(p, /no scope creep/i);
    assert.match(p, /FIX: <f> fixed/);
  });

  test('file list degrades gracefully when no files are recorded', () => {
    const p = promptBuilder.buildAuditPrompt({ taskDescription: 't', files: [] });
    assert.match(p, /git diff/);
  });
});

describe('runAuditFixCycle (DI orchestration)', () => {
  test('audit→fix→re-audit converges to "fixed" and folds in fixed files', async () => {
    const calls = [];
    const dispatch = async ({ role, round }) => {
      calls.push(`${role}#${round}`);
      if (role === 'audit' && round === 1) return { text: AUDIT_2_ACTIONABLE };
      if (role === 'fix') return { text: 'FIX: 2 fixed, 0 deferred, 0 not-a-defect (of 2 actionable findings)', filesModified: ['src/x.js', 'src/y.js'] };
      if (role === 'audit' && round === 2) return { text: 'AUDIT: 0 findings' };
      return { text: '' };
    };
    const r = await loop.runAuditFixCycle({ dispatchAgent: dispatch, taskDescription: 't', files: ['src/x.js'], maxRounds: 2 });
    assert.equal(r.outcome, 'fixed');
    assert.equal(r.totalActionableRemaining, 0);
    assert.deepEqual(r.filesFixed.sort(), ['src/x.js', 'src/y.js']);
    assert.deepEqual(calls, ['audit#1', 'fix#1', 'audit#2']);
  });

  test('a clean first audit returns "clean" and never dispatches the fixer', async () => {
    let fixCalls = 0;
    const dispatch = async ({ role }) => { if (role === 'fix') fixCalls++; return { text: 'AUDIT: 0 findings' }; };
    const r = await loop.runAuditFixCycle({ dispatchAgent: dispatch, taskDescription: 't', files: ['a.js'] });
    assert.equal(r.outcome, 'clean');
    assert.equal(fixCalls, 0);
    assert.equal(loop.buildAnnotation(r), ''); // clean = no noise
  });

  test('persistent findings exhaust the round budget and surface leftovers', async () => {
    const dispatch = async ({ role }) => role === 'audit'
      ? { text: '### [HIGH] still broken\n**Location:** c.js:5\nAUDIT: 1 findings (0 critical, 1 high, 0 medium, 0 low, 0 nit)' }
      : { text: 'FIX: 0 fixed, 1 deferred, 0 not-a-defect (of 1 actionable findings)', filesModified: [] };
    const r = await loop.runAuditFixCycle({ dispatchAgent: dispatch, taskDescription: 't', files: ['c.js'], maxRounds: 2 });
    assert.equal(r.outcome, 'exhausted');
    assert.equal(r.totalActionableRemaining, 1);
    const ann = loop.buildAnnotation(r);
    assert.match(ann, /需人工关注/);
    assert.match(ann, /still broken/);
  });

  test('a thrown dispatch fails soft (outcome "error", empty annotation)', async () => {
    const r = await loop.runAuditFixCycle({ dispatchAgent: async () => { throw new Error('boom'); }, taskDescription: 't', files: ['d.js'] });
    assert.equal(r.outcome, 'error');
    assert.equal(r.error, 'boom');
    assert.equal(loop.buildAnnotation(r), '');
  });

  test('missing dispatcher returns an error outcome instead of throwing', async () => {
    const r = await loop.runAuditFixCycle({ taskDescription: 't', files: [] });
    assert.equal(r.outcome, 'error');
  });

  test('"fixed" annotation reports the repaired count', async () => {
    const dispatch = async ({ role, round }) => {
      if (role === 'audit' && round === 1) return { text: AUDIT_2_ACTIONABLE };
      if (role === 'fix') return { text: 'FIX: 2 fixed, 0 deferred, 0 not-a-defect (of 2 actionable findings)', filesModified: [] };
      return { text: 'AUDIT: 0 findings' };
    };
    const r = await loop.runAuditFixCycle({ dispatchAgent: dispatch, taskDescription: 't', files: ['x'], maxRounds: 2 });
    const ann = loop.buildAnnotation(r);
    assert.match(ann, /完成时审计/);
    assert.match(ann, /修复 2 项/);
  });
});
