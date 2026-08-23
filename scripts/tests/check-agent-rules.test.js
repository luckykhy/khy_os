'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const scriptPath = path.join(ROOT, 'scripts', 'ci', 'check-agent-rules.js');
const GATE_REL = path.relative(ROOT, scriptPath);

// Build ESC-related fixture content WITHOUT writing a literal "\x1b" token in
// this source file — the editing/tooling layer rewrites that token into a raw
// ESC byte unpredictably. Concatenation and char codes keep the bytes exact.
const ESC = String.fromCharCode(27); // raw ESC byte (0x1b)
const BS = '\\'; // a single backslash character
const TEXT_X1B = BS + 'x1b'; // the four-character source text:  backslash x 1 b
const TEXT_U001B = BS + 'u001b'; // the source text:  backslash u 0 0 1 b

let tmpDir;

// Invoke the gate through argv, with no shell. The previous implementation forced
// `shell: '/bin/bash'` and redirected output with `>`, which is ENOENT on this
// repo's primary platform (win32) — every assertion in this file failed for that
// environmental reason alone, so the suite could not have caught any regression.
function runGate(...targets) {
  const res = spawnSync(process.execPath, [scriptPath, ...targets], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  return {
    status: res.status === null ? 1 : res.status,
    stdout: `${res.stdout || ''}${res.stderr || ''}`,
  };
}

function fixture(name, content) {
  const full = path.join(tmpDir, name);
  fs.mkdirSync(path.dirname(full), { recursive: true });
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
    const { stdout } = runGate(GATE_REL);
    // Assert the gate actually opened the file. This target used to be the
    // pre-reorg 'scripts/check-agent-rules.js', which no longer exists: the gate
    // printed "No target files found" and the doesNotMatch below passed without
    // ever exercising the exemption.
    assert.match(stdout, /1 file\(s\) scanned/, 'the gate must really scan itself');
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

describe('check-agent-rules Rule 1c — absolute-path exemptions', () => {
  test('allows a documented known-installation candidate', () => {
    const file = fixture(
      'known-installation.js',
      "const candidate = 'C:" + "\\\\Program Files\\\\Tool'; // khy-allow-abs-path: known installation candidate\n",
    );
    const { status, stdout } = runGate(file);
    assert.equal(status, 0);
    assert.doesNotMatch(stdout, /no-hardcoded-abs-path/);
  });

  test('rejects an exemption without a reason', () => {
    const file = fixture(
      'empty-exemption.js',
      "const candidate = 'C:" + "\\\\Program Files\\\\Tool'; // khy-allow-abs-path:    \n",
    );
    const { status, stdout } = runGate(file);
    assert.equal(status, 1);
    assert.match(stdout, /Absolute-path exemption requires a non-empty reason/);
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
    const { stdout } = runGate(GATE_REL);
    assert.match(stdout, /1 file\(s\) scanned/, 'the gate must really scan itself');
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

  test('allows concatenation with a variable port (nothing is pinned)', () => {
    const file = fixture(
      'concat-dynamic.js',
      "const url = 'http://localhost:' + resolvePort();\nmodule.exports = { url };\n",
    );
    const { status, stdout } = runGate(file);
    assert.equal(status, 0);
    assert.doesNotMatch(stdout, /no-hardcoded-endpoint/);
  });

  test('flags a quoted numeric port fallback behind the concatenation bypass', () => {
    // `'http://localhost:' + (process.env.PORT || '3000')` reads as dynamic but
    // re-pins the default port outside serviceDefaults, so the backend default and
    // this copy drift the day it moves. The bypass used to swallow the whole line
    // (and was duplicated verbatim), which let the real plugin-dev.js scaffold
    // hardcode through the gate.
    const line = "const t = 'http://localhost:' + (process.env.PORT || '" + '3000' + "');";
    const file = fixture('concat-pinned.js', `${line}\n`);
    const { status, stdout } = runGate(file);
    assert.equal(status, 1, 'an env fallback does not exempt a pinned port literal');
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

describe('check-agent-rules Rule 3 — termination-effect gating', () => {
  test('flags a fixed-duration kill made through a wrapper (safeKill) as an error', () => {
    // `safeKill(child)` ends the process exactly as `child.kill()` does. The old
    // signal test matched only `.kill(`, so five real fixed-timeout child-process
    // kills in comprehensiveDataService.js were reported as low-severity warnings.
    const file = fixture(
      'wrapper-kill.js',
      'function sync() {\n'
      + "  const python = spawn('python', ['sync.py']);\n"
      + '  setTimeout(() => { safeKill(python); }, 10000);\n'
      + '  return python;\n}\n',
    );
    const { status, stdout } = runGate(file);
    assert.equal(status, 1, 'a wrapper kill on a fixed deadline must fail the gate');
    assert.match(stdout, /\[ERROR\] no-hard-timeout-kill/);
  });

  test('still flags a direct .kill() on a fixed deadline', () => {
    const file = fixture(
      'direct-kill.js',
      'function sync(child) {\n  setTimeout(() => { child.kill(); }, 30000);\n}\n',
    );
    const { status, stdout } = runGate(file);
    assert.equal(status, 1);
    assert.match(stdout, /\[ERROR\] no-hard-timeout-kill/);
  });

  test('clears a wrapper kill that an idle-reset helper re-arms on activity', () => {
    // The compliant shape: the deadline is re-armed from the child's stream
    // handlers, so activity extends it. The reset helper sits outside the 220-char
    // timer expression, and the warning path used to consult only that snippet.
    const file = fixture(
      'idle-ok.js',
      'function sync() {\n'
      + "  const python = spawn('python', ['sync.py']);\n"
      + '  let _idleTimer = null;\n'
      + '  const _resetIdle = () => {\n'
      + '    if (_idleTimer) clearTimeout(_idleTimer);\n'
      + '    _idleTimer = setTimeout(() => { safeKill(python); }, 10000);\n'
      + '  };\n'
      + '  _resetIdle();\n'
      + "  python.stdout.on('data', () => { _resetIdle(); });\n}\n",
    );
    const { status, stdout } = runGate('--strict-warnings', file);
    assert.equal(status, 0, 'an activity-reset idle timeout is the required pattern, not a violation');
    assert.doesNotMatch(stdout, /no-hard-timeout-kill|timeout-needs-progress-awareness/);
  });

  test('ignores timers with no termination effect (drain retry, UI linger)', () => {
    // Neither timer kills, aborts, rejects, or fails anything — they are
    // schedulers, so there is no deadline to slide and nothing to renew against.
    const file = fixture(
      'schedulers.js',
      'let flushTimer = null;\n'
      + 'const flush = () => {\n'
      + '  flushTimer = null;\n'
      + '  if (pending.length > 0) flushTimer = setTimeout(flush, 500);\n'
      + '};\n'
      + 'function linger(panelState) {\n'
      + '  setTimeout(() => { panelState.clearTasks(); }, 1500);\n'
      + '}\n',
    );
    const { status, stdout } = runGate('--strict-warnings', file);
    assert.equal(status, 0, 'a scheduled callback is not a timeout');
    assert.doesNotMatch(stdout, /timeout-needs-progress-awareness/);
  });

  test('exempts a reject-only Promise.race deadline on a single bounded call', () => {
    // A one-shot RPC has no activity stream to slide against. The gate already
    // intended this exemption, but isRejectOnly sat after the no-kill branch's
    // warn-and-continue, so it was unreachable and every such deadline warned.
    const file = fixture(
      'race-deadline.js',
      'async function reg(auth, u, p) {\n'
      + "  const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('注册超时')), 10000));\n"
      + '  return Promise.race([auth.register(u, p), timeoutPromise]);\n}\n',
    );
    const { status, stdout } = runGate('--strict-warnings', file);
    assert.equal(status, 0, 'a bounded single-call deadline is not a task-loop hard-kill');
    assert.doesNotMatch(stdout, /timeout-needs-progress-awareness/);
  });
});

describe('check-agent-rules — scan scope', () => {
  const BAD_LOCAL = 'https://localhost:' + '3128' + '/';

  test('prunes vendored third-party trees (virtualenv / site-packages)', () => {
    // Library docstrings are not this repo's code and cannot be refactored. One
    // unignored virtualenv produced 30 endpoint errors and pinned the gate red,
    // which hides every real finding behind unactionable noise.
    fixture('scope-venv/.venv/Lib/site-packages/poolmanager.py', `proxy = ProxyManager("${BAD_LOCAL}")\n`);
    fixture('scope-venv/app.py', 'PORT = os.getenv("PORT")\n');
    const { status, stdout } = runGate(path.join(tmpDir, 'scope-venv'));
    assert.equal(status, 0, 'third-party trees must not fail this repo\'s gate');
    assert.doesNotMatch(stdout, /no-hardcoded-endpoint/);
    assert.match(stdout, /1 file\(s\) scanned/, 'the first-party file is still scanned');
  });

  test('skips a nested repository and reports the skip', () => {
    // `git diff --name-only` reports a changed submodule as ONE directory path;
    // recursing into it walked the submodule's own untracked dependencies.
    fixture('scope-nested/child/.git/HEAD', 'ref: refs/heads/main\n');
    fixture('scope-nested/child/vendored.js', `const url = '${BAD_LOCAL}';\n`);
    fixture('scope-nested/ours.js', 'const port = process.env.PORT;\n');
    const { status, stdout } = runGate(path.join(tmpDir, 'scope-nested'));
    assert.equal(status, 0, 'a nested repo is governed by its own gates');
    assert.doesNotMatch(stdout, /no-hardcoded-endpoint/);
    assert.match(stdout, /\[SKIP \].*child/, 'dropped coverage must be stated, not silent');
  });

  test('an explicit target that resolves to nothing fails instead of reading as a pass', () => {
    const missing = path.join(tmpDir, 'does-not-exist.js');
    const { status, stdout } = runGate(missing);
    assert.equal(status, 1, 'a named target that cannot be scanned proves nothing');
    assert.match(stdout, /\[SKIP \] missing path/);
  });

  test('--changed scans non-ASCII (Chinese) paths', () => {
    // git renders non-ASCII paths as double-quoted octal escapes unless
    // core.quotePath=false. Those never resolve on disk, so every Chinese-named
    // file in this repo was silently dropped while the gate reported a clean pass.
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-gate-cn-'));
    try {
      const git = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' });
      git('init', '-q');
      git('config', 'user.email', 'gate@example.com');
      git('config', 'user.name', 'Gate Test');
      fs.writeFileSync(path.join(repo, 'seed.txt'), 'seed\n');
      git('add', '.');
      git('commit', '-qm', 'seed');

      const bad = 'http://localhost:' + '9443';
      fs.writeFileSync(path.join(repo, '配置.js'), `const url = '${bad}';\n`);
      git('add', '.');

      const res = spawnSync(process.execPath, [scriptPath, '--changed'], {
        cwd: repo,
        encoding: 'utf8',
      });
      const stdout = `${res.stdout || ''}${res.stderr || ''}`;
      assert.equal(res.status, 1, 'a violation in a Chinese-named file must fail the gate');
      assert.match(stdout, /\[ERROR\] no-hardcoded-endpoint/);
      assert.doesNotMatch(stdout, /\[SKIP \] missing path/, 'the path must resolve, not be dropped');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
