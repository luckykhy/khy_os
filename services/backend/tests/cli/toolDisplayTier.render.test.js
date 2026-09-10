'use strict';
/**
 * toolDisplayTier.render.test.js �?输出区分级（tier）与焦点说明行契约测试�? *
 * 单一真源：cli/toolDisplayPolicy.js（tier 注册�?+ getToolTier/isCoreToolDisplay/
 * buildCoreFocusLine）。三条渲染路径（经典 REPL step �?/ 管道工具头行 / headless
 * stderr �?/ TUI 叙述行）消费同一份分级，本测试锁定分级数据与纯字符串行为�? *  - core（shell/�?编辑/应用启动/agent）→ 常驻显示 + �?焦点锚点
 *  - minor（read/grep/glob/websearch/webfetch/todo）→ 显示后折叠成摘要�? *  - 未注册工具默�?core（宁可见到，不可漏掉�? *  - printStepLine core 强调 / headless formatToolStart �?前缀（console 捕获�? */
const policy = require('./toolDisplayPolicy');

describe('Tool Display Tier render', () => {
  test('getToolTier: 核心工具 �?core（状态变�?委派类）', () => {
      for (const name of ['bash', 'shell', 'shell_command', 'write', 'write_file', 'edit', 'edit_file', 'agent', 'task', 'open_app']) {
        expect(policy.getToolTier(name).toBe('core');
        expect(policy.isCoreToolDisplay(name).toBe(true);
      }
  });

  test('getToolTier: 次要工具 �?minor（只�?信息类，显示后折叠）', () => {
      for (const name of ['read', 'read_file', 'grep', 'glob', 'find', 'ls', 'websearch', 'web_search', 'webfetch', 'web_fetch', 'todowrite']) {
        expect(policy.getToolTier(name).toBe('minor');
        expect(policy.isCoreToolDisplay(name).toBe(false);
      }
  });

  test('getToolTier: 未注册工具默�?core（宁可见到，不可漏掉�?, () => {
      expect(policy.getToolTier('image_generate').toBe('core');
      expect(policy.getToolTier('totally_unknown_tool').toBe('core');
      expect(policy.getToolTier('').toBe('core');
      expect(policy.getToolTier(null).toBe('core');
  });

  test('buildCoreFocusLine: �?焦点锚点 + 标签 + 目标三段�?, () => {
      expect(policy.buildCoreFocusLine('写入文件')).toBe('src/x.js');
      expect(policy.buildCoreFocusLine('执行命令')).toBe('');
      expect(policy.buildCoreFocusLine('')).toBe('src/x.js');
      expect(policy.buildCoreFocusLine(null)).toBe(null);
      expect(policy.buildCoreFocusLine('  执行命令  ')).toBe('  src/x.js  ');
  });

  test('printStepLine: 核心工具 �?焦点强调，次要工具保持轻�?, () => {
      const steps = require('./steps');
      const savedIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
      const savedInk = process.env.KHY_INK_TUI_ACTIVE;
      const lines = [];
      const savedLog = console.log;
      console.log = (...args) => lines.push(args.join(' '));
      try {
        Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
        delete process.env.KHY_INK_TUI_ACTIVE;
    
        lines.length = 0;
        steps.printStepLine('active', 'Running command', 'npm test', '', { toolName: 'bash' });
        expect(lines.length).toBe(1);
        expect(lines[0].includes('�?).toBe();
        expect(lines[0]).toContain('Running command');
        expect(lines[0]).toContain('npm test');
    
        lines.length = 0;
        steps.printStepLine('active', 'Reading file', 'src/x.js', '', { toolName: 'read_file' });
        expect(lines.length).toBe(1);
        expect(!lines[0].includes('�?).toBe();
        expect(lines[0]).toContain('Reading file');
    
        // 未传 toolName（旧调用方）�?无锚点，逐字节回退旧行�?        lines.length = 0;
        steps.printStepLine('active', 'Running command', 'npm test');
        expect(lines.length).toBe(1);
        expect(!lines[0].includes('�?).toBe();
      } finally {
        console.log = savedLog;
        if (savedIsTTY) {
          Object.defineProperty(process.stdout, 'isTTY', savedIsTTY);
        }
        if (savedInk === undefined) {
          delete process.env.KHY_INK_TUI_ACTIVE;
        } else {
          process.env.KHY_INK_TUI_ACTIVE = savedInk;
        }
      }
  });

  test('headless formatToolStart: core �?�?前缀，minor 保持原行', () => {
      const hp = require('./headlessProgress');
      const bashLine = hp.formatToolStart('bash', { command: 'npm test' });
      expect(bashLine.startsWith('�?').toBe();
      expect(bashLine).toContain('npm test');
    
      const readLine = hp.formatToolStart('read_file', { path: 'src/x.js' });
      expect(!readLine.startsWith('�?).toBe();
      expect(readLine).toContain('src/x.js');
    
      const unknownLine = hp.formatToolStart('mystery_tool', {});
      expect(unknownLine.startsWith('�?).toBe();
  });

  test('分级注册表完整性：每条 policy 都有合法 tier', () => {
      for (const [key, p] of Object.entries(policy.POLICIES)) {
        expect(p.tier === 'core' || p.tier === 'minor').toBeTruthy();
      }
      expect(policy.DEFAULT_POLICY.tier).toBe('core');
  });

});

