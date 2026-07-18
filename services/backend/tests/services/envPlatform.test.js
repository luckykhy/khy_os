'use strict';

// Tests for envPlatform.js — the platform-differentiation layer that resolves
// the current OS identity (linux/windows/macos/android/ios/harmonyos) and gates
// registry entries by their optional `platforms` field. Reuses osProfileService
// for the five canonical OSes and refines iOS on top of platformIds.

const { test } = require('node:test');
const assert = require('node:assert');

const envPlatform = require('../../src/services/envPlatform');
const osProfileService = require('../../src/services/osProfileService');

// osProfileService caches its resolved profile process-wide; changing the
// KHY_OS_PROFILE pin between assertions requires clearing that cache so the
// pin is re-read. Production runs pin once at startup, so the cache is correct
// there — only the test harness flips pins mid-process.
function withPin(value, fn) {
  const prev = process.env.KHY_OS_PROFILE;
  process.env.KHY_OS_PROFILE = value;
  osProfileService.resetCache();
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.KHY_OS_PROFILE;
    else process.env.KHY_OS_PROFILE = prev;
    osProfileService.resetCache();
  }
}

test('detectPlatform on the host returns a well-formed context', () => {
  const p = envPlatform.detectPlatform();
  assert.ok(p && typeof p === 'object');
  assert.ok(typeof p.id === 'string' && p.id.length > 0);
  assert.ok(typeof p.label === 'string' && p.label.length > 0);
  assert.ok(typeof p.sandboxed === 'boolean');
  assert.ok(typeof p.hasLoadAvg === 'boolean');
  assert.ok(typeof p.source === 'string');
});

test('KHY_OS_PROFILE pin routes to iOS with sandbox + refine source', () => {
  withPin('ios', () => {
    const p = envPlatform.detectPlatform();
    assert.strictEqual(p.id, 'ios');
    assert.strictEqual(p.sandboxed, true);
    assert.strictEqual(p.source, 'ios-refine');
  });
});

test('KHY_OS_PROFILE pin routes to Windows (no load average)', () => {
  withPin('windows', () => {
    const p = envPlatform.detectPlatform();
    assert.strictEqual(p.id, 'windows');
    assert.strictEqual(p.hasLoadAvg, false);
  });
});

test('_detectIos honours ipados/iphoneos aliases and ignores others', () => {
  for (const alias of ['ios', 'iphoneos', 'ipados', 'ipad']) {
    withPin(alias, () => {
      assert.strictEqual(envPlatform._detectIos(), true, `alias ${alias} should map to iOS`);
    });
  }
  withPin('linux', () => {
    assert.strictEqual(envPlatform._detectIos(), false);
  });
});

test('appliesTo: no platforms field means all platforms', () => {
  assert.strictEqual(envPlatform.appliesTo({ key: 'x' }, 'linux'), true);
  assert.strictEqual(envPlatform.appliesTo({ key: 'x', platforms: [] }, 'windows'), true);
});

test('appliesTo: scoped entry only matches listed platforms', () => {
  const entry = { key: 'y', platforms: ['linux', 'macos'] };
  assert.strictEqual(envPlatform.appliesTo(entry, 'linux'), true);
  assert.strictEqual(envPlatform.appliesTo(entry, 'macos'), true);
  assert.strictEqual(envPlatform.appliesTo(entry, 'windows'), false);
  assert.strictEqual(envPlatform.appliesTo(entry, 'ios'), false);
});

test('appliesTo: null entry is never applicable', () => {
  assert.strictEqual(envPlatform.appliesTo(null, 'linux'), false);
  assert.strictEqual(envPlatform.appliesTo(undefined, 'linux'), false);
});

test('_PLATFORM_META covers all six platform ids and is frozen', () => {
  const ids = ['linux', 'windows', 'macos', 'android', 'harmonyos', 'ios'];
  for (const id of ids) {
    assert.ok(envPlatform._PLATFORM_META[id], `missing meta for ${id}`);
    assert.strictEqual(envPlatform._PLATFORM_META[id].id, id);
  }
  assert.ok(Object.isFrozen(envPlatform._PLATFORM_META));
  // Sandboxed mobile-class platforms are marked as such.
  assert.strictEqual(envPlatform._PLATFORM_META.ios.sandboxed, true);
  assert.strictEqual(envPlatform._PLATFORM_META.harmonyos.sandboxed, true);
  assert.strictEqual(envPlatform._PLATFORM_META.linux.sandboxed, false);
});
