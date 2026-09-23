import { describe, it, expect } from 'vitest';
import {
  kindLabel,
  kindTagType,
  SOURCE_LABELS,
  sourceLabel,
  sourceTagType,
  verifyLabel,
  verifyTagType,
} from './modelBadges';

/**
 * modelBadges — 锁 AIChat/AIGateway 共用模型徽标纯函数的文案与标签类型映射。
 * 中文标签与 el-tag type 是面向用户的单一真源，改文案/改色先改这里。
 * 注意：本模块 SOURCE_LABELS 是「模型发现来源」域（local/remote/baseline/
 * config/user），与 useModelPivots.js 的同名常量（relay/provider/local/system
 * 目录边域）是两套值域，禁止合并。
 */

describe('kindLabel / kindTagType（模型 kind 徽标）', () => {
  it('local → 本地 / success', () => {
    expect(kindLabel('local')).toBe('本地');
    expect(kindTagType('local')).toBe('success');
  });

  it('cloud → 云端 / primary', () => {
    expect(kindLabel('cloud')).toBe('云端');
    expect(kindTagType('cloud')).toBe('primary');
  });

  it('未知 kind → 空文案 / info 兜底', () => {
    expect(kindLabel('weird')).toBe('');
    expect(kindTagType('weird')).toBe('info');
    expect(kindLabel('')).toBe('');
    expect(kindTagType(undefined)).toBe('info');
  });
});

describe('SOURCE_LABELS（模型发现来源值域）', () => {
  it('五类来源的中文标签', () => {
    expect(SOURCE_LABELS).toEqual({
      local: '实时',
      remote: '远程',
      baseline: '基线',
      config: '配置',
      user: '自定义',
    });
  });

  it('sourceLabel: 空值 → 空串，已知值 → 中文，未知值原样透出', () => {
    expect(sourceLabel('')).toBe('');
    expect(sourceLabel(null)).toBe('');
    expect(sourceLabel('local')).toBe('实时');
    expect(sourceLabel('legacy')).toBe('legacy');
  });

  it('sourceTagType: 实时/远程 绿、基线 黄、自定义 蓝、其余 灰', () => {
    expect(sourceTagType('local')).toBe('success');
    expect(sourceTagType('remote')).toBe('success');
    expect(sourceTagType('baseline')).toBe('warning');
    expect(sourceTagType('user')).toBe('primary');
    expect(sourceTagType('config')).toBe('info');
    expect(sourceTagType(undefined)).toBe('info');
  });
});

describe('verifyLabel / verifyTagType（验证状态徽标）', () => {
  it('verified → 已验证 / success', () => {
    expect(verifyLabel('verified')).toBe('已验证');
    expect(verifyTagType('verified')).toBe('success');
  });

  it('failed → 失败 / danger', () => {
    expect(verifyLabel('failed')).toBe('失败');
    expect(verifyTagType('failed')).toBe('danger');
  });

  it('其余一律 未验证 / info', () => {
    expect(verifyLabel('pending')).toBe('未验证');
    expect(verifyTagType('pending')).toBe('info');
    expect(verifyLabel(undefined)).toBe('未验证');
  });
});
