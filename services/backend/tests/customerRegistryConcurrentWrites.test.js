'use strict';
/**
 * customerRegistry cross-process write safety.
 *
 * The gateway customer store is a JSON file written via tmp+rename by MULTIPLE
 * processes (the daemon, the CLI, the management server). Today `saveStore` is
 * last-writer-wins with no version check, so two concurrent writers silently
 * clobber each other (a lost update), and a process that dies between the tmp
 * write and the rename leaves orphaned `<file>.tmp.*` litter (4 observed in
 * `.khy`).
 *
 * This pins the F10 contract:
 *   - `loadStore()` exposes a monotonic `version`;
 *   - `saveStore(store, baseVersion)` refuses to write when the on-disk version
 *     has advanced past `baseVersion` (CAS conflict → no lost update);
 *   - `sweepOrphanTemps(dir)` removes orphaned `.tmp.*` files.
 *
 * RED until F10 implements version CAS + the sweep.
 */

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

let registry;
let dataHome;
let _isolatedDataHome;
let _prevDataHome;

const CUSTOMER_FILE = () => path.join(dataHome.getDataHome(), 'ai_gateway_customers.json');

beforeAll(() => {
  // Keep the legacy read-path (os.homedir()/.khyquant) off the real C: drive.
  jest.spyOn(os, 'homedir').mockReturnValue(fs.mkdtempSync(path.join(os.tmpdir(), 'khy-custreg-')));
  // Pin the data home to a throwaway dir so every store write stays isolated
  // (the portable .khy next to a source checkout is LIVE app state — never touch it).
  _isolatedDataHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-custreg-datahome-'));
  _prevDataHome = process.env.KHY_DATA_HOME;
  process.env.KHY_DATA_HOME = _isolatedDataHome;
  registry = require('../src/services/gateway/customerRegistry');
  dataHome = require('../src/utils/dataHome');
});

afterAll(() => {
  if (_prevDataHome === undefined) delete process.env.KHY_DATA_HOME;
  else process.env.KHY_DATA_HOME = _prevDataHome;
  jest.restoreAllMocks();
  if (_isolatedDataHome) fs.rmSync(_isolatedDataHome, { recursive: true, force: true });
});

function cust(id) {
  return { id, name: id.toUpperCase(), enabled: true, quota: { monthlyRequests: 10 } };
}

describe('customerRegistry cross-process write safety', () => {
  test('saveStore(store, baseVersion) is a CAS: a stale baseVersion conflicts, no lost update', () => {
    // Start clean.
    registry.saveStore({ customers: [] });

    // Writer B adds customer "b" (advances the on-disk version).
    registry.saveStore({ customers: [cust('b')] });
    const snapA = registry.loadStore(); // writer A takes a snapshot at the current version

    // Writer B adds customer "c" (advances the version again).
    registry.saveStore({ customers: [cust('b'), cust('c')] });

    // Writer A now saves its stale snapshot (still just [b]) based on the version it saw.
    const ra = registry.saveStore(snapA, snapA.version);

    // Today this silently clobbers [b,c] with [b]. After F10 it must report a conflict.
    expect(ra && ra.conflict).toBe(true);
    // The on-disk store must still hold c (the newer writer's data was not lost).
    const now = registry.loadStore();
    const ids = now.customers.map((c) => c.id);
    expect(ids).toContain('c');
  });

  test('saveStore with a matching baseVersion writes and bumps the version', () => {
    registry.saveStore({ customers: [] });
    const s0 = registry.loadStore();
    const r = registry.saveStore({ customers: [cust('x')] }, s0.version);
    expect(r && (r.ok === true || r.conflict === undefined)).toBe(true);
    const after = registry.loadStore();
    expect(after.customers.map((c) => c.id)).toContain('x');
    expect(after.version).toBeGreaterThan(s0.version);
  });

  test('sweepOrphanTemps removes orphaned .tmp.* files', () => {
    const dir = dataHome.getDataHome();
    const orphan1 = CUSTOMER_FILE() + '.tmp.111';
    const orphan2 = CUSTOMER_FILE() + '.tmp.222';
    fs.writeFileSync(orphan1, '{}');
    fs.writeFileSync(orphan2, '{}');
    const swept = registry.sweepOrphanTemps(dir);
    expect(fs.existsSync(orphan1)).toBe(false);
    expect(fs.existsSync(orphan2)).toBe(false);
    expect(Array.isArray(swept) && swept.length).toBe(2);
  });
});
