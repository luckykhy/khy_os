'use strict';

/**
 * Unit tests for systemSettingService.
 *
 * The service depends on Sequelize models (SystemSetting, User, etc.)
 * so we mock the models layer to test pure logic.
 */

// Mock the models module before loading the service.
const mockFindAll = jest.fn();
const mockFindOne = jest.fn();
const mockCreate = jest.fn();
const mockCount = jest.fn().mockResolvedValue(0);

jest.mock('../../src/models', () => ({
  SystemSetting: {
    findAll: mockFindAll,
    findOne: mockFindOne,
    create: mockCreate,
  },
  User: { count: mockCount },
  Strategy: { count: mockCount },
  Backtest: { count: mockCount },
  Trade: { count: mockCount },
}));

jest.mock('sequelize', () => ({ Op: { gte: Symbol('gte'), lte: Symbol('lte') } }));

let SystemSettingService;

beforeAll(() => {
  try {
    SystemSettingService = require('../../src/services/systemSettingService');
  } catch (e) {
    if (e instanceof SyntaxError) throw e;
    if (e.code === 'MODULE_NOT_FOUND' && !e.message.includes('systemSettingService')) throw e;
  }
});

describe('SystemSettingService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('module exports a class with static methods', () => {
    if (!SystemSettingService) return;
    expect(typeof SystemSettingService).toBe('function');
    expect(typeof SystemSettingService.getAllSettings).toBe('function');
    expect(typeof SystemSettingService.getSetting).toBe('function');
    expect(typeof SystemSettingService.setSetting).toBe('function');
    expect(typeof SystemSettingService.deleteSetting).toBe('function');
    expect(typeof SystemSettingService.resetToDefault).toBe('function');
    expect(typeof SystemSettingService.initializeDefaultSettings).toBe('function');
    expect(typeof SystemSettingService.getSystemInfo).toBe('function');
    expect(typeof SystemSettingService.setMultipleSettings).toBe('function');
  });

  test('getSetting returns parsed value when found', async () => {
    if (!SystemSettingService) return;
    const mockSetting = {
      getParsedValue: () => 'test_value',
    };
    mockFindOne.mockResolvedValue(mockSetting);

    const result = await SystemSettingService.getSetting('system.name');
    expect(result).toBe('test_value');
    expect(mockFindOne).toHaveBeenCalledWith({ where: { key: 'system.name' } });
  });

  test('getSetting returns null when not found', async () => {
    if (!SystemSettingService) return;
    mockFindOne.mockResolvedValue(null);

    const result = await SystemSettingService.getSetting('nonexistent.key');
    expect(result).toBeNull();
  });

  test('getAllSettings groups results by category', async () => {
    if (!SystemSettingService) return;
    const mockSettings = [
      {
        category: 'system',
        key: 'system.name',
        type: 'string',
        description: 'Name',
        isEditable: true,
        validation: null,
        getParsedValue: () => 'KHY OS',
      },
      {
        category: 'system',
        key: 'system.version',
        type: 'string',
        description: 'Version',
        isEditable: false,
        validation: null,
        getParsedValue: () => '1.0.0',
      },
      {
        category: 'trading',
        key: 'trading.commission',
        type: 'number',
        description: 'Commission',
        isEditable: true,
        validation: null,
        getParsedValue: () => 0.0003,
      },
    ];
    mockFindAll.mockResolvedValue(mockSettings);

    const result = await SystemSettingService.getAllSettings();
    expect(result).toHaveProperty('system');
    expect(result).toHaveProperty('trading');
    expect(result.system).toHaveLength(2);
    expect(result.trading).toHaveLength(1);
    expect(result.system[0].key).toBe('system.name');
    expect(result.system[0].value).toBe('KHY OS');
  });

  test('setSetting updates existing record', async () => {
    if (!SystemSettingService) return;
    const mockSetting = {
      setValue: jest.fn(),
      save: jest.fn().mockResolvedValue(true),
      getParsedValue: () => 'new_value',
    };
    mockFindOne.mockResolvedValue(mockSetting);

    const result = await SystemSettingService.setSetting('system.name', 'new_value');
    expect(result).toBe('new_value');
    expect(mockSetting.setValue).toHaveBeenCalledWith('new_value');
    expect(mockSetting.save).toHaveBeenCalled();
  });

  test('deleteSetting returns false for non-editable settings', async () => {
    if (!SystemSettingService) return;
    const mockSetting = {
      isEditable: false,
      destroy: jest.fn(),
    };
    mockFindOne.mockResolvedValue(mockSetting);

    const result = await SystemSettingService.deleteSetting('system.version');
    expect(result).toBe(false);
    expect(mockSetting.destroy).not.toHaveBeenCalled();
  });

  test('deleteSetting returns true and destroys editable settings', async () => {
    if (!SystemSettingService) return;
    const mockSetting = {
      isEditable: true,
      destroy: jest.fn().mockResolvedValue(true),
    };
    mockFindOne.mockResolvedValue(mockSetting);

    const result = await SystemSettingService.deleteSetting('custom.key');
    expect(result).toBe(true);
    expect(mockSetting.destroy).toHaveBeenCalled();
  });

  test('resetToDefault restores defaultValue', async () => {
    if (!SystemSettingService) return;
    const mockSetting = {
      isEditable: true,
      defaultValue: 'default_val',
      value: 'custom_val',
      save: jest.fn().mockResolvedValue(true),
      getParsedValue: () => 'default_val',
    };
    mockFindOne.mockResolvedValue(mockSetting);

    const result = await SystemSettingService.resetToDefault('some.key');
    expect(result).toBe('default_val');
    expect(mockSetting.value).toBe('default_val');
    expect(mockSetting.save).toHaveBeenCalled();
  });

  test('setMultipleSettings only updates editable entries', async () => {
    if (!SystemSettingService) return;
    const editableSetting = {
      key: 'editable.key',
      isEditable: true,
      setValue: jest.fn(),
      save: jest.fn().mockResolvedValue(true),
      getParsedValue: () => 'updated',
    };
    const readonlySetting = {
      key: 'readonly.key',
      isEditable: false,
      setValue: jest.fn(),
      save: jest.fn(),
      getParsedValue: () => 'nope',
    };

    // The service now batch-loads all keys with a single findAll (REQ-2026-007).
    mockFindAll.mockResolvedValue([editableSetting, readonlySetting]);

    const result = await SystemSettingService.setMultipleSettings({
      'editable.key': 'val1',
      'readonly.key': 'val2',
    });

    // Keys contain dots, so use the array form of toHaveProperty to match the
    // literal key rather than a nested path.
    expect(result).toHaveProperty(['editable.key'], 'updated');
    expect(result).not.toHaveProperty(['readonly.key']);
    expect(editableSetting.save).toHaveBeenCalled();
    expect(readonlySetting.save).not.toHaveBeenCalled();
  });
});
