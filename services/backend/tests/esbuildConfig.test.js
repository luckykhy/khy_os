'use strict';

/**
 * Tests for esbuild.config.js and jsconfig.json — build configuration validation.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const BACKEND_ROOT = path.join(__dirname, '..');
const ESBUILD_CONFIG_PATH = path.join(BACKEND_ROOT, 'esbuild.config.js');
const JSCONFIG_PATH = path.join(BACKEND_ROOT, 'jsconfig.json');

describe('esbuild.config.js', () => {
  test('file exists', () => {
    expect(fs.existsSync(ESBUILD_CONFIG_PATH)).toBe(true);
  });

  test('is valid JavaScript syntax (node --check)', () => {
    // node --check only parses, does not execute
    expect(() => {
      execSync(`node --check "${ESBUILD_CONFIG_PATH}"`, { stdio: 'pipe' });
    }).not.toThrow();
  });

  test('file is non-empty', () => {
    const stat = fs.statSync(ESBUILD_CONFIG_PATH);
    expect(stat.size).toBeGreaterThan(100);
  });

  test('references expected entry points', () => {
    const content = fs.readFileSync(ESBUILD_CONFIG_PATH, 'utf8');
    expect(content).toContain('entryPoints');
    expect(content).toContain("format: 'cjs'");
    expect(content).toContain("format: 'esm'");
  });

  test('marks node built-ins as external', () => {
    const content = fs.readFileSync(ESBUILD_CONFIG_PATH, 'utf8');
    expect(content).toContain("'fs'");
    expect(content).toContain("'path'");
    expect(content).toContain("'child_process'");
  });
});

describe('jsconfig.json', () => {
  let jsconfig;

  beforeAll(() => {
    const raw = fs.readFileSync(JSCONFIG_PATH, 'utf8');
    jsconfig = JSON.parse(raw);
  });

  test('file exists and is valid JSON', () => {
    expect(jsconfig).toBeDefined();
    expect(typeof jsconfig).toBe('object');
  });

  test('has compilerOptions', () => {
    expect(jsconfig).toHaveProperty('compilerOptions');
    expect(typeof jsconfig.compilerOptions).toBe('object');
  });

  test('compilerOptions.checkJs is true', () => {
    expect(jsconfig.compilerOptions.checkJs).toBe(true);
  });

  test('compilerOptions.strictNullChecks is true', () => {
    expect(jsconfig.compilerOptions.strictNullChecks).toBe(true);
  });

  test('compilerOptions.target is es2022', () => {
    expect(jsconfig.compilerOptions.target).toBe('es2022');
  });

  test('compilerOptions.module is commonjs', () => {
    expect(jsconfig.compilerOptions.module).toBe('commonjs');
  });

  test('compilerOptions.noImplicitReturns is true', () => {
    expect(jsconfig.compilerOptions.noImplicitReturns).toBe(true);
  });

  test('has include array with expected patterns', () => {
    expect(Array.isArray(jsconfig.include)).toBe(true);
    expect(jsconfig.include).toContain('src/**/*.js');
  });

  test('include array contains server.js', () => {
    expect(jsconfig.include).toContain('server.js');
  });

  test('has exclude array', () => {
    expect(Array.isArray(jsconfig.exclude)).toBe(true);
    expect(jsconfig.exclude.length).toBeGreaterThan(0);
  });

  test('exclude array contains node_modules', () => {
    expect(jsconfig.exclude).toContain('node_modules');
  });

  test('exclude array contains dist', () => {
    expect(jsconfig.exclude).toContain('dist');
  });

  test('has paths with @khy/shared alias', () => {
    expect(jsconfig.compilerOptions.paths).toBeDefined();
    expect(jsconfig.compilerOptions.paths['@khy/shared']).toBeDefined();
  });
});
