const fs = require('fs');
const os = require('os');
const path = require('path');

describe('modelImportService format detection', () => {
  let tmpDir;

  beforeEach(() => {
    jest.resetModules();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-model-import-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  test('detectModelFormat treats extensionless GGUF magic blob as gguf', () => {
    const blobPath = path.join(tmpDir, 'sha256-1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcd');
    const fd = fs.openSync(blobPath, 'w');
    const magic = Buffer.from('GGUF');
    fs.writeSync(fd, magic, 0, magic.length, 0);
    fs.closeSync(fd);
    fs.truncateSync(blobPath, 80 * 1024 * 1024);

    const svc = require('../../src/services/modelImportService');
    const out = svc.detectModelFormat(blobPath);

    expect(out.kind).toBe('gguf');
    expect(out.absPath).toBe(blobPath);
  });

  test('detectModelFormat accepts .rar as archive input', () => {
    const archivePath = path.join(tmpDir, 'qwen-export.rar');
    fs.writeFileSync(archivePath, 'dummy');

    const svc = require('../../src/services/modelImportService');
    const out = svc.detectModelFormat(archivePath);

    expect(out.kind).toBe('archive');
    expect(out.absPath).toBe(archivePath);
  });
});
