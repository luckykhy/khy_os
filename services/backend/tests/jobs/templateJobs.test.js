'use strict';

/**
 * templateJobs — `/job` template-jobs vertical slice (CC `/job` alignment).
 *
 * Covers the two data leaves (jobTemplates discovery/frontmatter + jobStore
 * create/read/reply/list) and the handler gate. All fs is injected against a
 * temp dir so nothing touches the real ~/.khy.
 *
 * node:test (jest via rtk reports "Exec format error" and is unusable here).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const templatesApi = require('../../src/jobs/jobTemplates');
const store = require('../../src/jobs/jobStore');
const { templateJobsEnabled } = require('../../src/cli/handlers/job');

function tmpDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `khy-job-${label}-`));
}

// ── jobTemplates: frontmatter parsing ──────────────────────────────────────
test('parseFrontmatter: well-formed block → frontmatter + content', () => {
  const { frontmatter, content } = templatesApi.parseFrontmatter(
    '---\ndescription: A test template\nname: foo\n---\n# Body\nhello',
  );
  assert.strictEqual(frontmatter.description, 'A test template');
  assert.strictEqual(frontmatter.name, 'foo');
  assert.match(content, /# Body/);
});

test('parseFrontmatter: no block → empty frontmatter, raw content', () => {
  const { frontmatter, content } = templatesApi.parseFrontmatter('just text');
  assert.deepStrictEqual(frontmatter, {});
  assert.strictEqual(content, 'just text');
});

test('parseFrontmatter: quoted values are unquoted', () => {
  const { frontmatter } = templatesApi.parseFrontmatter('---\ndescription: "quoted"\n---\nx');
  assert.strictEqual(frontmatter.description, 'quoted');
});

// ── jobTemplates: discovery ────────────────────────────────────────────────
test('listTemplates: discovers .md files, prefers earlier dirs on collision', () => {
  const projectDir = tmpDir('proj');
  const userDir = tmpDir('user');
  fs.writeFileSync(path.join(projectDir, 'deploy.md'), '---\ndescription: project deploy\n---\nsteps');
  fs.writeFileSync(path.join(userDir, 'deploy.md'), '---\ndescription: user deploy\n---\nsteps');
  fs.writeFileSync(path.join(userDir, 'review.md'), '# Review\ncontent');
  fs.writeFileSync(path.join(userDir, 'ignore.txt'), 'not a template');

  const list = templatesApi.listTemplates({ dirs: [projectDir, userDir] });
  const byName = Object.fromEntries(list.map((t) => [t.name, t]));
  assert.strictEqual(list.length, 2, 'only .md, deduped by name');
  assert.strictEqual(byName.deploy.description, 'project deploy', 'project dir wins');
  assert.strictEqual(byName.review.description, 'Review', 'falls back to first heading');
});

test('listTemplates: missing dir is skipped (fail-soft), returns []', () => {
  const list = templatesApi.listTemplates({ dirs: [path.join(os.tmpdir(), 'khy-does-not-exist-xyz')] });
  assert.deepStrictEqual(list, []);
});

test('loadTemplate: found vs not found', () => {
  const dir = tmpDir('load');
  fs.writeFileSync(path.join(dir, 'foo.md'), '---\ndescription: d\n---\nbody');
  assert.strictEqual(templatesApi.loadTemplate('foo', { dirs: [dir] }).name, 'foo');
  assert.strictEqual(templatesApi.loadTemplate('nope', { dirs: [dir] }), null);
});

// ── jobStore: create / read / reply / list roundtrip ───────────────────────
test('jobStore: createJob writes state+template+input, readJobState roundtrips', () => {
  const base = tmpDir('store');
  const dir = store.createJob('abc123', 'deploy', '---\n---\nbody', 'do the thing', ['x', 'y'], {
    baseDir: base, now: '2026-07-02T00:00:00.000Z',
  });
  assert.ok(fs.existsSync(path.join(dir, 'state.json')));
  assert.ok(fs.existsSync(path.join(dir, 'template.md')));
  assert.strictEqual(fs.readFileSync(path.join(dir, 'input.txt'), 'utf8'), 'do the thing');

  const st = store.readJobState('abc123', { baseDir: base });
  assert.strictEqual(st.jobId, 'abc123');
  assert.strictEqual(st.templateName, 'deploy');
  assert.strictEqual(st.status, 'created');
  assert.deepStrictEqual(st.args, ['x', 'y']);
});

test('jobStore: readJobState on missing job → null', () => {
  const base = tmpDir('missing');
  assert.strictEqual(store.readJobState('nope', { baseDir: base }), null);
});

test('jobStore: appendJobReply writes jsonl + bumps updatedAt; false for missing job', () => {
  const base = tmpDir('reply');
  store.createJob('j1', 'tpl', 'c', 'i', [], { baseDir: base, now: '2026-07-02T00:00:00.000Z' });

  const ok = store.appendJobReply('j1', 'first reply', { baseDir: base, now: '2026-07-02T01:00:00.000Z' });
  assert.strictEqual(ok, true);
  const replies = fs.readFileSync(path.join(store.getJobDir('j1', { baseDir: base }), 'replies.jsonl'), 'utf8')
    .trim().split('\n').map((l) => JSON.parse(l));
  assert.strictEqual(replies.length, 1);
  assert.strictEqual(replies[0].text, 'first reply');
  assert.strictEqual(store.readJobState('j1', { baseDir: base }).updatedAt, '2026-07-02T01:00:00.000Z');

  assert.strictEqual(store.appendJobReply('ghost', 'x', { baseDir: base }), false);
});

test('jobStore: listJobs returns created jobs newest-first', () => {
  const base = tmpDir('list');
  store.createJob('old', 't', 'c', 'i', [], { baseDir: base, now: '2026-07-01T00:00:00.000Z' });
  store.createJob('new', 't', 'c', 'i', [], { baseDir: base, now: '2026-07-02T00:00:00.000Z' });
  const ids = store.listJobs({ baseDir: base }).map((j) => j.jobId);
  assert.deepStrictEqual(ids, ['new', 'old']);
});

test('jobStore: listJobs on empty/missing base → []', () => {
  assert.deepStrictEqual(store.listJobs({ baseDir: path.join(os.tmpdir(), 'khy-empty-jobs-xyz') }), []);
});

// ── handler gate ───────────────────────────────────────────────────────────
test('templateJobsEnabled: default on, off-words disable', () => {
  assert.strictEqual(templateJobsEnabled({}), true);
  assert.strictEqual(templateJobsEnabled({ KHY_TEMPLATE_JOBS: 'on' }), true);
  for (const off of ['0', 'false', 'off', 'no', 'disable', 'disabled', 'OFF', ' False ']) {
    assert.strictEqual(templateJobsEnabled({ KHY_TEMPLATE_JOBS: off }), false, off);
  }
});
