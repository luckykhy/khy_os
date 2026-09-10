'use strict';

const pickUserText = require('../../src/utils/pickUserTextSafe');

jest.mock('../../src/services/latestUserText');

describe('pickUserTextSafe', () => {
  const latestUserText = require('../../src/services/latestUserText');

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('delegates to latestUserText.pickUserText', () => {
    latestUserText.pickUserText.mockReturnValue('delegated');
    const result = pickUserText('prompt', { messages: [] });
    expect(latestUserText.pickUserText).toHaveBeenCalledWith('prompt', { messages: [] }, process.env);
    expect(result).toBe('delegated');
  });

  test('falls back to prompt string on error', () => {
    latestUserText.pickUserText.mockImplementation(() => { throw new Error('fail'); });
    const result = pickUserText('  direct prompt  ', {});
    expect(result).toBe('direct prompt');
  });

  test('falls back to last user message', () => {
    latestUserText.pickUserText.mockImplementation(() => { throw new Error('fail'); });
    const messages = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'last user msg' }
    ];
    const result = pickUserText('', { messages });
    expect(result).toBe('last user msg');
  });

  test('handles array content in messages', () => {
    latestUserText.pickUserText.mockImplementation(() => { throw new Error('fail'); });
    const messages = [
      { role: 'user', content: [
        { text: 'part1' },
        { text: 'part2' }
      ]}
    ];
    const result = pickUserText('', { messages });
    expect(result).toBe('part1 part2');
  });

  test('returns empty string when nothing found', () => {
    latestUserText.pickUserText.mockImplementation(() => { throw new Error('fail'); });
    const result = pickUserText('', { messages: [] });
    expect(result).toBe('');
  });
});

