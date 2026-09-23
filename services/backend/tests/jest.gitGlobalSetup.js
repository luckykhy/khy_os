'use strict';

/**
 * Jest globalSetup — make `git` resolvable for suites that shell out to real git.
 *
 * Several suites (gitCommit.precheck, makeSourceSnapshot, repo.handler, …)
 * exercise real temp git repos via `execFileSync('git', …)`. On this portable
 * deployment git lives at D:\Portable\Tools\Git and is NOT on the ambient PATH
 * (there is no system Git for Windows install), so those spawns fail with
 * ENOENT — and because jest-worker cannot serialize the self-referencing ENOENT
 * Error, the suite-level symptom is the misleading
 * "TypeError: Converting circular structure to JSON".
 *
 * Why globalSetup and not a setupFiles hook: setupFiles run inside the jest
 * sandbox, whose `process.env` is a SNAPSHOT COPY — writes there are visible to
 * test code but NOT to child spawns, because child_process's default env is the
 * real worker env. globalSetup runs in the MAIN jest process against the real
 * `process.env` BEFORE any worker is forked, so forked workers inherit the
 * injected PATH (and --runInBand reads the same real env). See the probe notes
 * in the session history for the empirical confirmation.
 *
 * On a machine with a system git (CI, other devs) the pre-check finds it and
 * PATH is left untouched. A different portable location can be supplied via
 * KHY_TEST_GIT_DIR. Escape hatch: KHY_TEST_NO_GIT_PATH_INJECT=1 disables.
 */

const fs = require('fs');
const path = require('path');

function findGitOnPath() {
  for (const dir of (process.env.PATH || '').split(';')) {
    if (dir && fs.existsSync(path.join(dir, 'git.exe'))) {
      return dir;
    }
  }
  return null;
}

module.exports = async function () {
  if (process.env.KHY_TEST_NO_GIT_PATH_INJECT === '1') {
    return;
  }
  if (findGitOnPath()) {
    return;
  }
  const candidates = [
    process.env.KHY_TEST_GIT_DIR,
    'D:\\Portable\\Tools\\Git\\cmd',
    'D:\\Portable\\Tools\\Git\\bin',
  ].filter(Boolean);
  const found = candidates.find((d) => fs.existsSync(path.join(d, 'git.exe')));
  if (found) {
    process.env.PATH = `${found};${process.env.PATH || ''}`;
  }
  // Still no git anywhere → leave PATH as-is; the affected suites fail with a
  // plain ENOENT, which is honest, rather than being masked by a serializer crash.
};
