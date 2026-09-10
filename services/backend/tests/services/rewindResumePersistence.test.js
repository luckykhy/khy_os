'use strict';
// Integration: prove the per-turn checkpointId survives the JSONL persistence
// round-trip (appendMessage write â†?restoreSession read) when KHY_REWIND_PERSIST
// is on, and that gate-off yields a byte-identical (checkpointId-free) JSONL line.
const fs = require('fs');
const os = require('os');
const path = require('path');
// KHYOS_HOME must be set before requiring dataHome-dependent modules.
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-rewind-'));
process.env.KHYOS_HOME = TMP_HOME;
const sp = require('../../src/services/sessionPersistence');

describe('Rewind Resume Persistence', () => {
  test('round-trip: checkpointId survives appendMessage -> restoreSession', () => {
      const sid = 'rw-roundtrip-1';
      const a = sp.appendMessage(sid, { role: 'user', content: 'first turn', checkpointId: 'ck_111' }, null);
      expect(a && a.uuid).toBeTruthy();
      sp.appendMessage(sid, { role: 'assistant', content: 'ok' }, a.uuid);
    
      const restored = sp.restoreSession(sid, { });
      expect(restored && Array.isArray(restored.messages).toBeTruthy());
      const userMsg = restored.messages.find((m) => m.role === 'user');
      expect(userMsg).toBeTruthy();
      expect(userMsg.checkpointId).toBe('ck_111', 'checkpointId survives the JSONL round-trip');
  });

  test('gate-off: checkpointId NOT written (byte-revert) ', () => {
      const prev = process.env.KHY_REWIND_PERSIST;
      process.env.KHY_REWIND_PERSIST = 'off';
      try {
        const sid = 'rw-gateoff-1';
        sp.appendMessage(sid, { role: 'user', content: 'x', checkpointId: 'ck_should_drop' }, null);
        const file = sp.jsonlPathFor(sid);
        const raw = fs.readFileSync(file, 'utf-8');
        expect(!raw.includes('ck_should_drop')).toBeTruthy();
        expect(!raw.includes('checkpointId')).toBeTruthy();
      } finally {
        if (prev === undefined) delete process.env.KHY_REWIND_PERSIST;
        else process.env.KHY_REWIND_PERSIST = prev;
      }
  });

  test('no checkpointId on message -> none written (unaffected turns stay clean)', () => {
      const sid = 'rw-nock-1';
      sp.appendMessage(sid, { role: 'user', content: 'plain' }, null);
      const file = sp.jsonlPathFor(sid);
      const raw = fs.readFileSync(file, 'utf-8');
      expect(!raw).toContain('checkpointId');
  });

});

