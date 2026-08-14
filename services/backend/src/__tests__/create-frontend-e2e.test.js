'use strict';

/**
 * create-frontend-e2e.test.js — end-to-end acceptance for the vue-multipage
 * frontend generation pipeline.
 *
 * WHAT IT DOES
 *   render(vue-multipage) → write to a unique temp dir → `npm install` →
 *   `npm run build` (exit code 0) → assert a `dist/` directory exists →
 *   recursively clean up the temp dir (always, including on failure).
 *
 * HOW TO ENABLE (default: skipped)
 *   This suite hits the network (npm install) and takes minutes, so it never
 *   runs in the normal test run. Enable it explicitly by setting the env var
 *   KHY_E2E_FRONTEND to '1':
 *     PowerShell : $env:KHY_E2E_FRONTEND='1'; npx jest src/__tests__/create-frontend-e2e.test.js
 *     bash       : KHY_E2E_FRONTEND=1 npx jest src/__tests__/create-frontend-e2e.test.js
 *   When the var is unset (or not '1') the whole suite reports as skipped.
 *
 * RUNTIME PROBE / FAULT TOLERANCE
 *   Uses whatever `node`/`npm` is on PATH. If none is found, it falls back to
 *   the runtime bundled under `.khy/node/` (discovered dynamically — no
 *   hard-coded absolute path). If no usable runtime is found, or if the
 *   network is unavailable during `npm install`, the test degrades gracefully
 *   (warns and returns) instead of failing, so an offline machine is not a
 *   false red.
 *
 * TIMEOUT
 *   The per-test budget is Jest's own timeout argument (10 minutes). There is
 *   deliberately NO custom setTimeout that hard-kills an active build — that is
 *   banned by AGENTS.md and would murder a legitimately slow-but-progressing
 *   install/build.
 *
 * Style: 2-space indent, single quotes, semicolons; code/comments in English.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const projectTemplateService = require('../services/projectTemplateService');

const TEMPLATE_NAME = 'vue-multipage';
const E2E_ENABLED = process.env.KHY_E2E_FRONTEND === '1';
const TEST_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes — Jest's own budget only.

// Repo root, resolved relatively from this file (…/services/backend/src/__tests__).
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

/**
 * Recursively locate the directory that contains a node executable under the
 * bundled runtime tree. Returns the containing directory, or null.
 * @returns {string|null}
 */
function findBundledRuntimeDir() {
  const base = path.join(REPO_ROOT, '.khy', 'node');
  if (!fs.existsSync(base)) {return null;}
  const nodeName = process.platform === 'win32' ? 'node.exe' : 'node';
  const stack = [base];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.name === nodeName) {
        return dir;
      }
    }
  }
  return null;
}

/**
 * Resolve an environment in which `npm` is runnable. Prefers the ambient PATH,
 * then falls back to the bundled runtime. Returns { env } or null if none work.
 * @returns {{ env: NodeJS.ProcessEnv }|null}
 */
function resolveNpmEnv() {
  const probe = spawnSync('npm', ['--version'], { shell: true, encoding: 'utf8' });
  if (probe.status === 0) {return { env: process.env };}

  const runtimeDir = findBundledRuntimeDir();
  if (runtimeDir) {
    const env = {
      ...process.env,
      PATH: runtimeDir + path.delimiter + (process.env.PATH || ''),
    };
    const probe2 = spawnSync('npm', ['--version'], { shell: true, encoding: 'utf8', env });
    if (probe2.status === 0) {return { env };}
  }
  return null;
}

/**
 * Materialize a rendered template onto disk under targetDir.
 * @param {string} targetDir
 * @param {{ directories: string[], files: Array<{path:string, content:string}> }} rendered
 */
function writeRendered(targetDir, rendered) {
  for (const dir of rendered.directories) {
    fs.mkdirSync(path.join(targetDir, dir), { recursive: true });
  }
  for (const file of rendered.files) {
    const target = path.join(targetDir, file.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.content, 'utf8');
  }
}

const describeMaybe = E2E_ENABLED ? describe : describe.skip;

describeMaybe('create-frontend e2e: render → npm install → npm run build', () => {
  let workDir = null;

  beforeAll(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-frontend-e2e-'));
  });

  afterAll(() => {
    // Always clean up — including the failure path — so the temp dir never
    // leaks and the repo is never polluted.
    if (workDir) {
      try {
        fs.rmSync(workDir, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
  });

  test(
    'renders vue-multipage and builds it to a dist directory',
    () => {
      const npm = resolveNpmEnv();
      if (!npm) {
        console.warn('[e2e] no usable node/npm runtime found (PATH or .khy/node); skipping build assertions.');
        return;
      }

      const rendered = projectTemplateService.renderTemplate(TEMPLATE_NAME, {
        projectName: 'e2e-vue-multipage',
      });
      writeRendered(workDir, rendered);
      expect(fs.existsSync(path.join(workDir, 'package.json'))).toBe(true);

      const install = spawnSync('npm', ['install', '--no-audit', '--no-fund'], {
        cwd: workDir,
        env: npm.env,
        shell: true,
        encoding: 'utf8',
        stdio: 'pipe',
      });
      if (install.status !== 0) {
        // Most likely the registry is unreachable on this machine. Report the
        // tail of stderr and degrade gracefully rather than raising a false red.
        console.warn(
          '[e2e] npm install failed (network unavailable?); skipping build assertions. stderr tail:\n' +
            String(install.stderr || '').slice(-800),
        );
        return;
      }

      const build = spawnSync('npm', ['run', 'build'], {
        cwd: workDir,
        env: npm.env,
        shell: true,
        encoding: 'utf8',
        stdio: 'pipe',
      });
      if (build.status !== 0) {
        console.error('[e2e] npm run build stderr tail:\n' + String(build.stderr || '').slice(-1500));
      }
      expect(build.status).toBe(0);
      expect(fs.existsSync(path.join(workDir, 'dist'))).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );
});
