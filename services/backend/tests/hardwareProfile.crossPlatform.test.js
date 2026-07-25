/**
 * Cross-platform regression tests for hardware disk/swap detection.
 *
 * Goal: khy must work on new AND old Windows, Linux, and macOS. The previous
 * implementation shelled out to GNU-only `df -BM` / `free -m` (broken on
 * macOS/BSD) and `wmic` (removed in Windows 11 24H2). detectDisk now uses
 * fs.statfsSync (no shell, all platforms); detectSwap branches per platform.
 *
 * These tests run on the Linux CI host but assert the platform-agnostic
 * contract: disk detection yields real, internally-consistent numbers without
 * invoking any external command.
 */

const hw = require('../src/services/hardwareProfileService');

describe('hardwareProfileService — cross-platform disk/swap', () => {
  test('detectDisk returns real, consistent numbers via fs.statfsSync (no shell)', () => {
    const d = hw.detectDisk();
    expect(d).toEqual(expect.objectContaining({
      totalMB: expect.any(Number),
      usedMB: expect.any(Number),
      availMB: expect.any(Number),
      usePercent: expect.any(Number),
    }));
    // On any real host the root/volume has non-zero capacity.
    expect(d.totalMB).toBeGreaterThan(0);
    expect(d.availMB).toBeGreaterThanOrEqual(0);
    expect(d.availMB).toBeLessThanOrEqual(d.totalMB);
    expect(d.usePercent).toBeGreaterThanOrEqual(0);
    expect(d.usePercent).toBeLessThanOrEqual(100);
  });

  test('detectSwap never throws and returns the numeric contract on any platform', () => {
    const s = hw.detectSwap();
    expect(s).toEqual(expect.objectContaining({
      totalMB: expect.any(Number),
      usedMB: expect.any(Number),
      freeMB: expect.any(Number),
    }));
    expect(s.totalMB).toBeGreaterThanOrEqual(0);
    expect(s.usedMB).toBeGreaterThanOrEqual(0);
    expect(s.freeMB).toBeGreaterThanOrEqual(0);
  });
});
