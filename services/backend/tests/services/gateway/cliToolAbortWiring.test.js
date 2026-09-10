'use strict';
const { spawn } = require('child_process');
const cliTool = require('../../../src/services/gateway/adapters/cliToolAdapter');
const { _wireChildAbort, _isCliToolAbortEnabled } = cliTool.__test__;
// ── 门控:默认 on,�?off/false/0/no �?─────────────────────────────────────
// ── 功能�?abort signal 触发 �?真子进程被杀 + onAbort 回调收到 err ───────────

describe('Cli Tool Abort Wiring', () => {
  test('_isCliToolAbortEnabled: default on', async () => {
      const saved = process.env.KHY_CLITOOL_ABORT;
      delete process.env.KHY_CLITOOL_ABORT;
      try {
        expect(_isCliToolAbortEnabled()).toBe(true);
      } finally {
        if (saved === undefined) delete process.env.KHY_CLITOOL_ABORT;
        else process.env.KHY_CLITOOL_ABORT = saved;
      }
  });

  test('_isCliToolAbortEnabled: off words disable it', async () => {
      const saved = process.env.KHY_CLITOOL_ABORT;
      try {
        for (const v of ['off', 'false', '0', 'no', 'OFF']) {
          process.env.KHY_CLITOOL_ABORT = v;
          expect(_isCliToolAbortEnabled()).toBe(false, `expected off for ${v}`);
        }
        for (const v of ['on', 'true', '1', '']) {
          process.env.KHY_CLITOOL_ABORT = v;
          expect(_isCliToolAbortEnabled()).toBe(true, `expected on for ${v}`);
        }
      } finally {
        if (saved === undefined) delete process.env.KHY_CLITOOL_ABORT;
        else process.env.KHY_CLITOOL_ABORT = saved;
      }
  });

  test('_wireChildAbort: aborting the signal kills the child and fires onAbort', async () => {
      // 一个会 hang 的子进程(sleep 长时�?,模拟卡住�?CLI 工具�?
      const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], {
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
    
      const ac = new AbortController();
      let abortErr = null;
      const detach = _wireChildAbort(child, ac.signal, (err) => { abortErr = err; });
    
      // 触发 abort �?�?SIGKILL 子进程�?
      ac.abort('user pressed Esc');
    
      const { signal } = await exited;
      expect(signal).toBe('SIGKILL', 'child should be killed with SIGKILL');
      expect(abortErr instanceof Error).toBeTruthy();
      expect(/aborted/.test(abortErr.message).toBeTruthy());
      detach();
  });

  test('_wireChildAbort: gate off �?returns no-op detach, child survives abort', async () => {
      const saved = process.env.KHY_CLITOOL_ABORT;
      process.env.KHY_CLITOOL_ABORT = 'off';
      const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 2000)'], {
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
      try {
        const ac = new AbortController();
        let fired = false;
        const detach = _wireChildAbort(child, ac.signal, () => { fired = true; });
        ac.abort();
        // 门关:不挂监听 �?不杀子进�?onAbort 不触发。给一点时间证明没被杀�?
        await new Promise((r) => setTimeout(r, 100));
        expect(fired).toBe(false, 'onAbort must not fire when gate is off');
        expect(child.killed).toBe(false, 'child must not be killed when gate is off');
        detach();
        child.kill('SIGKILL'); // 清理
        await exited;
      } finally {
        if (saved === undefined) delete process.env.KHY_CLITOOL_ABORT;
        else process.env.KHY_CLITOOL_ABORT = saved;
      }
  });

  test('_wireChildAbort: missing signal �?no-op detach, no throw', async () => {
      const child = spawn(process.execPath, ['-e', ''], { stdio: ['ignore', 'ignore', 'ignore'] });
      assert.doesNotThrow(() => {
        const detach = _wireChildAbort(child, null, () => {});
        detach();
      });
      child.kill('SIGKILL');
  });

  test('_wireChildAbort: already-aborted signal kills immediately', async () => {
      const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], {
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
      const ac = new AbortController();
      ac.abort('pre-aborted');
      let abortErr = null;
      _wireChildAbort(child, ac.signal, (err) => { abortErr = err; });
      const { signal } = await exited;
      expect(signal).toBe('SIGKILL');
      expect(abortErr instanceof Error).toBeTruthy();
  });

});

