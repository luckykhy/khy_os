'use strict';

// Verifies the cheerio lazy-load degradation: when cheerio cannot be required,
// the HTML parsers degrade to [] instead of throwing at module load (the Windows
// failure mode), and isHtmlParsingAvailable() reports the state.

describe('webSearch cheerio lazy degradation', () => {
  afterEach(() => {
    jest.resetModules();
    jest.dontMock('cheerio');
  });

  test('cheerio present: parsing available, parser returns results', () => {
    jest.resetModules();
    const svc = require('../src/services/webSearchService');
    expect(svc.isHtmlParsingAvailable()).toBe(true);
    const r = svc.__parsersForTests.parseBaiduHtml(
      '<div id="content_left"><div class="result c-container"><h3><a href="https://e.test/1">T</a></h3></div></div>',
    );
    expect(r.length).toBe(1);
  });

  test('cheerio absent: module loads, parsers return [] (no throw), unavailable', () => {
    jest.resetModules();
    jest.doMock('cheerio', () => { throw new Error('Cannot find module cheerio'); }, { virtual: true });
    // Re-require fresh so the tri-state cache starts at null and hits the mock.
    let svc;
    expect(() => { svc = require('../src/services/webSearchService'); }).not.toThrow();
    expect(svc.isHtmlParsingAvailable()).toBe(false);
    expect(() => svc.__parsersForTests.parseBaiduHtml('<div></div>')).not.toThrow();
    expect(svc.__parsersForTests.parseBaiduHtml('<div></div>')).toEqual([]);
    expect(svc.__parsersForTests.parseBingHtml('<div></div>')).toEqual([]);
    expect(svc.__parsersForTests.parseDuckDuckGoHtml('<div></div>')).toEqual([]);
  });
});
