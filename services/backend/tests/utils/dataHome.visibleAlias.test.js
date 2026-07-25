/**
 * Unit tests for the visible alias beside the dotted project data home.
 *
 * getProjectDataHome() resolves to <root>/.khy (hidden). A non-hidden
 * `khy-Trajectory` symlink is regenerated on every startup so the trajectory/memory
 * directory is visible without renaming `.khy`. The alias must:
 *   - be created pointing at the real `.khy` dir
 *   - be visible (name does not start with a dot)
 *   - never clobber a real directory that already occupies that name
 *   - never throw, even if the link cannot be created
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

function freshTmpRoot(label) {
  const root = path.join(os.tmpdir(), `khy-alias-${label}-${process.pid}-${Math.floor(process.hrtime()[1])}`);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

describe('dataHome — visible khy-Trajectory alias', () => {
  const OLD_ENV = { ...process.env };
  const created = [];

  afterEach(() => {
    process.env = { ...OLD_ENV };
    jest.resetModules();
    for (const dir of created.splice(0)) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  test('creates a visible khy-Trajectory symlink pointing at the .khy data home', () => {
    const root = freshTmpRoot('mk'); created.push(root);
    process.env.KHY_PROJECT_DATA_HOME = path.join(root, '.khy');
    jest.resetModules();
    const d = require('../../src/utils/dataHome');

    const home = d.getProjectDataHome();
    const alias = path.join(root, 'khy-Trajectory');

    expect(fs.existsSync(home)).toBe(true);
    const ls = fs.lstatSync(alias);
    expect(ls.isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(alias)).toBe(fs.realpathSync(home));
  });

  test('alias name is non-hidden (does not start with a dot)', () => {
    const root = freshTmpRoot('vis'); created.push(root);
    process.env.KHY_PROJECT_DATA_HOME = path.join(root, '.khy');
    jest.resetModules();
    require('../../src/utils/dataHome').getProjectDataHome();

    const entries = fs.readdirSync(root);
    expect(entries).toContain('khy-Trajectory');
    expect(entries.some((e) => e === '.khy')).toBe(true);
    expect('khy-Trajectory'.startsWith('.')).toBe(false);
  });

  test('does not clobber a real directory already named khy-Trajectory', () => {
    const root = freshTmpRoot('clobber'); created.push(root);
    const realAlias = path.join(root, 'khy-Trajectory');
    fs.mkdirSync(realAlias, { recursive: true });
    const sentinel = path.join(realAlias, 'user-file.txt');
    fs.writeFileSync(sentinel, 'keep me');

    process.env.KHY_PROJECT_DATA_HOME = path.join(root, '.khy');
    jest.resetModules();
    require('../../src/utils/dataHome').getProjectDataHome();

    expect(fs.lstatSync(realAlias).isDirectory()).toBe(true);
    expect(fs.existsSync(sentinel)).toBe(true);
  });

  test('does not throw when alias creation is impossible', () => {
    const root = freshTmpRoot('throw'); created.push(root);
    // Occupy the alias name with a plain file so symlink creation would EEXIST.
    fs.writeFileSync(path.join(root, 'khy-Trajectory'), 'x');
    process.env.KHY_PROJECT_DATA_HOME = path.join(root, '.khy');
    jest.resetModules();
    const d = require('../../src/utils/dataHome');
    expect(() => d.getProjectDataHome()).not.toThrow();
  });
});
