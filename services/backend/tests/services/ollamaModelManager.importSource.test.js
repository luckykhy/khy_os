const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('child_process', () => {
  const actual = jest.requireActual('child_process');
  return {
    ...actual,
    spawnSync: jest.fn((cmd, args) => {
      if (Array.isArray(args) && args.includes('--version')) {
        return { status: 0, error: null, stdout: 'ollama version is 0.0.0', stderr: '' };
      }
      return { status: 0, error: null, stdout: '', stderr: '' };
    }),
  };
});

describe('ollamaModelManager inferImportSource', () => {
  let tmpDir;

  beforeEach(() => {
    jest.resetModules();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-ollama-src-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  test('importModel accepts extensionless GGUF magic blob path', async () => {
    const blobPath = path.join(tmpDir, 'sha256-abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdef');
    const fd = fs.openSync(blobPath, 'w');
    const magic = Buffer.from('GGUF');
    fs.writeSync(fd, magic, 0, magic.length, 0);
    fs.closeSync(fd);
    fs.truncateSync(blobPath, 80 * 1024 * 1024);

    const mgr = require('../../src/services/ollamaModelManager');
    const result = await mgr.importModel(blobPath, 'blob-test-model');

    expect(result.success).toBe(true);
    expect(result.source).toBe(blobPath);
    expect(result.sourceKind).toBe('gguf');
  });
});
