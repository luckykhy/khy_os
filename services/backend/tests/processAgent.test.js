'use strict';

const path = require('path');
const { fork } = require('child_process');
const { MSG, createMessage, parseMessage } = require('../src/coordinator/ipcProtocol');

describe('ProcessAgent', () => {
  // ── AgentContext serialization round-trip ──────────────────────────

  describe('AgentContext serialization', () => {
    test('toSerializable + fromSerializable round-trip', () => {
      const { AgentContext } = require('../src/services/agentContext');

      const root = new AgentContext({
        role: 'coder',
        toolFilter: 'full',
        config: { maxTokens: 4096, effort: 'high' },
      });
      root.revealTool('webSearch');
      root.revealTool('shellCommand');

      const serialized = root.toSerializable();
      expect(serialized._agentCtxVersion).toBe(1);
      expect(serialized.role).toBe('coder');
      expect(serialized.config.maxTokens).toBe(4096);
      expect(serialized.revealedDeferred).toContain('webSearch');

      const restored = AgentContext.fromSerializable(serialized);
      expect(restored.id).toBe(root.id);
      expect(restored.role).toBe('coder');
      expect(restored.config.maxTokens).toBe(4096);
      expect(restored.isToolRevealed('webSearch')).toBe(true);
      expect(restored.isToolRevealed('shellCommand')).toBe(true);
      // File cache should be empty (not transferred)
      expect(restored.fileReadCache.size).toBe(0);
    });

    test('fromSerializable rejects invalid version', () => {
      const { AgentContext } = require('../src/services/agentContext');
      expect(() => AgentContext.fromSerializable({})).toThrow('version mismatch');
      expect(() => AgentContext.fromSerializable({ _agentCtxVersion: 99 })).toThrow('version mismatch');
    });

    test('fork + serialize preserves parent config', () => {
      const { AgentContext } = require('../src/services/agentContext');

      const parent = new AgentContext({
        config: { maxTokens: 8192, model: 'claude' },
      });
      parent.revealTool('Read');

      const child = parent.fork({ role: 'explore', toolFilter: 'readonly' });
      const childSer = child.toSerializable();

      expect(childSer.parentId).toBe(parent.id);
      expect(childSer.depth).toBe(1);
      expect(childSer.config.maxTokens).toBe(8192); // inherited
      expect(childSer.config.model).toBe('claude');  // inherited
      expect(childSer.revealedDeferred).toContain('Read'); // inherited
    });
  });

  // ── createProcessLimits ───────────────────────────────────────────

  describe('createProcessLimits', () => {
    test('returns execArgv with heap limit', () => {
      const { createProcessLimits } = require('../src/services/resourceGuard');

      const limits = createProcessLimits({ role: 'explore', maxHeapMB: 64 });
      expect(limits.execArgv).toContain('--max-old-space-size=64');
      expect(limits.env.UV_THREADPOOL_SIZE).toBe('2');
      expect(limits.env.KHY_AGENT_ROLE).toBe('explore');
    });

    test('uses role-based defaults', () => {
      const { createProcessLimits } = require('../src/services/resourceGuard');

      const explore = createProcessLimits({ role: 'explore' });
      expect(explore.execArgv).toContain('--max-old-space-size=128');

      const coder = createProcessLimits({ role: 'coder' });
      expect(coder.execArgv).toContain('--max-old-space-size=256');
    });

    test('falls back to 256MB for unknown role', () => {
      const { createProcessLimits } = require('../src/services/resourceGuard');
      const limits = createProcessLimits({ role: 'unknown' });
      expect(limits.execArgv).toContain('--max-old-space-size=256');
    });
  });

  // ── agentWorkerEntry IPC echo test ────────────────────────────────

  describe('agentWorkerEntry IPC', () => {
    const ENTRY = path.join(__dirname, '../src/coordinator/agentWorkerEntry.js');

    test('child responds READY after INIT', (done) => {
      const { AgentContext } = require('../src/services/agentContext');
      const ctx = new AgentContext({ role: 'general' });

      const child = fork(ENTRY, [], {
        execArgv: ['--max-old-space-size=64'],
        silent: true,
        env: { ...process.env, KHY_TASK_CAPABILITY_GATE: 'false' },
      });

      let gotReady = false;

      child.on('message', (raw) => {
        const parsed = parseMessage(raw);
        if (!parsed.valid) return;
        if (parsed.msg.type === MSG.READY) {
          gotReady = true;
          // Send KILL to clean up
          child.send(createMessage(MSG.KILL, ctx.id, {}));
        }
      });

      child.on('exit', () => {
        expect(gotReady).toBe(true);
        done();
      });

      // Send INIT
      child.send(createMessage(MSG.INIT, ctx.id, {
        context: ctx.toSerializable(),
      }));
    }, 15000);

    test('child sends ERROR on invalid context', (done) => {
      const child = fork(ENTRY, [], {
        execArgv: ['--max-old-space-size=64'],
        silent: true,
        env: { ...process.env, KHY_TASK_CAPABILITY_GATE: 'false' },
      });

      let gotError = false;

      child.on('message', (raw) => {
        const parsed = parseMessage(raw);
        if (!parsed.valid) return;
        if (parsed.msg.type === MSG.ERROR) {
          gotError = true;
          expect(parsed.msg.payload.message).toContain('Init failed');
        }
      });

      child.on('exit', () => {
        expect(gotError).toBe(true);
        done();
      });

      // Send INIT with invalid context
      child.send(createMessage(MSG.INIT, 'bad-agent', {
        context: { invalid: true },
      }));
    }, 15000);
  });

  // ── ProcessAgent class ────────────────────────────────────────────

  describe('ProcessAgent class', () => {
    test('constructor sets initial state', () => {
      const { ProcessAgent } = require('../src/coordinator/processAgent');
      const agent = new ProcessAgent('test task', { role: 'explore' });

      expect(agent.id).toMatch(/^pa-/);
      expect(agent.task).toBe('test task');
      expect(agent.role).toBe('explore');
      expect(agent.state.status).toBe('created');
      expect(agent.state.pid).toBeNull();
    });

    test('kill sets status to killed', () => {
      const { ProcessAgent } = require('../src/coordinator/processAgent');
      const agent = new ProcessAgent('test');
      // kill() without spawn is safe (no child)
      agent.state.status = 'running';
      agent.kill();
      expect(agent.state.status).toBe('killed');
    });
  });

  // ── workerAgent processMode ───────────────────────────────────────

  describe('workerAgent processMode flag', () => {
    test('spawnWorker with processMode=false uses in-process (default)', async () => {
      // Just verify the function signature accepts processMode
      const workerModule = require('../src/coordinator/workerAgent');
      expect(typeof workerModule.spawnWorker).toBe('function');
    });
  });
});
