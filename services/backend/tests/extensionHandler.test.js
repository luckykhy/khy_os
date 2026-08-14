'use strict';

/**
 * Tests for cli/handlers/extension.js — extension marketplace CLI handler.
 */

// Mock the logger
jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  debug: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

// Mock the marketplace module to avoid filesystem/network access
jest.mock('../src/services/extensionMarketplace', () => ({
  list: jest.fn(() => []),
  search: jest.fn(async () => []),
  install: jest.fn(() => ({ name: 'test-ext', version: '1.0.0' })),
  installFromRegistry: jest.fn(async () => ({ name: 'registry-ext', version: '2.0.0' })),
  uninstall: jest.fn(),
  enable: jest.fn(),
  disable: jest.fn(),
  updateExtension: jest.fn(async () => ({ name: 'ext', oldVersion: '1.0', newVersion: '2.0' })),
  checkUpdates: jest.fn(async () => []),
  link: jest.fn(() => ({ name: 'linked-ext' })),
  unlink: jest.fn(),
  scaffold: jest.fn(() => ({ path: '/tmp/new-ext', files: ['index.js', 'manifest.json'] })),
  getInfo: jest.fn(async () => null),
}));

// Mock the formatters module
jest.mock('../src/cli/formatters', () => ({
  printSuccess: jest.fn(),
  printError: jest.fn(),
  printInfo: jest.fn(),
  printWarn: jest.fn(),
  printTable: jest.fn(),
}));

const { handleExtension } = require('../src/cli/handlers/extension');
const marketplace = require('../src/services/extensionMarketplace');
const { printSuccess, printError, printInfo, printWarn, printTable } = require('../src/cli/formatters');

describe('extensionHandler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ── help subcommand ──

  describe('handleExtension("help")', () => {
    test('prints help text to console.log', async () => {
      const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
      await handleExtension('help');

      expect(spy).toHaveBeenCalled();
      const output = spy.mock.calls[0][0];
      expect(output).toContain('Extension Manager');
      expect(output).toContain('ext list');
      expect(output).toContain('ext install');
      spy.mockRestore();
    });
  });

  // ── list subcommand ──

  describe('handleExtension("list")', () => {
    test('calls marketplace.list()', async () => {
      await handleExtension('list');
      expect(marketplace.list).toHaveBeenCalled();
    });

    test('shows info message when no extensions installed', async () => {
      marketplace.list.mockReturnValueOnce([]);
      await handleExtension('list');
      expect(printInfo).toHaveBeenCalledWith(
        expect.stringContaining('No extensions installed')
      );
    });

    test('calls printTable when extensions exist', async () => {
      marketplace.list.mockReturnValueOnce([
        { name: 'ext-a', version: '1.0.0', enabled: true, capabilities: ['skill'] },
      ]);

      await handleExtension('list');
      expect(printTable).toHaveBeenCalled();
    });
  });

  // ── empty/default subcommand ──

  describe('handleExtension("") / default', () => {
    test('defaults to list when given empty string', async () => {
      await handleExtension('');
      expect(marketplace.list).toHaveBeenCalled();
    });

    test('defaults to list when given null/undefined', async () => {
      await handleExtension(null);
      expect(marketplace.list).toHaveBeenCalled();
    });
  });

  // ── search subcommand ──

  describe('handleExtension("search ...")', () => {
    test('calls marketplace.search with query', async () => {
      marketplace.search.mockResolvedValueOnce([
        { name: 'found-ext', version: '1.0', description: 'desc', author: 'me' },
      ]);

      await handleExtension('search my-query');
      expect(marketplace.search).toHaveBeenCalledWith('my-query');
    });

    test('prints warning when no query given', async () => {
      await handleExtension('search');
      expect(printWarn).toHaveBeenCalledWith(expect.stringContaining('Usage'));
    });
  });

  // ── install subcommand ──

  describe('handleExtension("install ...")', () => {
    test('calls marketplace.installFromRegistry for plain names', async () => {
      await handleExtension('install my-ext');
      expect(marketplace.installFromRegistry).toHaveBeenCalledWith('my-ext');
    });

    test('prints warning when no source given', async () => {
      await handleExtension('install');
      expect(printWarn).toHaveBeenCalledWith(expect.stringContaining('Usage'));
    });

    test('prints success on successful install', async () => {
      await handleExtension('install cool-ext');
      expect(printSuccess).toHaveBeenCalledWith(expect.stringContaining('installed successfully'));
    });
  });

  // ── uninstall subcommand ──

  describe('handleExtension("uninstall ...")', () => {
    test('calls marketplace.uninstall', async () => {
      await handleExtension('uninstall bad-ext');
      expect(marketplace.uninstall).toHaveBeenCalledWith('bad-ext');
      expect(printSuccess).toHaveBeenCalled();
    });

    test('prints error when uninstall throws', async () => {
      marketplace.uninstall.mockImplementationOnce(() => {
        throw new Error('Not found');
      });
      await handleExtension('uninstall ghost-ext');
      expect(printError).toHaveBeenCalledWith(expect.stringContaining('Not found'));
    });
  });

  // ── enable/disable subcommands ──

  describe('handleExtension("enable/disable")', () => {
    test('enable calls marketplace.enable', async () => {
      await handleExtension('enable my-ext');
      expect(marketplace.enable).toHaveBeenCalledWith('my-ext');
    });

    test('disable calls marketplace.disable', async () => {
      await handleExtension('disable my-ext');
      expect(marketplace.disable).toHaveBeenCalledWith('my-ext');
    });
  });
});
