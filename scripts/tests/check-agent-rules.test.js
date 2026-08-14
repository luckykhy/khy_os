'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const scriptPath = path.join(ROOT, 'scripts', 'ci', 'check-agent-rules.js');

// Build ESC-related fixture content WITHOUT writing a literal "\x1b" token in
// this source file — the editing/tooling layer rewrites that token into a raw
// ESC byte unpredictably. Concatenation and char codes keep the bytes exact.
const ESC = String.fromCharCode(27); // raw ESC byte (0x1b)
const BS = '\\'; // a single backslash character
const TEXT_X1B = BS + 'x1b'; // the four-character source text:  backslash x 1 b
const TEXT_U001B = BS + 'u001b'; // the source text:  backslash u 0 0 1 b

let tmpDir;

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function runGate(...targets) {
  const outputPath = path.join(
    os.tmpdir(),
    `khy-agent-rules-${process.pid}-${targets.length}-${Buffer.from(targets.join('|')).toString('hex').slice(0, 12)}.log`,
  );
  const command = [
    'node',
    shellQuote(path.relative(ROOT, scriptPath)),
    ...targets.map(shellQuote),
    '>',
    shellQuote(outputPath),
    '2>&1',
  ].join(' ');

  let status = 0;
  try {
    execSync(command, { cwd: ROOT, stdio: 'ignore', shell: '/bin/bash' });
  } catch (error) {
    status = typeof error.status === 'number' ? error.status : 1;
  }

  const stdout = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : '';
  fs.rmSync(outputPath, { force: true });
  return { status, stdout };
}

function fixture(name, content) {
  const full = path.join(tmpDir, name);
  fs.writeFileSync(full, content);
  return full;
}

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-agent-rules-fix-'));
});

after(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('check-agent-rules Rule 4 — scroll-region (DECSTBM) detection', () => {
  test('flags a raw-ESC scroll-region escape in an inline context as an error', () => {
    const file = fixture(
      'inline-raw.js',
      `function setMargin(top, bottom) {\n  process.stdout.write(${'`'}${ESC}[${'${top}'};${'${bottom}'}r${'`'});\n}\n`,
    );
    const { status, stdout } = runGate(file);
    assert.equal(status, 1, 'inline DECSTBM must fail the gate');
    assert.match(stdout, /\[ERROR\] no-scroll-region/);
    assert.match(stdout, /inline-raw\.js/);
  });

  test('flags the escaped TEXT form (backslash-x1b) the same way', () => {
    const file = fixture(
      'inline-text.js',
      `const seq = "${TEXT_X1B}[1;40r";\nprocess.stdout.write(seq);\n`,
    );
    const { status, stdout } = runGate(file);
    assert.equal(status, 1, 'textual DECSTBM must fail the gate');
    assert.match(stdout, /\[ERROR\] no-scroll-region/);
  });

  test('downgrades to a warning when the file uses the alternate buffer', () => {
    const file = fixture(
      'fullscreen.js',
      `function enter() {\n  process.stdout.write("${TEXT_X1B}[?1049h");\n  process.stdout.write("${TEXT_U001B}[1;40r");\n}\n`,
    );
    const { status, stdout } = runGate(file);
    assert.match(stdout, /\[WARN \] no-scroll-region/);
    assert.doesNotMatch(stdout, /\[ERROR\] no-scroll-region/);
    // A lone warning (no error) must not, by itself, fail the gate.
    assert.equal(status, 0, 'alt-buffer DECSTBM is a warning, not a hard failure');
  });

  test('does not false-positive on destructuring, indexing, or regex char classes', () => {
    const file = fixture(
      'clean.js',
      'const [r] = arr;\nconst x = arr[0];\nconst re = /[rw]+/;\nconst s = "draw a rectangle";\n',
    );
    const { status, stdout } = runGate(file);
    assert.doesNotMatch(stdout, /no-scroll-region/);
    assert.equal(status, 0);
  });

  test('skips scroll-region escapes that appear inside comments', () => {
    const file = fixture(
      'commented.js',
      `// example of a banned sequence: ${TEXT_X1B}[1;40r — documented, not emitted\nmodule.exports = {};\n`,
    );
    const { status, stdout } = runGate(file);
    assert.doesNotMatch(stdout, /no-scroll-region/);
    assert.equal(status, 0);
  });

  test('exempts the gate script itself (it names the pattern by design)', () => {
    const { stdout } = runGate('scripts/check-agent-rules.js');
    assert.doesNotMatch(stdout, /no-scroll-region/);
  });
});

describe('check-agent-rules Rules 1-3 — regression guard', () => {
  test('still flags a hard-coded host:port endpoint (Rule 1)', () => {
    // Assemble the offending URL at runtime so THIS source file contains no
    // contiguous "localhost:<port>" token — otherwise the gate (which CI runs
    // over scripts/) would flag the test's own fixture string.
    const badUrl = 'http://localhost:' + '9443' + '/api';
    const file = fixture('endpoint.js', `const url = '${badUrl}';\n`);
    const { status, stdout } = runGate(file);
    assert.equal(status, 1);
    assert.match(stdout, /\[ERROR\] no-hardcoded-endpoint/);
  });

  test('passes a clean configuration file with no violations', () => {
    const file = fixture('ok.js', 'const port = process.env.PORT;\nmodule.exports = { port };\n');
    const { status, stdout } = runGate(file);
    assert.equal(status, 0);
    assert.match(stdout, /no violations found/);
  });
});

describe('check-agent-rules Rule 1b — hardcoded first-party production domain', () => {
  // Assemble the first-party domain at runtime so THIS test source contains no
  // contiguous flaggable literal — CI runs the gate over scripts/ including
  // this file.
  const DOMAIN = 'khyquant' + '.top';

  test('flags a bare first-party production domain literal as an error', () => {
    const badUrl = 'https://api.' + DOMAIN;
    const file = fixture('prod-endpoint.js', `const endpoint = '${badUrl}';\n`);
    const { status, stdout } = runGate(file);
    assert.equal(status, 1, 'a hardcoded production domain must fail the gate');
    assert.match(stdout, /\[ERROR\] no-hardcoded-prod-domain/);
    assert.match(stdout, /prod-endpoint\.js/);
  });

  test('blocks an env-fallback prod-domain in a non-SoT business file', () => {
    // A `process.env.X || 'https://api.khyquant.top'` fallback still bakes the
    // production domain into a non-SoT module: any install without that env var
    // set silently forks on a domain migration. The literal belongs ONLY in a
    // constants/serviceDefaults.js (see the SoT-exemption test below). This
    // mirrors the real skillRegistry.getRegistryEndpoint regression in ai-backend.
    const domain = "'https://api." + DOMAIN + "'";
    const file = fixture(
      'ai-backend-skill-registry.js',
      `function getEndpoint() { return process.env.KHY_CLOUD_ENDPOINT || ${domain}; }\n`,
    );
    const { status, stdout } = runGate(file);
    assert.equal(status, 1, 'env-fallback does not exempt a non-SoT business file');
    assert.match(stdout, /\[ERROR\] no-hardcoded-prod-domain/);
    assert.match(stdout, /ai-backend-skill-registry\.js/);
  });

  test('a non-SoT file importing the endpoint from serviceDefaults passes', () => {
    // The correct fix: import from constants/serviceDefaults instead of hardcoding.
    const file = fixture(
      'ai-backend-uses-sot.js',
      "const { CLOUD_DEFAULT_ENDPOINT } = require('../constants/serviceDefaults');\n"
        + 'function getEndpoint() { return CLOUD_DEFAULT_ENDPOINT; }\n',
    );
    const { status, stdout } = runGate(file);
    assert.equal(status, 0, 'importing the SoT carries no domain literal to flag');
    assert.doesNotMatch(stdout, /no-hardcoded-prod-domain/);
  });

  test('allows the domain inside ${} template interpolation', () => {
    const file = fixture(
      'interp.js',
      'const host = base;\nconst url = `https://${host}/v1`; // host derived from config\n',
    );
    const { status, stdout } = runGate(file);
    assert.equal(status, 0);
    assert.doesNotMatch(stdout, /no-hardcoded-prod-domain/);
  });

  test('allows branding / official-site mentions in user-facing help text', () => {
    const file = fixture('branding.js', `const help = '官网: https://${DOMAIN}';\n`);
    const { status, stdout } = runGate(file);
    assert.equal(status, 0, 'branding/官网 text is not a runtime endpoint');
    assert.doesNotMatch(stdout, /no-hardcoded-prod-domain/);
  });

  test('exempts serviceDefaults.js — it is the single source of truth', () => {
    const dir = path.join(tmpDir, 'constants');
    fs.mkdirSync(dir, { recursive: true });
    const sot = path.join(dir, 'serviceDefaults.js');
    fs.writeFileSync(sot, `const CLOUD = 'https://api.${DOMAIN}';\nmodule.exports = { CLOUD };\n`);
    const { status, stdout } = runGate(sot);
    assert.equal(status, 0, 'the source of truth owns the literal');
    assert.doesNotMatch(stdout, /no-hardcoded-prod-domain/);
  });

  test('exempts the gate script itself (it names the domain by design)', () => {
    const { stdout } = runGate('scripts/check-agent-rules.js');
    assert.doesNotMatch(stdout, /no-hardcoded-prod-domain/);
  });

  test('does not flag the domain inside an email address (a contact, not a host)', () => {
    const email = 'admin@' + DOMAIN.replace('.top', '.com');
    const file = fixture('seed-user.js', `const admin = { email: '${email}', role: 'admin' };\n`);
    const { status, stdout } = runGate(file);
    assert.equal(status, 0, 'a contact email is not a network endpoint');
    assert.doesNotMatch(stdout, /no-hardcoded-prod-domain/);
  });

  test('still flags a real endpoint even when an email with the same domain is nearby', () => {
    const url = 'https://api.' + DOMAIN;
    const email = 'ops@' + DOMAIN.replace('.top', '.com');
    const file = fixture(
      'mixed.js',
      `const contact = '${email}';\nconst endpoint = '${url}';\n`,
    );
    const { status, stdout } = runGate(file);
    assert.equal(status, 1, 'an http endpoint is still a hardcode regardless of a nearby email');
    assert.match(stdout, /\[ERROR\] no-hardcoded-prod-domain/);
  });
});

describe('check-agent-rules Rule 1 — help-text & test-file exemptions', () => {
  // Localhost URLs are assembled at runtime so THIS source file holds no
  // contiguous flaggable token (CI runs the gate over scripts/, this file
  // included).
  const LOCAL = 'http://127.0.0.1:' + '7860';
  const PROXY = 'http://127.0.0.1:' + '7890';

  test('allows Chinese "如 <url>" example phrasing in help text', () => {
    const file = fixture('cn-example.js', `const help = '本地 SD (如 ${LOCAL})';\n`);
    const { status, stdout } = runGate(file);
    assert.equal(status, 0, '如 <url> is example phrasing, not a runtime endpoint');
    assert.doesNotMatch(stdout, /no-hardcoded-endpoint/);
  });

  test('allows export/set proxy-config guidance lines', () => {
    const file = fixture(
      'proxy-help.js',
      `printInfo('设代理后重试: export HTTPS_PROXY=${PROXY}');\n`
      + `printInfo('Windows: set HTTPS_PROXY=${PROXY}');\n`,
    );
    const { status, stdout } = runGate(file);
    assert.equal(status, 0, 'proxy-config instructions are guidance, not a runtime fork');
    assert.doesNotMatch(stdout, /no-hardcoded-endpoint/);
  });

  test('exempts test files that PIN the canonical endpoint (a guard, not a fork)', () => {
    const pin = "expect(sd.AI_BACKEND_DEFAULT_URL).toBe('http://localhost:" + "9090');";
    const file = fixture('serviceDefaults.test.js', `test('pins SoT', () => {\n  ${pin}\n});\n`);
    const { status, stdout } = runGate(file);
    assert.equal(status, 0, 'a test asserting the canonical value is the opposite of a hidden hardcode');
    assert.doesNotMatch(stdout, /no-hardcoded-endpoint/);
  });

  test('still flags a real hardcoded endpoint in a non-test source file', () => {
    const bad = 'http://localhost:' + '5544';
    const file = fixture('runtime.js', `const url = '${bad}/api';\nfetch(url);\n`);
    const { status, stdout } = runGate(file);
    assert.equal(status, 1, 'genuine runtime hardcodes must still fail');
    assert.match(stdout, /\[ERROR\] no-hardcoded-endpoint/);
  });

  test('exempts test-file setTimeout fixtures from the timeout rule (even under --strict-warnings)', () => {
    const file = fixture(
      'delay.test.js',
      "test('late resolve', async () => {\n  await new Promise(res => setTimeout(() => res('late'), 800));\n});\n",
    );
    const { status, stdout } = runGate('--strict-warnings', file);
    assert.equal(status, 0, 'a test fixture simulating a delay is not a production hard-kill');
    assert.doesNotMatch(stdout, /timeout-needs-progress-awareness/);
  });
});
