/**
 * Coze gallery — enumerate + bounded session cache + on-demand install.
 *
 * Proves the "按需安装画廊" backend: a Coze collection is enumerated into a
 * userId-scoped, bounded, TTL-swept session WITHOUT persisting, and individual
 * entries are installed later by { sessionId, index }.
 *
 * Reuses the existing coze fixtures (test/fixtures/coze). To prove multi-entry
 * enumeration of a NESTED collection without adding a zip-writer dependency, we
 * build a tiny STORED (uncompressed) outer zip by hand — manual CRC32 + the
 * local/central/EOCD records — wrapping two copies of the real Workflow-*.zip.
 * walkZip recurses into each inner deflate zip, yielding two leaf containers.
 *
 * Mirrors workflow.cozeImport.test.js: a throwaway on-disk SQLite DB is bound to
 * the shared sequelize singleton BEFORE any @khy/shared model is required, and
 * the session cap is shrunk via env BEFORE the service is required (the cap is a
 * module-load-time const).
 */
'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP_DB = path.join(os.tmpdir(), `khy-coze-gallery-${process.pid}.db`);
process.env.DB_TYPE = 'sqlite';
process.env.SQLITE_DB_PATH = TMP_DB;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-coze-gallery';
process.env.NODE_ENV = 'test';
// Shrink the bounded session cache so eviction is observable with few inserts.
process.env.KHY_COZE_SESSION_MAX = '3';
// Point the built-in catalog at an empty temp dir so the "graceful empty" path
// is deterministic regardless of the developer's home directory.
const EMPTY_CATALOG = path.join(os.tmpdir(), `khy-coze-catalog-empty-${process.pid}`);
fs.mkdirSync(EMPTY_CATALOG, { recursive: true });
process.env.KHY_COZE_CATALOG_DIR = EMPTY_CATALOG;

const { sequelize, User, UserWorkflow } = require('@khy/shared/models');
const cozeImport = require('../src/services/cozeImportService');
const workflowService = require('../src/services/workflowService');

const FX = path.join(__dirname, 'fixtures', 'coze');
const tableJson = fs.readFileSync(path.join(FX, 'sample-table.json'));
const linearZip = fs.readFileSync(path.join(FX, 'sample-linear.zip'));

// ── Minimal STORED zip writer (no compression, manual CRC32) ──────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Build a STORED (method 0) zip from [{ name, data }].
function makeStoredZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const data = f.data;
    const crc = crc32(data);

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0); // local file header signature
    lfh.writeUInt16LE(20, 4);          // version needed
    lfh.writeUInt16LE(0, 6);           // flags
    lfh.writeUInt16LE(0, 8);           // method: stored
    lfh.writeUInt16LE(0, 10);          // mod time
    lfh.writeUInt16LE(0, 12);          // mod date
    lfh.writeUInt32LE(crc, 14);        // crc32
    lfh.writeUInt32LE(data.length, 18); // compressed size
    lfh.writeUInt32LE(data.length, 22); // uncompressed size
    lfh.writeUInt16LE(name.length, 26); // filename length
    lfh.writeUInt16LE(0, 28);          // extra length
    locals.push(lfh, name, data);

    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);  // central dir signature
    cdh.writeUInt16LE(20, 4);          // version made by
    cdh.writeUInt16LE(20, 6);          // version needed
    cdh.writeUInt16LE(0, 8);           // flags
    cdh.writeUInt16LE(0, 10);          // method
    cdh.writeUInt16LE(0, 12);          // mod time
    cdh.writeUInt16LE(0, 14);          // mod date
    cdh.writeUInt32LE(crc, 16);        // crc32
    cdh.writeUInt32LE(data.length, 20); // compressed size
    cdh.writeUInt32LE(data.length, 24); // uncompressed size
    cdh.writeUInt16LE(name.length, 28); // filename length
    cdh.writeUInt16LE(0, 30);          // extra length
    cdh.writeUInt16LE(0, 32);          // comment length
    cdh.writeUInt16LE(0, 34);          // disk number start
    cdh.writeUInt16LE(0, 36);          // internal attrs
    cdh.writeUInt32LE(0, 38);          // external attrs
    cdh.writeUInt32LE(offset, 42);     // local header offset
    centrals.push(cdh, name);

    offset += lfh.length + name.length + data.length;
  }

  const localPart = Buffer.concat(locals);
  const centralPart = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // EOCD signature
  eocd.writeUInt16LE(0, 4);          // disk number
  eocd.writeUInt16LE(0, 6);          // disk with central dir
  eocd.writeUInt16LE(files.length, 8);  // entries on this disk
  eocd.writeUInt16LE(files.length, 10); // total entries
  eocd.writeUInt32LE(centralPart.length, 12); // central dir size
  eocd.writeUInt32LE(localPart.length, 16);   // central dir offset
  eocd.writeUInt16LE(0, 20);         // comment length
  return Buffer.concat([localPart, centralPart, eocd]);
}

beforeAll(async () => {
  await sequelize.sync({ force: true });
});

afterAll(async () => {
  await sequelize.close();
  try { fs.unlinkSync(TMP_DB); } catch { /* ignore */ }
  try { fs.rmSync(EMPTY_CATALOG, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('coze gallery — STORED zip writer self-check', () => {
  test('round-trips through node-stream-zip (proves the hand-built zip is valid)', async () => {
    const buf = makeStoredZip([{ name: 'hello.txt', data: Buffer.from('hi there') }]);
    const StreamZip = require('node-stream-zip');
    const tmp = path.join(os.tmpdir(), `khy-coze-selfcheck-${process.pid}.zip`);
    fs.writeFileSync(tmp, buf);
    const zip = new StreamZip.async({ file: tmp });
    try {
      const names = Object.keys(await zip.entries());
      expect(names).toContain('hello.txt');
      const data = await zip.entryData('hello.txt');
      expect(data.toString('utf8')).toBe('hi there');
    } finally {
      await zip.close();
      fs.unlinkSync(tmp);
    }
  });
});

describe('coze gallery — enumerateBuffer', () => {
  test('non-zip content enumerates as a single entry', async () => {
    const { entries, skipped } = await cozeImport.enumerateBuffer(tableJson, {});
    expect(entries.length).toBe(1);
    expect(skipped.length).toBe(0);
    expect(entries[0].report.source).toBe('coze');
    expect(entries[0].graph.nodes.length).toBe(13);
  });

  test('a nested collection zip enumerates EVERY leaf workflow', async () => {
    // outer (STORED) → two inner Workflow-*.zip (real deflate) → 2 leaf containers.
    const outer = makeStoredZip([
      { name: 'Workflow-aaa.zip', data: linearZip },
      { name: 'Workflow-bbb.zip', data: linearZip },
    ]);
    const { entries, skipped } = await cozeImport.enumerateBuffer(outer, {});
    expect(entries.length).toBe(2);
    expect(skipped.length).toBe(0);
    for (const e of entries) {
      expect(e.report.source).toBe('coze');
      expect(e.graph.nodes.length).toBe(6);
      expect(typeof e.entryPath).toBe('string');
      expect(e.entryPath).toMatch(/Workflow-(aaa|bbb)\.zip/);
    }
  });

  test('a leaf that fails conversion is recorded in skipped, not fatal', async () => {
    const outer = makeStoredZip([
      { name: 'Workflow-good.zip', data: linearZip },
      { name: 'junk.bin', data: Buffer.from('definitely not a coze container') },
    ]);
    const { entries, skipped } = await cozeImport.enumerateBuffer(outer, {});
    expect(entries.length).toBe(1);
    expect(skipped.length).toBe(1);
    expect(skipped[0].entryPath).toContain('junk.bin');
  });
});

describe('coze gallery — session cache (bounded + TTL + ownership)', () => {
  test('enumerateToSession caches without persisting and exposes a preview catalog', async () => {
    const out = await cozeImport.enumerateToSession({ content: tableJson.toString('utf8') }, { userId: 7 });
    expect(out.sessionId).toBeTruthy();
    expect(out.total).toBe(1);
    expect(out.entries[0].index).toBe(0);
    expect(out.entries[0].nodeCount).toBe(13);
    expect(out.entries[0].report.source).toBe('coze');
    // No graph leaks into the lightweight catalog — only the report.
    expect(out.entries[0].graph).toBeUndefined();
  });

  test('getSessionGraph returns the converted graph; bad index → 400', async () => {
    const out = await cozeImport.enumerateToSession({ content: tableJson.toString('utf8') }, { userId: 7 });
    const { graph, report } = cozeImport.getSessionGraph(out.sessionId, 7, 0);
    expect(graph.nodes.length).toBe(13);
    expect(report.source).toBe('coze');
    expect(() => cozeImport.getSessionGraph(out.sessionId, 7, 5))
      .toThrow(/Invalid entry index/);
  });

  test('a session is not readable by a different user → 403', async () => {
    const out = await cozeImport.enumerateToSession({ content: tableJson.toString('utf8') }, { userId: 7 });
    let caught;
    try { cozeImport.getSessionGraph(out.sessionId, 99, 0); } catch (e) { caught = e; }
    expect(caught).toBeTruthy();
    expect(caught.statusCode).toBe(403);
  });

  test('unknown session → 404', () => {
    let caught;
    try { cozeImport.getSessionGraph('deadbeefdeadbeefdeadbeef', 7, 0); } catch (e) { caught = e; }
    expect(caught).toBeTruthy();
    expect(caught.statusCode).toBe(404);
  });

  test('the cache is bounded: exceeding KHY_COZE_SESSION_MAX evicts the oldest', async () => {
    cozeImport._sessions.clear();
    const ids = [];
    for (let i = 0; i < 5; i++) {
      // eslint-disable-next-line no-await-in-loop
      const out = await cozeImport.enumerateToSession({ content: tableJson.toString('utf8') }, { userId: 1 });
      ids.push(out.sessionId);
      // Force a strictly increasing createdAt so "oldest" is unambiguous.
      cozeImport._sessions.get(out.sessionId).createdAt = i;
    }
    // Cap is 3 → only the last 3 survive; the first 2 were evicted.
    expect(cozeImport._sessions.size).toBeLessThanOrEqual(3);
    expect(cozeImport._sessions.has(ids[0])).toBe(false);
    expect(cozeImport._sessions.has(ids[4])).toBe(true);
    // Evicted session's temp file is gone → reading it 404s.
    expect(() => cozeImport.getSessionGraph(ids[0], 1, 0)).toThrow();
  });

  test('TTL sweep removes expired sessions and unlinks their temp files', async () => {
    cozeImport._sessions.clear();
    const out = await cozeImport.enumerateToSession({ content: tableJson.toString('utf8') }, { userId: 1 });
    const meta = cozeImport._sessions.get(out.sessionId);
    const filePath = meta.filePath;
    expect(fs.existsSync(filePath)).toBe(true);
    meta.createdAt = 0; // far in the past → older than any TTL cutoff
    cozeImport._sweep();
    // Map removal is synchronous; the temp-file unlink is async fire-and-forget,
    // so poll briefly for the file to disappear.
    expect(cozeImport._sessions.has(out.sessionId)).toBe(false);
    for (let i = 0; i < 50 && fs.existsSync(filePath); i++) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(fs.existsSync(filePath)).toBe(false);
  });
});

describe('coze gallery — built-in catalog graceful empty', () => {
  test('an empty/missing catalog dir degrades to an empty catalog (no throw)', async () => {
    const out = await cozeImport.enumerateBuiltin({ userId: 1 });
    expect(out.total).toBe(0);
    expect(out.entries).toEqual([]);
    expect(out.builtin).toBe(false);
    expect(out.sessionId).toBeNull();
  });
});

describe('coze gallery — installCozeEntry persists a per-user workflow', () => {
  test('install by { sessionId, index } creates a row whose graph matches the preview', async () => {
    const user = await User.create({
      username: 'gallery-bob', email: 'gallery-bob@test.local', password: 'pw-bob-123', status: 'active',
    });
    const before = await UserWorkflow.count({ where: { userId: user.id } });

    const session = await workflowService.enumerateCoze(user.id, { content: tableJson.toString('utf8') });
    const { graph: previewGraph } = cozeImport.getSessionGraph(session.sessionId, user.id, 0);

    const created = await workflowService.installCozeEntry(user.id, {
      sessionId: session.sessionId,
      index: 0,
    });
    expect(created.id).toBeTruthy();
    expect(created.version).toBe(1);
    expect(created.report.source).toBe('coze');
    expect(created.graph.nodes.length).toBe(previewGraph.nodes.length);

    const after = await UserWorkflow.count({ where: { userId: user.id } });
    expect(after).toBe(before + 1);

    // Round-trips on reload through the service.
    const reloaded = await workflowService.get(user.id, created.id);
    expect(reloaded.graph.nodes.length).toBe(previewGraph.nodes.length);
  });

  test('install coerces a Coze name that NAME_RE would otherwise reject', async () => {
    const user = await User.create({
      username: 'gallery-eve', email: 'gallery-eve@test.local', password: 'pw-eve-123', status: 'active',
    });
    const session = await workflowService.enumerateCoze(user.id, { content: tableJson.toString('utf8') });
    const created = await workflowService.installCozeEntry(user.id, {
      sessionId: session.sessionId,
      index: 0,
      name: 'Sales / Report (v2) 🎯',
    });
    // Slash, parentheses and emoji are coerced to spaces — never a 400.
    expect(created.name).not.toMatch(/[/()🎯]/);
    expect(created.name.length).toBeGreaterThan(0);
  });
});
