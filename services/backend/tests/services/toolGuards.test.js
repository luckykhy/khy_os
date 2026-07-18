'use strict';

const path = require('path');

const {
  outputSizeGuard,
  editBoundaryGuard,
  shellTimeoutGuard,
  registerBuiltinGuards,
  MAX_OUTPUT_BYTES,
} = require('../../src/services/toolGuards');

describe('toolGuards', () => {
  const origEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...origEnv };
  });

  // ── OutputSizeGuard ──────────────────────────────────────────────

  describe('outputSizeGuard', () => {
    test('allows small output untouched', () => {
      const ctx = { result: { success: true, output: 'hello world' } };
      const r = outputSizeGuard(ctx);
      expect(r.action).toBe('allow');
    });

    test('truncates output exceeding MAX_OUTPUT_BYTES', () => {
      const bigOutput = 'x'.repeat(MAX_OUTPUT_BYTES + 1000);
      const ctx = { result: { success: true, output: bigOutput } };
      const r = outputSizeGuard(ctx);
      expect(r.action).toBe('modify');
      expect(r.result._truncated).toBe(true);
      expect(r.result._originalSize).toBe(bigOutput.length);
      expect(r.result.output.length).toBeLessThan(bigOutput.length);
      expect(r.result.output).toContain('head+tail preserved by OutputSizeGuard');
    });

    test('allows result with no output field', () => {
      const ctx = { result: { success: true } };
      expect(outputSizeGuard(ctx).action).toBe('allow');
    });

    test('allows result with content field under limit', () => {
      const ctx = { result: { success: true, content: 'short content' } };
      expect(outputSizeGuard(ctx).action).toBe('allow');
    });

    test('truncates large content field', () => {
      const ctx = { result: { success: true, content: 'y'.repeat(MAX_OUTPUT_BYTES + 500) } };
      const r = outputSizeGuard(ctx);
      expect(r.action).toBe('modify');
      expect(r.result._truncated).toBe(true);
    });
  });

  // ── EditBoundaryGuard ────────────────────────────────────────────

  describe('editBoundaryGuard', () => {
    test('allows edits within project root', () => {
      const cwd = process.cwd();
      const ctx = { params: { file_path: path.join(cwd, 'src', 'test.js') } };
      const r = editBoundaryGuard(ctx);
      expect(r.action).toBe('allow');
    });

    test('allows edits at project root itself', () => {
      const cwd = process.cwd();
      const ctx = { params: { file_path: cwd } };
      expect(editBoundaryGuard(ctx).action).toBe('allow');
    });

    test('blocks edits outside project root', () => {
      const ctx = { params: { file_path: '/etc/passwd' } };
      const r = editBoundaryGuard(ctx);
      expect(r.action).toBe('block');
      expect(r.reason).toContain('outside project root');
    });

    test('allows when no file_path param', () => {
      const ctx = { params: { something: 'else' } };
      expect(editBoundaryGuard(ctx).action).toBe('allow');
    });

    test('allows relative paths within cwd', () => {
      const ctx = { params: { path: 'src/test.js' } };
      expect(editBoundaryGuard(ctx).action).toBe('allow');
    });

    test('allows writes to the user Desktop (trusted root) outside project', () => {
      const os = require('os');
      const desktop = path.join(os.homedir(), 'Desktop', '日语学习.md');
      const ctx = { params: { file_path: desktop } };
      expect(editBoundaryGuard(ctx).action).toBe('allow');
    });

    test('KHY_STRICT_WRITE_BOUNDARY=1 re-blocks the Desktop write', () => {
      const os = require('os');
      const prev = process.env.KHY_STRICT_WRITE_BOUNDARY;
      process.env.KHY_STRICT_WRITE_BOUNDARY = '1';
      try {
        const desktop = path.join(os.homedir(), 'Desktop', 'x.md');
        const r = editBoundaryGuard({ params: { file_path: desktop } });
        expect(r.action).toBe('block');
        expect(r.approvable).toBe(true);
      } finally {
        if (prev === undefined) delete process.env.KHY_STRICT_WRITE_BOUNDARY;
        else process.env.KHY_STRICT_WRITE_BOUNDARY = prev;
      }
    });
  });

  // ── ShellTimeoutGuard ────────────────────────────────────────────

  describe('shellTimeoutGuard', () => {
    test('injects default timeout when no timeout parameter', () => {
      const ctx = { params: { command: 'ls -la' } };
      const r = shellTimeoutGuard(ctx);
      expect(r.action).toBe('modify');
      expect(r.params.timeout).toBeGreaterThan(0);
      expect(r.params._timeoutInjected).toBe(true);
    });

    test('allows when timeout param present', () => {
      const ctx = { params: { command: 'ls', timeout: 5000 } };
      expect(shellTimeoutGuard(ctx).action).toBe('allow');
    });

    test('allows when timeout_ms param present', () => {
      const ctx = { params: { command: 'ls', timeout_ms: 5000 } };
      expect(shellTimeoutGuard(ctx).action).toBe('allow');
    });
  });

  // ── registerBuiltinGuards ────────────────────────────────────────

  describe('registerBuiltinGuards', () => {
    test('registers 11 guards when enabled', () => {
      const registered = [];
      const mockHookSystem = {
        registerFunction: (event, fn, opts) => registered.push({ event, opts }),
      };
      const count = registerBuiltinGuards(mockHookSystem);
      expect(count).toBe(11);
      expect(registered.length).toBe(11);
      expect(registered.some(r => r.opts.source === 'builtin:OutputSizeGuard')).toBe(true);
      expect(registered.some(r => r.opts.source === 'builtin:EditBoundaryGuard')).toBe(true);
      expect(registered.some(r => r.opts.source === 'builtin:ReadBoundaryGuard')).toBe(true);
      expect(registered.some(r => r.opts.source === 'builtin:ShellTimeoutGuard')).toBe(true);
      expect(registered.some(r => r.opts.source === 'builtin:RateLimitGuard')).toBe(true);
      expect(registered.some(r => r.opts.source === 'builtin:PathTraversalGuard')).toBe(true);
      expect(registered.some(r => r.opts.source === 'builtin:ErrorRecoveryGuard')).toBe(true);
      expect(registered.some(r => r.opts.source === 'builtin:PriorReadGuard')).toBe(true);
      expect(registered.some(r => r.opts.source === 'builtin:FileStaleGuard')).toBe(true);
      expect(registered.some(r => r.opts.source === 'builtin:LspDiagnosticsGuard')).toBe(true);
      expect(registered.some(r => r.opts.source === 'builtin:ProjectHygieneGuard')).toBe(true);
    });

    test('skips all guards when KHY_TOOL_GUARDS=false', () => {
      process.env.KHY_TOOL_GUARDS = 'false';
      const mockHookSystem = {
        registerFunction: jest.fn(),
      };
      const count = registerBuiltinGuards(mockHookSystem);
      expect(count).toBe(0);
      expect(mockHookSystem.registerFunction).not.toHaveBeenCalled();
    });

    test('returns 0 for null hookSystem', () => {
      expect(registerBuiltinGuards(null)).toBe(0);
      expect(registerBuiltinGuards(undefined)).toBe(0);
    });

    test('all guards have valid priority between 5 and 15', () => {
      const registered = [];
      const mockHookSystem = {
        registerFunction: (event, fn, opts) => registered.push(opts),
      };
      registerBuiltinGuards(mockHookSystem);
      for (const opts of registered) {
        expect(opts.priority).toBeGreaterThanOrEqual(5);
        expect(opts.priority).toBeLessThanOrEqual(15);
      }
    });
  });
});
