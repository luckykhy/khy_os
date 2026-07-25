'use strict';

/**
 * Tests for lspClient.js — Language Server Protocol integration.
 */

// Mock the logger
jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  debug: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const path = require('path');
const { LspClient, detectLanguageServers, SERVER_REGISTRY } = require('../src/services/lspClient');

describe('lspClient', () => {
  // ── SERVER_REGISTRY ──

  describe('SERVER_REGISTRY', () => {
    test('has 8 language entries', () => {
      const keys = Object.keys(SERVER_REGISTRY);
      expect(keys).toHaveLength(8);
    });

    test('contains expected languages', () => {
      const keys = Object.keys(SERVER_REGISTRY);
      expect(keys).toEqual(expect.arrayContaining([
        'javascript', 'typescript', 'python', 'rust', 'go', 'java', 'c', 'vue',
      ]));
    });

    test('each entry has command, args, extensions, detect, and install', () => {
      for (const [lang, config] of Object.entries(SERVER_REGISTRY)) {
        expect(config).toHaveProperty('command');
        expect(config).toHaveProperty('args');
        expect(config).toHaveProperty('extensions');
        expect(config).toHaveProperty('detect');
        expect(config).toHaveProperty('install');

        expect(typeof config.command).toBe('string');
        expect(Array.isArray(config.args)).toBe(true);
        expect(Array.isArray(config.extensions)).toBe(true);
        expect(Array.isArray(config.detect)).toBe(true);
        expect(typeof config.install).toBe('string');
      }
    });

    test('each extensions array contains dot-prefixed strings', () => {
      for (const config of Object.values(SERVER_REGISTRY)) {
        for (const ext of config.extensions) {
          expect(ext).toMatch(/^\./);
        }
      }
    });
  });

  // ── detectLanguageServers() ──

  describe('detectLanguageServers()', () => {
    test('returns an array', () => {
      // Use a temp directory with no marker files — should return empty
      const result = detectLanguageServers('/tmp');
      expect(Array.isArray(result)).toBe(true);
    });

    test('each result has expected shape', () => {
      // Use the backend root which has package.json
      const result = detectLanguageServers(path.join(__dirname, '..'));
      for (const item of result) {
        expect(item).toHaveProperty('language');
        expect(item).toHaveProperty('command');
        expect(item).toHaveProperty('available');
        expect(item).toHaveProperty('install');
        expect(item).toHaveProperty('extensions');
      }
    });
  });

  // ── LspClient constructor ──

  describe('LspClient constructor', () => {
    test('sets rootPath from options', () => {
      const client = new LspClient({ rootPath: '/some/project' });
      expect(client._rootPath).toBe('/some/project');
    });

    test('defaults rootPath to cwd if not provided', () => {
      const client = new LspClient({});
      expect(client._rootPath).toBe(path.resolve(process.cwd()));
    });

    test('initialized starts as false', () => {
      const client = new LspClient({ rootPath: '/tmp' });
      expect(client.initialized).toBe(false);
    });
  });

  // ── _extToLanguageId() ──

  describe('LspClient._extToLanguageId()', () => {
    let client;

    beforeAll(() => {
      client = new LspClient({ rootPath: '/tmp' });
    });

    test('.js maps to javascript', () => {
      expect(client._extToLanguageId('.js')).toBe('javascript');
    });

    test('.py maps to python', () => {
      expect(client._extToLanguageId('.py')).toBe('python');
    });

    test('.rs maps to rust', () => {
      expect(client._extToLanguageId('.rs')).toBe('rust');
    });

    test('.go maps to go', () => {
      expect(client._extToLanguageId('.go')).toBe('go');
    });

    test('.ts maps to typescript', () => {
      expect(client._extToLanguageId('.ts')).toBe('typescript');
    });

    test('.tsx maps to typescriptreact', () => {
      expect(client._extToLanguageId('.tsx')).toBe('typescriptreact');
    });

    test('.vue maps to vue', () => {
      expect(client._extToLanguageId('.vue')).toBe('vue');
    });

    test('unknown extension maps to plaintext', () => {
      expect(client._extToLanguageId('.xyz')).toBe('plaintext');
    });
  });

  // ── _normalizeLocations() ──

  describe('LspClient._normalizeLocations()', () => {
    let client;

    beforeAll(() => {
      client = new LspClient({ rootPath: '/tmp' });
    });

    test('with array input returns mapped locations', () => {
      const input = [
        { uri: 'file:///a.js', range: { start: { line: 0, character: 0 } } },
        { uri: 'file:///b.js', range: { start: { line: 5, character: 3 } } },
      ];

      const result = client._normalizeLocations(input);
      expect(result).toHaveLength(2);
      expect(result[0].uri).toBe('file:///a.js');
      expect(result[0].filePath).toBe('/a.js');
      expect(result[1].uri).toBe('file:///b.js');
    });

    test('with single location object wraps it in array', () => {
      const input = { uri: 'file:///single.js', range: { start: { line: 1, character: 0 } } };

      const result = client._normalizeLocations(input);
      expect(result).toHaveLength(1);
      expect(result[0].uri).toBe('file:///single.js');
    });

    test('with null input returns empty array', () => {
      const result = client._normalizeLocations(null);
      expect(result).toEqual([]);
    });

    test('with undefined input returns empty array', () => {
      const result = client._normalizeLocations(undefined);
      expect(result).toEqual([]);
    });

    test('with empty array input returns empty array', () => {
      const result = client._normalizeLocations([]);
      expect(result).toEqual([]);
    });
  });

  // ── _detectLanguage() ──

  describe('LspClient._detectLanguage()', () => {
    test('detects javascript when package.json exists', () => {
      const fs = require('fs');
      const origExistsSync = fs.existsSync;

      // Mock fs.existsSync to simulate a project with package.json
      fs.existsSync = jest.fn((filePath) => {
        if (filePath.endsWith('package.json')) return true;
        return false;
      });

      const client = new LspClient({ rootPath: '/fake/project' });
      const result = client._detectLanguage();
      expect(result).toBe('javascript');

      fs.existsSync = origExistsSync;
    });

    test('returns null when no marker files exist', () => {
      const fs = require('fs');
      const origExistsSync = fs.existsSync;

      fs.existsSync = jest.fn(() => false);

      const client = new LspClient({ rootPath: '/empty/project' });
      const result = client._detectLanguage();
      expect(result).toBeNull();

      fs.existsSync = origExistsSync;
    });
  });
});
