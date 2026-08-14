'use strict';

const { EventEmitter } = require('events');

function createFakeResponse() {
  const res = new EventEmitter();
  res.output = [];
  res.writableLength = 0;
  res.writableEnded = false;
  res.writableFinished = false;
  res.destroyed = false;
  res.write = jest.fn((chunk) => {
    res.output.push(String(chunk));
    return true;
  });
  return res;
}

describe('SSEKeepalive trailing flush', () => {
  let now;

  beforeEach(() => {
    jest.resetModules();
    now = 1000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('done() flushes queued events before terminal done event', async () => {
    const { SSEKeepalive } = require('../../src/services/sseKeepalive');
    const res = createFakeResponse();
    const keepalive = new SSEKeepalive(res);

    await keepalive.sendAsync('message', { part: 1 });
    await keepalive.sendAsync('message', { part: 2 });
    await keepalive.done(false);

    const output = res.output.join('');
    const firstIdx = output.indexOf('"part":1');
    const secondIdx = output.indexOf('"part":2');
    const doneIdx = output.indexOf('event: done');

    expect(firstIdx).toBeGreaterThanOrEqual(0);
    expect(secondIdx).toBeGreaterThan(firstIdx);
    expect(doneIdx).toBeGreaterThan(secondIdx);
    expect(output).toContain('"aborted":false');
  });

  test('stop() flushes queued tail content before destroy', async () => {
    const { SSEKeepalive } = require('../../src/services/sseKeepalive');
    const res = createFakeResponse();
    const keepalive = new SSEKeepalive(res);

    await keepalive.sendAsync('message', { part: 'A' });
    await keepalive.sendAsync('message', { part: 'B' });
    await keepalive.stop();

    const output = res.output.join('');
    expect(output).toContain('"part":"A"');
    expect(output).toContain('"part":"B"');
  });
});
