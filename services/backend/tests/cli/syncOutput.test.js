'use strict';
/**
 * syncOutput.test.js â€?stdout write coalescing (node:test).
 *
 * The core fix for "Windows easily freezes": syncWrite() must collapse a block of
 * many stdout writes into a SINGLE process.stdout.write, regardless of whether the
 * terminal supports DEC-2026 synchronized output. On legacy Windows conhost each
 * console write is a blocking syscall, so N writes â†?1 write is the real cure.
 */
const sync = require('../../src/cli/syncOutput');
let realWrite;
let writeCalls;
beforeEach(() => {
  realWrite = process.stdout.write;
  writeCalls = [];
  // Replace the real write with a counter BEFORE syncWrite captures it, so we
  // observe how many times the coalescer flushes to the underlying stream.
  process.stdout.write = (chunk) => {
    writeCalls.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  };
});
afterEach(() => {
  process.stdout.write = realWrite;
});

describe('Sync Output', () => {
  test('coalesces many writes inside a frame into a single underlying write', () => {
      sync.syncWrite(() => {
        for (let i = 0; i < 10; i += 1) process.stdout.write(`line ${i}\n`);
      });
      // DEC markers may add writes, but the 10 payload writes must collapse to one.
      const payload = writeCalls.filter((c) => c.includes('line '));
      expect(payload.length).toBe(1, 'all payload writes flush as one chunk');
      // Content + order preserved.
      for (let i = 0; i < 10; i += 1) expect(payload[0]).toContain(`line ${i}\n`);
      expect(payload[0].indexOf('line 0').toBeTruthy() < payload[0].indexOf('line 9'));
  });

  test('console.log routed through stdout is coalesced too', () => {
      sync.syncWrite(() => {
        console.log('a');
        console.log('b');
        console.log('c');
      });
      const payload = writeCalls.filter((c) => /[abc]/.test(c));
      expect(payload.length).toBe(1);
      expect(payload[0].includes('a\n') && payload[0].includes('b\n') && payload[0]).toContain('c\n');
  });

  test('restores the real stdout.write after the frame (no leak)', () => {
      const before = process.stdout.write;
      sync.syncWrite(() => { process.stdout.write('x'); });
      expect(process.stdout.write).toBe(before, 'write hook removed after frame');
  });

  test('nested frames flush only once at the outermost close', () => {
      sync.syncWrite(() => {
        process.stdout.write('outer-start\n');
        sync.syncWrite(() => {
          process.stdout.write('inner\n');
        });
        // Inner frame must NOT have flushed yet â€?still buffered by the outer frame.
        expect(writeCalls.filter((c) => c.includes('inner')).length).toBe(0);
        process.stdout.write('outer-end\n');
      });
      const payload = writeCalls.filter((c) => c.includes('outer-start'));
      expect(payload.length).toBe(1, 'single flush for the whole nested tree');
      expect(payload[0]).toContain('inner\n');
      expect(payload[0]).toContain('outer-end\n');
  });

  test('restores stdout.write even if fn throws', () => {
      const before = process.stdout.write;
      assert.throws(() => {
        sync.syncWrite(() => { process.stdout.write('partial'); throw new Error('boom'); });
      }, /boom/);
      expect(process.stdout.write).toBe(before, 'hook removed on the error path');
      // The partial buffered write still flushes (frame closed in finally).
      expect(writeCalls.some((c) => c)).toContain('partial');
  });

  test('fires a caller-supplied write callback', () => {
      let called = false;
      sync.syncWrite(() => {
        process.stdout.write('y\n', () => { called = true; });
      });
      expect(called).toBeTruthy();
  });

});

