const { setupCliHarness, emitLineAndWait } = require('./replTestHarness');
const fs = require('fs');
test('diag', async () => {
  jest.useFakeTimers();
  let detect=0, exec=0;
  const quickTaskServiceMock = {
    detectQuickTask: jest.fn(() => { detect++; return { kind:'math', text:'123 * 456' }; }),
    executeQuickTask: jest.fn(async () => { exec++; return { reply:'ok' }; }),
  };
  const h = await setupCliHarness({
    installMocks: () => {
      jest.doMock('../../src/services/quickTaskService', () => quickTaskServiceMock);
    },
  });
  const rl = h.rl;
  const info = {
    isTTY: !!process.stdout.isTTY,
    hasRl: !!rl,
    lineListeners: rl ? rl.listenerCount('line') : -1,
    npm_lifecycle: process.env.npm_lifecycle_event || null,
    npm_exec: process.env.npm_command || null,
  };
  if (rl) await emitLineAndWait(rl, '123 * 456');
  info.detectAfter = detect; info.execAfter = exec;
  info.routeCalls = h.routerMock.route.mock.calls.length;
  info.parseCalls = h.routerMock.parseInput.mock.calls.length;
  fs.writeFileSync('/tmp/diag.json', JSON.stringify(info, null, 2));
  jest.useRealTimers();
  expect(true).toBe(true);
});
