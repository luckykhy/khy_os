'use strict';

const {
  registerPermissionPrompter,
  getPermissionPrompter,
  _resetForTest,
} = require('./permissionPromptPort');

describe('permissionPromptPort', () => {
  afterEach(() => {
    _resetForTest();
  });

  it('should export registerPermissionPrompter', () => {
    expect(typeof registerPermissionPrompter).toBe('function');
  });

  it('should export getPermissionPrompter', () => {
    expect(typeof getPermissionPrompter).toBe('function');
  });

  it('getPermissionPrompter returns null initially', () => {
    expect(getPermissionPrompter()).toBeNull();
  });

  it('registerPermissionPrompter sets prompt and promptBatch', () => {
    const prompt = jest.fn();
    const promptBatch = jest.fn();
    registerPermissionPrompter({ prompt, promptBatch });
    const prompter = getPermissionPrompter();
    expect(prompter).not.toBeNull();
    expect(prompter.prompt).toBe(prompt);
    expect(prompter.promptBatch).toBe(promptBatch);
  });

  it('registerPermissionPrompter accepts partial impl', () => {
    const prompt = jest.fn();
    registerPermissionPrompter({ prompt });
    const prompter = getPermissionPrompter();
    expect(prompter.prompt).toBe(prompt);
    expect(prompter.promptBatch).toBeNull();
  });

  it('registerPermissionPrompter with non-function members', () => {
    registerPermissionPrompter({ prompt: 'not fn', promptBatch: 'not fn' });
    const prompter = getPermissionPrompter();
    expect(prompter.prompt).toBeNull();
    expect(prompter.promptBatch).toBeNull();
  });

  it('registerPermissionPrompter with null clears prompter', () => {
    registerPermissionPrompter({ prompt: jest.fn() });
    registerPermissionPrompter(null);
    expect(getPermissionPrompter()).toBeNull();
  });

  it('registerPermissionPrompter with non-object clears prompter', () => {
    registerPermissionPrompter({ prompt: jest.fn() });
    registerPermissionPrompter('string');
    expect(getPermissionPrompter()).toBeNull();
  });

  it('_resetForTest clears the prompter', () => {
    registerPermissionPrompter({ prompt: jest.fn() });
    _resetForTest();
    expect(getPermissionPrompter()).toBeNull();
  });
});

