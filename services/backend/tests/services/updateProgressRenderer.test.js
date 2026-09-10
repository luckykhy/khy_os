'use strict';

const { createProgressRenderer } = require('./updateProgressRenderer');

describe('updateProgressRenderer', () => {
  let output;
  let renderer;

  beforeEach(() => {
    output = { write: jest.fn() };
  });

  it('should export createProgressRenderer', () => {
    expect(typeof createProgressRenderer).toBe('function');
  });

  it('creates a renderer with render and finish', () => {
    renderer = createProgressRenderer({ output });
    expect(typeof renderer.render).toBe('function');
    expect(typeof renderer.finish).toBe('function');
    expect(typeof renderer.getLastLine).toBe('function');
  });

  it('render writes to output', () => {
    renderer = createProgressRenderer({ output, isTTY: false });
    renderer.render({ action: '下载', target: 'KhyOS', phase: '处理�?, completed: 50, total: 100 });
    expect(output.write).toHaveBeenCalled();
  });

  it('render returns the line', () => {
    renderer = createProgressRenderer({ output, isTTY: false });
    const line = renderer.render({ action: '下载', target: 'KhyOS', phase: '处理�?, completed: 50, total: 100 });
    expect(line).toContain('下载');
    expect(line).toContain('KhyOS');
    expect(line).toContain('50/100');
  });

  it('render with determinate progress shows percentage', () => {
    renderer = createProgressRenderer({ output, isTTY: false });
    const line = renderer.render({ completed: 25, total: 100 });
    expect(line).toContain('25%');
  });

  it('render with indeterminate progress shows progress text', () => {
    renderer = createProgressRenderer({ output, isTTY: false });
    const line = renderer.render({ progress: '进行�? });
    expect(line).toContain('进行�?);
  });

  it('render with rate shows KiB/s', () => {
    renderer = createProgressRenderer({ output, isTTY: false });
    const line = renderer.render({ completed: 10, total: 100, rate: 2048 });
    expect(line).toContain('2KiB/s');
  });

  it('finish writes final line', () => {
    renderer = createProgressRenderer({ output, isTTY: false });
    renderer.finish({ status: '完成', message: '更新结束' });
    expect(output.write).toHaveBeenCalled();
  });

  it('finish returns the line', () => {
    renderer = createProgressRenderer({ output, isTTY: false });
    const line = renderer.finish({ status: '完成', message: '更新结束' });
    expect(line).toContain('完成');
    expect(line).toContain('更新结束');
  });

  it('getLastLine returns last rendered line', () => {
    renderer = createProgressRenderer({ output, isTTY: false });
    renderer.render({ action: 'test' });
    expect(renderer.getLastLine()).toBeTruthy();
  });

  it('render in TTY mode uses carriage return', () => {
    renderer = createProgressRenderer({ output, isTTY: true });
    renderer.render({ completed: 50, total: 100 });
    expect(output.write).toHaveBeenCalledWith(expect.stringContaining('\r'));
  });

  it('render in non-TTY mode uses newline', () => {
    renderer = createProgressRenderer({ output, isTTY: false });
    renderer.render({ completed: 50, total: 100 });
    expect(output.write).toHaveBeenCalledWith(expect.stringContaining('\n'));
  });

  it('clips long lines to stream width', () => {
    renderer = createProgressRenderer({ output, isTTY: false, streamWidth: 40 });
    const line = renderer.render({ action: 'a'.repeat(100), target: 'b'.repeat(100), phase: 'c'.repeat(100) });
    expect(line.length).toBeLessThanOrEqual(40);
  });

  it('handles null/undefined event fields', () => {
    renderer = createProgressRenderer({ output, isTTY: false });
    const line = renderer.render({});
    expect(line).toContain('更新');
    expect(line).toContain('KhyOS');
  });
});

