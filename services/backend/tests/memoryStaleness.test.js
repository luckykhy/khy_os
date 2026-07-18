'use strict';

/**
 * memoryStaleness — pure-leaf contract tests (node:test, jest-ignored).
 *
 * Verifies the deterministic staleness judgment only (no fs/clock IO): the gate,
 * per-type horizons (single-sourced with distiller's env knobs), fail-soft on
 * missing timestamps, future-dated guard, ISO parsing, and the annotation text.
 */

const { test } = require('node:test');
const assert = require('node:assert');

const ms = require('../src/services/memoryStaleness');

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000; // fixed epoch ms, deterministic

test('isEnabled: default-on, off only for {0,false,off,no}', () => {
  assert.equal(ms.isEnabled({}), true);
  assert.equal(ms.isEnabled({ KHY_MEMORY_STALENESS: '1' }), true);
  for (const v of ['0', 'false', 'off', 'no', ' OFF ']) {
    assert.equal(ms.isEnabled({ KHY_MEMORY_STALENESS: v }), false);
  }
});

test('horizonDays: per-type defaults match distiller; env overrides win', () => {
  assert.equal(ms.horizonDays('user', {}), 3650);
  assert.equal(ms.horizonDays('feedback', {}), 540);
  assert.equal(ms.horizonDays('reference', {}), 365);
  assert.equal(ms.horizonDays('project', {}), 180);
  assert.equal(ms.horizonDays('unknown', {}), 365);
  assert.equal(ms.horizonDays('project', { KHY_MEMORY_STALE_DAYS_PROJECT: '30' }), 30);
  assert.equal(ms.horizonDays('weird', { KHY_MEMORY_STALE_DAYS: '99' }), 99);
});

test('assessStaleness: fresh project memory is not stale', () => {
  const a = ms.assessStaleness({ type: 'project', updatedMs: NOW - 10 * DAY, nowMs: NOW }, {});
  assert.equal(a.stale, false);
  assert.equal(a.horizonDays, 180);
  assert.ok(Math.abs(a.ageDays - 10) < 1e-6);
});

test('assessStaleness: project memory past 180d horizon is stale', () => {
  const a = ms.assessStaleness({ type: 'project', updatedMs: NOW - 200 * DAY, nowMs: NOW }, {});
  assert.equal(a.stale, true);
  assert.ok(a.ageDays > 180);
});

test('assessStaleness: user memory effectively immortal (3650d)', () => {
  const a = ms.assessStaleness({ type: 'user', updatedMs: NOW - 1000 * DAY, nowMs: NOW }, {});
  assert.equal(a.stale, false);
});

test('assessStaleness: missing/invalid timestamp ⇒ fail-soft not stale', () => {
  assert.equal(ms.assessStaleness({ type: 'project', updatedMs: null, nowMs: NOW }, {}).stale, false);
  assert.equal(ms.assessStaleness({ type: 'project', updatedMs: NaN, nowMs: NOW }, {}).stale, false);
  assert.equal(ms.assessStaleness({ type: 'project', updatedMs: NOW, nowMs: NaN }, {}).stale, false);
});

test('assessStaleness: future-dated updated ⇒ not stale (ageDays 0)', () => {
  const a = ms.assessStaleness({ type: 'project', updatedMs: NOW + 5 * DAY, nowMs: NOW }, {});
  assert.equal(a.stale, false);
  assert.equal(a.ageDays, 0);
});

test('assessStaleness: gate off ⇒ never stale regardless of age', () => {
  const a = ms.assessStaleness(
    { type: 'project', updatedMs: NOW - 9999 * DAY, nowMs: NOW },
    { KHY_MEMORY_STALENESS: 'off' },
  );
  assert.equal(a.stale, false);
});

test('parseUpdatedMs: ISO string parses; junk/empty ⇒ null', () => {
  assert.equal(ms.parseUpdatedMs('2023-11-14T22:13:20.000Z'), Date.parse('2023-11-14T22:13:20.000Z'));
  assert.equal(ms.parseUpdatedMs(''), null);
  assert.equal(ms.parseUpdatedMs(null), null);
  assert.equal(ms.parseUpdatedMs('not a date'), null);
});

test('formatStaleNote: empty for fresh, descriptive for stale', () => {
  assert.equal(ms.formatStaleNote({ stale: false, ageDays: 1, horizonDays: 180 }), '');
  const note = ms.formatStaleNote({ stale: true, ageDays: 200, horizonDays: 180 });
  assert.match(note, /过期/);
  assert.match(note, /200 天/);
  assert.match(note, /180 天/);
});
