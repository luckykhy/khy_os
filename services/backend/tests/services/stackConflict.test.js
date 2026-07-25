'use strict';

/**
 * stackConflict 叶子测试 —— 「明确点名的具体栈冲突」检测 + 门控 + fail-soft。
 *
 * 覆盖:
 *   · psql vs 原型 MySQL → 冲突(dimension='persistence',requested/archetypeHas 展示名)。
 *   · 用户没提数据库 → 不冲突(旧命中行为逐字节保留)。
 *   · 同库(都归一到 postgresql)→ 不冲突。
 *   · 原型无 stack.persistence → 不冲突。
 *   · 门控 KHY_BLUEPRINT_STACK_CONFLICT_GUARD=0/off → 恒不冲突(字节回退)。
 *   · never-throw(坏输入)。
 *   · _classifyDb 归一(postgres/psql/pg 词边界/mysql/mongo/无命中)。
 */

const { detectStackConflict, stackConflictEnabled, _classifyDb } = require('../../src/services/projectBlueprint/stackConflict');

const SSM = { id: 'ssm', label: 'SSM (Spring + SpringMVC + MyBatis)', stack: { persistence: 'MyBatis + MySQL 8' } };

describe('stackConflict — _classifyDb 数据库族归一', () => {
  test('postgres 家族的各写法都归一到 postgresql', () => {
    for (const w of ['PostgreSQL', 'postgres', 'psql', 'use postgre', 'pgsql']) {
      expect(_classifyDb(w).family).toBe('postgresql');
    }
  });
  test('独立词 pg 命中(词边界),但 pgadmin 之类子串不误伤成别的', () => {
    expect(_classifyDb('数据库用 pg').family).toBe('postgresql');
    expect(_classifyDb('pg 数据库').family).toBe('postgresql');
  });
  test('mysql/mariadb→mysql，mongo→mongodb', () => {
    expect(_classifyDb('MySQL 8').family).toBe('mysql');
    expect(_classifyDb('用 MariaDB').family).toBe('mysql');
    expect(_classifyDb('mongodb 存储').family).toBe('mongodb');
  });
  test('没提数据库 → null', () => {
    expect(_classifyDb('开发一个 spring 项目')).toBeNull();
    expect(_classifyDb('')).toBeNull();
    expect(_classifyDb(null)).toBeNull();
  });
});

describe('stackConflict — detectStackConflict 冲突判定', () => {
  test('点名 psql 但原型是 MySQL → 冲突', () => {
    const r = detectStackConflict('开发一个spring项目数据库使用psql', SSM, {});
    expect(r.conflict).toBe(true);
    expect(r.requested).toBe('PostgreSQL');
    expect(r.archetypeHas).toBe('MySQL');
    expect(r.dimension).toBe('persistence');
    expect(typeof r.guidance).toBe('string');
    expect(r.guidance).toContain('PostgreSQL');
    expect(r.guidance).toContain('MySQL');
  });

  test('用户没提数据库 → 不冲突(旧行为保留)', () => {
    expect(detectStackConflict('帮我做一个SSM项目', SSM, {}).conflict).toBe(false);
    expect(detectStackConflict('spring boot 后端', SSM, {}).conflict).toBe(false);
  });

  test('点名 MySQL、原型也是 MySQL → 同库不冲突', () => {
    expect(detectStackConflict('spring mysql 后端', SSM, {}).conflict).toBe(false);
  });

  test('原型无 stack.persistence → 不冲突', () => {
    expect(detectStackConflict('要 postgres', { id: 'x', stack: {} }, {}).conflict).toBe(false);
    expect(detectStackConflict('要 postgres', { id: 'x' }, {}).conflict).toBe(false);
  });

  test('门控关(0/off)→ 恒不冲突(字节回退)', () => {
    expect(detectStackConflict('要 psql', SSM, { KHY_BLUEPRINT_STACK_CONFLICT_GUARD: '0' }).conflict).toBe(false);
    expect(detectStackConflict('要 psql', SSM, { KHY_BLUEPRINT_STACK_CONFLICT_GUARD: 'off' }).conflict).toBe(false);
    // 门控开(缺省/其它值)→ 正常判定
    expect(detectStackConflict('要 psql', SSM, {}).conflict).toBe(true);
    expect(detectStackConflict('要 psql', SSM, { KHY_BLUEPRINT_STACK_CONFLICT_GUARD: '1' }).conflict).toBe(true);
  });

  test('never-throw:坏输入一律返回 {conflict:false}', () => {
    expect(detectStackConflict(undefined, undefined, {}).conflict).toBe(false);
    expect(detectStackConflict('要 psql', null, {}).conflict).toBe(false);
    expect(detectStackConflict(123, SSM, {}).conflict).toBe(false);
  });

  test('stackConflictEnabled:CANON 词表精确', () => {
    expect(stackConflictEnabled({ KHY_BLUEPRINT_STACK_CONFLICT_GUARD: 'no' })).toBe(false);
    expect(stackConflictEnabled({ KHY_BLUEPRINT_STACK_CONFLICT_GUARD: 'false' })).toBe(false);
    expect(stackConflictEnabled({})).toBe(true);
    // EXTENDED 的 disable/disabled 不属 CANON → 视为「开」
    expect(stackConflictEnabled({ KHY_BLUEPRINT_STACK_CONFLICT_GUARD: 'disable' })).toBe(true);
  });
});
