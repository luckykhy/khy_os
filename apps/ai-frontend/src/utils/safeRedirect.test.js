import { describe, it, expect } from 'vitest';
import { safeRedirectPath } from './safeRedirect';

/**
 * safeRedirectPath — 锁 `?redirect=` 开放重定向防护：
 * 只接受同源相对路径；协议相对（//evil.com）与控制字符 + // 的
 * 浏览器规范化绕过全部落到 fallback。
 * 控制字符一律用 \\uXXXX 转义序列写进源码，绝不落字面控制字节。
 */

describe('同源相对路径直通', () => {
  it('根路径与嵌套路径原样返回', () => {
    expect(safeRedirectPath('/')).toBe('/');
    expect(safeRedirectPath('/dashboard')).toBe('/dashboard');
    expect(safeRedirectPath('/a/b?c=d#e')).toBe('/a/b?c=d#e');
  });

  it('前后空白先 trim', () => {
    expect(safeRedirectPath('  /dash  ')).toBe('/dash');
  });
});

describe('攻击向量全部落回 fallback', () => {
  it('协议相对 //evil.com → fallback', () => {
    expect(safeRedirectPath('//evil.com')).toBe('/');
    expect(safeRedirectPath('//evil.com/x', '/login')).toBe('/login');
  });

  it('制表符前置 \\t//evil.com（浏览器会规范化成 //evil.com）→ fallback', () => {
    expect(safeRedirectPath('\t//evil.com')).toBe('/');
  });

  it('NUL / 退格控制字节混入 //evil.com → 剥掉后仍判 // 而落 fallback', () => {
    expect(safeRedirectPath('\u0000//evil.com')).toBe('/');
    expect(safeRedirectPath('\u0008//evil.com')).toBe('/');
  });

  it('DEL（\\u007f）混入路径时被剥掉（合法路径仍可用）', () => {
    expect(safeRedirectPath('/a\u007fb')).toBe('/ab');
  });

  it('http(s) 绝对地址不接受', () => {
    expect(safeRedirectPath('http://x.com/')).toBe('/');
    expect(safeRedirectPath('https://x.com/')).toBe('/');
    expect(safeRedirectPath('javascript:alert(1)')).toBe('/');
  });

  it('空值（null/undefined/空串/纯空白）→ fallback', () => {
    expect(safeRedirectPath(null)).toBe('/');
    expect(safeRedirectPath(undefined)).toBe('/');
    expect(safeRedirectPath('')).toBe('/');
    expect(safeRedirectPath('   ')).toBe('/');
  });

  it('fallback 可自定义', () => {
    expect(safeRedirectPath('//evil.com', '/home')).toBe('/home');
    expect(safeRedirectPath('x', '/home')).toBe('/home');
  });
});
