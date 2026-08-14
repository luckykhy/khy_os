'use strict';

/**
 * publishBundleArtifacts.test.js — characterization coverage for the deploy-bundle
 * artifact generators extracted from cli/handlers/publish.js (B1 split, 3rd seam).
 * These functions had no direct tests before extraction; this pins their output.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const a = require('../../src/services/publish/bundleArtifacts');

describe('publish/bundleArtifacts', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-bundle-art-')); });
  afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } });

  test('_writeDockerBundleDockerfile writes a node:20-slim Dockerfile', () => {
    a._writeDockerBundleDockerfile(tmp);
    const out = fs.readFileSync(path.join(tmp, 'Dockerfile'), 'utf-8');
    assert.match(out, /^FROM node:20-slim/);
    assert.match(out, /better-sqlite3 --build-from-source/);
    assert.match(out, /CMD \["sh", "-c", "node scripts\/seed\.js && node server\.js"\]/);
  });

  test('_writeDockerBundleCompose honors backendContext and serviceName', () => {
    a._writeDockerBundleCompose(tmp, { backendContext: './pip-install/x', serviceName: 'svc-x' });
    const out = fs.readFileSync(path.join(tmp, 'docker-compose.yml'), 'utf-8');
    assert.match(out, /svc-x:/);
    assert.match(out, /context: \.\/pip-install\/x/);
    assert.match(out, /backend_data:/);
  });

  test('_writeDockerBundleCompose defaults to ./backend + khy-backend', () => {
    a._writeDockerBundleCompose(tmp);
    const out = fs.readFileSync(path.join(tmp, 'docker-compose.yml'), 'utf-8');
    assert.match(out, /khy-backend:/);
    assert.match(out, /context: \.\/backend/);
  });

  test('_writeDockerBundleEnvExample writes the runtime env template', () => {
    a._writeDockerBundleEnvExample(tmp);
    const out = fs.readFileSync(path.join(tmp, '.env.example'), 'utf-8');
    assert.match(out, /BACKEND_PORT=13000/);
    assert.match(out, /DB_TYPE=sqlite/);
  });

  test('_writeDockerBundleReadme embeds version and source backend', () => {
    a._writeDockerBundleReadme(tmp, { version: '1.2.3', sourceBackend: '/src/be', serviceName: 'svc' });
    const out = fs.readFileSync(path.join(tmp, 'README.md'), 'utf-8');
    assert.match(out, /# KHY OS Docker Bundle/);
    assert.match(out, /Version: 1\.2\.3/);
    assert.match(out, /Source backend: \/src\/be/);
    assert.match(out, /docker compose logs -f svc/);
  });

  test('_writePipInstallBundleReadme switches between pip and npm layouts', () => {
    a._writePipInstallBundleReadme(tmp, { installKind: 'npm', siteRoot: '/np', version: '9.9.9' });
    let out = fs.readFileSync(path.join(tmp, 'README.md'), 'utf-8');
    assert.match(out, /# KHY OS npm-install Bundle/);
    assert.match(out, /Source npm root: \/np/);
    assert.match(out, /npm-install\/backend/);

    a._writePipInstallBundleReadme(tmp, { installKind: 'pip', siteRoot: '/pp' });
    out = fs.readFileSync(path.join(tmp, 'README.md'), 'utf-8');
    assert.match(out, /# KHY OS pip-install Bundle/);
    assert.match(out, /pip-install\/khy_os\/bundled\/backend/);
  });

  test('_timestampForFileName renders YYYYMMDD-HHMMSS zero-padded', () => {
    assert.equal(a._timestampForFileName(new Date(2026, 5, 9, 8, 5, 3)), '20260609-080503');
    assert.equal(a._timestampForFileName(new Date(2026, 11, 31, 23, 59, 59)), '20261231-235959');
  });
});
