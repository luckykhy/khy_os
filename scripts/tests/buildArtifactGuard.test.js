'use strict';

const assert = require('assert/strict');
const test = require('node:test');

const guard = require('../lib/buildArtifactGuard');

// The rule was repointed from apps/khy-mobile/android/ (isolated ghost endpoint,
// 0 git-tracked files — see [DESIGN-ARCH-120] §五) to the surviving Flutter app
// apps/khy-os-client-app/android/. The rule is generic Gradle regenerable-output
// detection; these tests pin it to the surviving scope.

test('flags regenerable Android build artifacts', () => {
  const flagged = [
    'apps/khy-os-client-app/android/app/build/outputs/apk/release/app-release.apk',
    'apps/khy-os-client-app/android/app/build/intermediates/merged/classes.jar',
    'apps/khy-os-client-app/android/.gradle/8.0/checksums/checksums.bin',
    'apps/khy-os-client-app/android/app/.cxx/cmake/debug/x86/lib.so',
    'apps/khy-os-client-app/android/app/release/app-release.aab',
    'apps/khy-os-client-app/android/app/src/main/dump.hprof',
  ];
  for (const filePath of flagged) {
    const hit = guard.classifyPath(filePath);
    assert.ok(hit, filePath + ' should be flagged');
    assert.equal(hit.ruleId, 'android-build');
    assert.ok(hit.why.length > 0, 'a violation must explain why it is regenerable');
  }
});

test('never flags source, wrapper, or config that a clean checkout must rebuild from', () => {
  // Each of these once looked like a build artifact to a naive substring rule.
  // Deleting any of them breaks `gradlew assembleRelease` on a fresh clone, which
  // is strictly worse than leaving a few megabytes untracked.
  const safe = [
    'apps/khy-os-client-app/android/gradlew',
    'apps/khy-os-client-app/android/gradlew.bat',
    'apps/khy-os-client-app/android/gradle/wrapper/gradle-wrapper.jar',
    'apps/khy-os-client-app/android/gradle/wrapper/gradle-wrapper.properties',
    'apps/khy-os-client-app/android/build.gradle',
    'apps/khy-os-client-app/android/app/build.gradle',
    'apps/khy-os-client-app/android/app/proguard-rules.pro',
    'apps/khy-os-client-app/android/app/src/main/AndroidManifest.xml',
    'apps/khy-os-client-app/android/app/src/main/java/com/khy/BuildConfig.java',
    'apps/khy-os-client-app/android/app/src/main/res/values/strings.xml',
    'apps/khy-os-client-app/android/settings.gradle',
  ];
  for (const filePath of safe) {
    assert.equal(guard.classifyPath(filePath), null, filePath + ' must not be flagged');
  }
});

test('scopes keep the rule from reaching outside apps/khy-os-client-app/android', () => {
  // packaging/build/ holds CI build *scripts* — the root .gitignore carries an
  // explicit `!packaging/build/` exception for exactly this reason. A rule that
  // matched a bare `build` segment repo-wide would flag them.
  assert.equal(guard.classifyPath('packaging/build/make-standalone.js'), null);
  assert.equal(guard.classifyPath('services/backend/dist/index.js'), null);
  assert.equal(guard.classifyPath('apps/ai-frontend/dist/assets/app.js'), null);
  // The isolated ghost dir must not be flagged either — nothing lives there now.
  assert.equal(guard.classifyPath('apps/khy-mobile/android/app/build/a.apk'), null);
});

test('windows separators are normalized before matching', () => {
  const hit = guard.classifyPath('apps\\khy-os-client-app\\android\\app\\build\\outputs\\app.apk');
  assert.ok(hit, 'backslash paths must classify identically');
  assert.equal(hit.path, 'apps/khy-os-client-app/android/app/build/outputs/app.apk');
});

test('inspect survives dirty input without throwing', () => {
  const result = guard.inspect([null, undefined, 42, '', {}, 'apps/khy-os-client-app/android/app/build/a.apk']);
  assert.equal(result.violations.length, 1);
  assert.equal(result.checked, 1);
});

test('env gate disables the guard without pretending the tree is clean', () => {
  const result = guard.inspect(
    ['apps/khy-os-client-app/android/app/build/a.apk'],
    { KHY_BUILD_ARTIFACT_GUARD: '0' },
  );
  assert.equal(result.disabled, true);
  assert.equal(result.violations.length, 0);
  assert.match(guard.render(result), /disabled/);
});

test('render names the offending path so the fix is actionable', () => {
  const text = guard.render(guard.inspect(['apps/khy-os-client-app/android/app/build/a.apk']));
  assert.match(text, /apps\/khy-os-client-app\/android\/app\/build\/a\.apk/);
  assert.match(text, /git rm --cached/);
});
