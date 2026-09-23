'use strict';

// Regression guard for the G-H `searchWeb` name-drift in
// localBrainService._fetchJokeFromWeb: the code imported a non-existent
// `searchWeb` export from webSearchService, so the typeof-guarded "方案 2
// (web search)" branch silently no-op'd forever. The fix binds the real
// `search` (searchUnified) and unwraps its {success, results:[…]} payload.
//
// 方案1 (vvhan https) and 方案3 (jokeapi https) are forced to fail by mocking
// https.get to emit 'error', so ONLY 方案2 can produce a result — proving the
// web-search path is genuinely wired now.

// Force every https.get (方案1 + 方案3) to reject so 方案2 is the sole source.
jest.mock('https', () => ({
  get: jest.fn(() => {
    const req = {
      on: (event, cb) => {
        if (event === 'error') setImmediate(() => cb(new Error('mock network down')));
        return req;
      },
      destroy: () => {},
    };
    return req;
  }),
}));

// webSearchService is lazy-required inside the function.
jest.mock('../../src/services/webSearchService', () => ({
  search: jest.fn(),
}));

const { search } = require('../../src/services/webSearchService');
const { _fetchJokeFromWeb } = require('../../src/services/localBrainService');

describe('_fetchJokeFromWeb 方案2 web-search fallback (searchWeb name-drift fix)', () => {
  beforeEach(() => {
    search.mockReset();
  });

  test('unwraps {success, results:[…]} object payload returned by search()', async () => {
    const snippet = '为什么程序员分不清万圣节和圣诞节？因为 Oct 31 == Dec 25。';
    search.mockResolvedValueOnce({ success: true, results: [{ snippet }] });

    const result = await _fetchJokeFromWeb('programming');

    expect(search).toHaveBeenCalledTimes(1);
    expect(result).toBe(snippet);
  });

  test('tolerates a bare-array return shape from search()', async () => {
    const snippet = '一个足够长的冷笑话：把冰箱门打开，把长颈鹿放进去，把门关上。';
    search.mockResolvedValueOnce([{ snippet }]);

    const result = await _fetchJokeFromWeb('cold');

    expect(result).toBe(snippet);
  });

  test('falls through to falsy when search yields no usable results', async () => {
    search.mockResolvedValueOnce({ success: true, results: [] });

    const result = await _fetchJokeFromWeb('tech');

    // 方案2 empty → 方案3 (https mocked to fail) → nothing returned.
    expect(result).toBeFalsy();
  });
});
