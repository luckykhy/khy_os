'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

describe('toolCalling open_app aliases', () => {
  afterEach(() => {
    jest.resetModules();
  });

  test('maps Feishu/Lark aliases to desktop launcher candidate', () => {
    const toolCalling = require('../src/services/toolCalling');
    const feishuCandidates = toolCalling._buildAppCandidates('飞书');
    const larkCandidates = toolCalling._buildAppCandidates('lark');
    const englishCandidates = toolCalling._buildAppCandidates('feishu');

    expect(feishuCandidates).toContain('bytedance-feishu');
    expect(larkCandidates).toContain('bytedance-feishu');
    expect(englishCandidates).toContain('bytedance-feishu');
  });
});

describe('toolCalling open_app default-handler triage', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  test('_resolveOpenDefaultTarget: a URL is delegated verbatim', () => {
    const toolCalling = require('../src/services/toolCalling');
    expect(toolCalling._resolveOpenDefaultTarget('https://example.com')).toBe('https://example.com');
    expect(toolCalling._resolveOpenDefaultTarget('http://localhost:9090')).toBe('http://localhost:9090');
    expect(toolCalling._resolveOpenDefaultTarget('file:///C:/x.html')).toBe('file:///C:/x.html');
  });

  test('_resolveOpenDefaultTarget: an existing file resolves to its absolute path', () => {
    const toolCalling = require('../src/services/toolCalling');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-openapp-'));
    const htmlAbs = path.join(dir, 'page.html');
    fs.writeFileSync(htmlAbs, '<html></html>', 'utf8');

    // Absolute path
    expect(toolCalling._resolveOpenDefaultTarget(htmlAbs)).toBe(htmlAbs);
    // Relative path resolved against the supplied cwd
    expect(toolCalling._resolveOpenDefaultTarget('page.html', dir)).toBe(htmlAbs);
  });

  test('_resolveOpenDefaultTarget: a real app name / missing path falls through (null)', () => {
    const toolCalling = require('../src/services/toolCalling');
    expect(toolCalling._resolveOpenDefaultTarget('docker')).toBeNull();
    expect(toolCalling._resolveOpenDefaultTarget('火狐')).toBeNull();
    // Executable suffix must stay on the launch path even if it exists
    expect(toolCalling._resolveOpenDefaultTarget('notepad.exe')).toBeNull();
    // A path that does not exist is treated as a (not-found) app name, not a file
    expect(toolCalling._resolveOpenDefaultTarget('/no/such/file-xyz.html')).toBeNull();
  });

  test('open_app handler: URL is opened with the system default handler', async () => {
    const openDefault = jest.fn(() => ({ unref() {} }));
    jest.doMock('../src/tools/platformUtils', () => ({
      openDefault,
      getDisplay: () => ':0', // satisfy _hasGraphicalSession on Linux runners
    }));

    const toolCalling = require('../src/services/toolCalling');
    const openApp = toolCalling.BUILTIN_TOOLS.find((t) => t.name === 'open_app');
    const result = await openApp.handler({ name: 'https://example.com' });

    expect(openDefault).toHaveBeenCalledWith('https://example.com');
    expect(result.success).toBe(true);
    expect(result.mode).toBe('openDefault');
    expect(result.target).toBe('https://example.com');
  });

  test('open_app handler: existing .html file is delegated by absolute path', async () => {
    const openDefault = jest.fn(() => ({ unref() {} }));
    jest.doMock('../src/tools/platformUtils', () => ({
      openDefault,
      getDisplay: () => ':0',
    }));

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-openapp-'));
    const htmlAbs = path.join(dir, 'report.html');
    fs.writeFileSync(htmlAbs, '<html></html>', 'utf8');

    const toolCalling = require('../src/services/toolCalling');
    const openApp = toolCalling.BUILTIN_TOOLS.find((t) => t.name === 'open_app');
    const result = await openApp.handler({ name: htmlAbs });

    expect(openDefault).toHaveBeenCalledWith(htmlAbs);
    expect(result.success).toBe(true);
    expect(result.mode).toBe('openDefault');
  });

  test('open_app handler: a real app name does NOT call openDefault (zero regression)', async () => {
    const openDefault = jest.fn(() => ({ unref() {} }));
    jest.doMock('../src/tools/platformUtils', () => ({
      openDefault,
      getDisplay: () => ':0',
      // The app-match fallback path consults the real launcher helpers; stub the
      // executable probe so the name resolves to "not found" without spawning.
      searchExecutable: () => null,
    }));

    const toolCalling = require('../src/services/toolCalling');
    const openApp = toolCalling.BUILTIN_TOOLS.find((t) => t.name === 'open_app');
    // A name that is neither a URL nor an existing file → app-match path.
    const result = await openApp.handler({ name: 'definitely-not-a-real-app-zzz' });

    expect(openDefault).not.toHaveBeenCalled();
    // It should honestly report not-found rather than silently delegating.
    expect(result.success).toBe(false);
  });
});
