'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

describe('scaffoldFiles tool', () => {
  const originalEnv = { ...process.env };
  let tempDir = '';

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-scaffold-test-'));
    process.env = {
      ...originalEnv,
      KHYQUANT_CWD: tempDir,
    };
    jest.resetModules();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    jest.clearAllMocks();
  });

  test('creates folders and files in batch with configured parallel writes', async () => {
    const tool = require('../src/tools/scaffoldFiles');

    const result = await tool.execute({
      root: 'demo-app',
      directories: ['src', 'src/components', 'tests'],
      files: [
        { path: 'package.json', content: '{\n  "name": "demo-app"\n}\n' },
        { path: 'src/index.js', content: 'console.log("hello");\n' },
        { path: 'tests/app.test.js', content: 'test("ok", () => expect(true).toBe(true));\n' },
      ],
      writeConcurrency: 4,
    });

    expect(result.success).toBe(true);
    expect(result.writeConcurrency).toBe(4);
    expect(result.createdFileCount).toBe(3);

    const root = path.join(tempDir, 'demo-app');
    expect(fs.existsSync(path.join(root, 'src'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'src/components'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'tests'))).toBe(true);
    expect(fs.readFileSync(path.join(root, 'src/index.js'), 'utf-8')).toContain('hello');
  });

  test('skips existing files when overwrite is false, then overwrites when true', async () => {
    const tool = require('../src/tools/scaffoldFiles');
    const target = path.join(tempDir, 'demo', 'src', 'main.js');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'old\n', 'utf-8');

    const first = await tool.execute({
      root: 'demo',
      files: [{ path: 'src/main.js', content: 'new\n' }],
      overwrite: false,
      writeConcurrency: 2,
    });
    expect(first.success).toBe(true);
    expect(first.skippedFileCount).toBe(1);
    expect(fs.readFileSync(target, 'utf-8')).toBe('old\n');

    const second = await tool.execute({
      root: 'demo',
      files: [{ path: 'src/main.js', content: 'new\n' }],
      overwrite: true,
      writeConcurrency: 2,
    });
    expect(second.success).toBe(true);
    expect(second.overwrittenFileCount).toBe(1);
    expect(fs.readFileSync(target, 'utf-8')).toBe('new\n');
  });
});
