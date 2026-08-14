'use strict';

/**
 * projectBlueprint 引擎测试 —— 不变量驱动（对照 diskCleanup「判别不变量而非脆弱数值」）。
 *
 * 核心断言是「里程碑无损覆盖脚手架文件树」与「短窗口下切片不超额」：
 *   1. catalog 能加载原型与概念卡；ssm 关联到存在的脚手架模板。
 *   2. 关键不变量：每个原型所有里程碑的 files 之并集 == 关联模板的全部文件，
 *      且恰好覆盖一次（无遗漏、无重复）——否则会漏建或重复建文件。
 *   3. 匹配：「做一个SSM项目」→ ssm 原型；「讲讲DDD」→ ddd 概念卡。
 *   4. plan 是有序里程碑目录（不含文件正文）。
 *   5. milestoneSlice：任何窗口下渲染文本 ≤ deriveToolResultCap(window)；短窗口更紧。
 *   6. 每张概念卡必填字段齐、触发词能命中自身。
 *   7. scaffold 委派 renderTemplate，输出 scaffoldFiles 兼容(directories/files[{path,content}])。
 *   8. ProjectBlueprintTool 全模式只读；各 mode 的 execute 返回成功。
 */

const fs = require('fs');
const path = require('path');

const catalog = require('../src/services/projectBlueprint/catalog');
const planner = require('../src/services/projectBlueprint/milestonePlanner');
const blueprint = require('../src/services/projectBlueprint');
const contextProfile = require('../src/services/contextProfile');
const projectTemplateService = require('../src/services/projectTemplateService');

beforeEach(() => {
  catalog._resetCache();
  projectTemplateService.clearCache();
});

describe('projectBlueprint — catalog 加载与关联', () => {
  test('加载到原型与概念卡', () => {
    const archetypes = catalog.listArchetypes();
    const concepts = catalog.listConcepts();
    expect(archetypes.length).toBeGreaterThanOrEqual(1);
    expect(concepts.length).toBeGreaterThanOrEqual(15);
    // ssm 原型存在
    expect(catalog.getArchetype('ssm')).toBeTruthy();
  });

  test('每个原型都关联到一个存在的脚手架模板', () => {
    for (const a of catalog.listArchetypes()) {
      const tmpl = catalog.templateFor(a);
      expect(tmpl).toBeTruthy();
      expect(tmpl.name).toBe(a.templateName);
    }
  });
});

describe('projectBlueprint — 里程碑无损覆盖不变量', () => {
  test('每个原型：里程碑 files 并集 == 模板全部文件，恰好覆盖一次', () => {
    for (const a of catalog.listArchetypes()) {
      const templateFiles = catalog.templateFiles(a).slice().sort();
      expect(templateFiles.length).toBeGreaterThan(0);

      const milestoneFiles = [];
      for (const m of a.milestones || []) {
        for (const f of m.files || []) milestoneFiles.push(f);
      }

      // 无重复
      const uniq = new Set(milestoneFiles);
      expect(uniq.size).toBe(milestoneFiles.length); // 没有任何文件被分到两个里程碑

      // 并集恰等于模板文件全集（无遗漏、无多余）
      expect([...uniq].sort()).toEqual(templateFiles);

      // 每个里程碑的 files 都是模板文件子集
      const templateSet = new Set(templateFiles);
      for (const f of milestoneFiles) {
        expect(templateSet.has(f)).toBe(true);
      }
    }
  });
});

describe('projectBlueprint — 匹配', () => {
  test('目标文本命中可构建原型', () => {
    expect(catalog.matchArchetype('帮我做一个SSM项目').id).toBe('ssm');
    expect(catalog.matchArchetype('spring boot mybatis 后端').id).toBe('ssm');
    const m = blueprint.match('做一个SSM项目');
    expect(m.kind).toBe('archetype');
    expect(m.match.id).toBe('ssm');
  });

  test('目标文本命中概念卡', () => {
    expect(catalog.matchConcept('讲讲DDD领域驱动').id).toBe('ddd');
    expect(catalog.matchConcept('什么是 RAG').id).toBe('rag');
    const m = blueprint.match('解释一下CQRS');
    expect(m.kind).toBe('concept');
    expect(m.match.id).toBe('cqrs');
  });

  test('原型优先于概念命中', () => {
    // "SSM" 是原型触发词，不该被概念抢走
    const m = blueprint.match('SSM');
    expect(m.kind).toBe('archetype');
  });

  test('栈冲突守卫：点名 psql 但唯一 Spring 原型是 MySQL → 降级 kind:none + reference 软指针', () => {
    // 会话现场根因：ssm 触发词经模板含宽泛 "spring boot"，模型把目标归一成 "spring boot postgresql"
    // → 命中 ssm(MySQL)。守卫开时应降级为 none(模板不领跑)，但把 ssm 作为「仅结构参考」交回。
    const m = blueprint.match('spring boot postgresql');
    expect(m.kind).toBe('none');
    expect(m.match).toBeNull();
    expect(m.conflict).toBeDefined();
    expect(m.conflict.requested).toBe('PostgreSQL');
    expect(m.conflict.archetypeHas).toBe('MySQL');
    expect(m.reference).toBeDefined();
    expect(m.reference.id).toBe('ssm');
    expect(typeof m.guidance).toBe('string');
    expect(m.guidance).toContain('PostgreSQL');
  });

  test('栈冲突守卫：未点名数据库的 spring 请求不受影响（仍命中 ssm）', () => {
    const m = blueprint.match('做一个SSM项目');
    expect(m.kind).toBe('archetype');
    expect(m.match.id).toBe('ssm');
  });

  test('栈冲突守卫关（KHY_BLUEPRINT_STACK_CONFLICT_GUARD=0）→ 逐字节回退旧命中', () => {
    const prev = process.env.KHY_BLUEPRINT_STACK_CONFLICT_GUARD;
    process.env.KHY_BLUEPRINT_STACK_CONFLICT_GUARD = '0';
    try {
      const m = blueprint.match('spring boot postgresql');
      expect(m.kind).toBe('archetype');
      expect(m.match.id).toBe('ssm');
    } finally {
      if (prev === undefined) delete process.env.KHY_BLUEPRINT_STACK_CONFLICT_GUARD;
      else process.env.KHY_BLUEPRINT_STACK_CONFLICT_GUARD = prev;
    }
  });
});

describe('projectBlueprint — plan 里程碑目录', () => {
  test('plan 给有序里程碑、含文件名但不含正文', () => {
    const p = blueprint.plan('ssm');
    expect(p.ok).toBe(true);
    expect(p.total).toBe(p.milestones.length);
    expect(p.milestones[0].index).toBe(0);
    // 目录里只有文件名，没有 content 字段
    for (const m of p.milestones) {
      expect(Array.isArray(m.files)).toBe(true);
      expect(m).not.toHaveProperty('content');
    }
    // ASCII 报告可渲染
    expect(typeof blueprint.renderPlanReport(p)).toBe('string');
  });

  test('未知原型返回错误', () => {
    expect(blueprint.plan('nonexistent-xyz').ok).toBe(false);
  });
});

describe('projectBlueprint — milestoneSlice 短上下文收紧', () => {
  test('任何窗口下渲染文本不超过 deriveToolResultCap', () => {
    const a = catalog.getArchetype('ssm');
    for (let i = 0; i < (a.milestones || []).length; i++) {
      for (const win of [0, 8000, 16000, 200000]) {
        const slice = planner.milestoneSlice(a, i, { contextWindow: win });
        expect(slice.ok).toBe(true);
        const cap = contextProfile.deriveToolResultCap(win, catalog.thresholds.defaultSliceChars);
        expect(slice.charBudget).toBe(cap);
        expect(slice.text.length).toBeLessThanOrEqual(cap);
        // 最小必要信息恒在
        expect(slice.title).toBeTruthy();
        expect(Array.isArray(slice.files)).toBe(true);
      }
    }
  });

  test('短窗口的预算严格小于大窗口', () => {
    const small = contextProfile.deriveToolResultCap(8000, catalog.thresholds.defaultSliceChars);
    const large = contextProfile.deriveToolResultCap(200000, catalog.thresholds.defaultSliceChars);
    expect(small).toBeLessThan(large);
  });

  test('越界序号返回错误', () => {
    const a = catalog.getArchetype('ssm');
    expect(planner.milestoneSlice(a, 999, {}).ok).toBe(false);
  });
});

describe('projectBlueprint — 概念卡完整性', () => {
  test('每张概念卡必填字段齐、触发词能命中自身', () => {
    const concepts = catalog.listConcepts();
    expect(concepts.length).toBeGreaterThanOrEqual(15);
    for (const c of concepts) {
      expect(c.id).toBeTruthy();
      expect(c.name).toBeTruthy();
      expect(c.summary && c.summary.length).toBeGreaterThan(10);
      expect(Array.isArray(c.triggers)).toBe(true);
      expect(c.triggers.length).toBeGreaterThan(0);
      expect(Array.isArray(c.whenToUse)).toBe(true);
      expect(Array.isArray(c.antiPatterns)).toBe(true);
      expect(typeof c.minimalSkeleton).toBe('string');
      // summary 体积护栏：保持「按需取小片」
      expect(c.summary.length).toBeLessThanOrEqual(catalog.thresholds.conceptSummaryMaxChars);
      // 用自身名字能匹配回来
      expect(catalog.matchConcept(c.name)).toBeTruthy();
    }
  });

  test('facade.concept 返回完整卡片结构', () => {
    const c = blueprint.concept('lora');
    expect(c.ok).toBe(true);
    expect(c.id).toBe('lora');
    expect(c.minimalSkeleton).toBeTruthy();
  });
});

describe('projectBlueprint — scaffold 兼容 scaffoldFiles', () => {
  test('scaffold(ssm) 输出 directories + files[{path,content}]', () => {
    const s = blueprint.scaffold('ssm', { variables: { groupId: 'com.acme', artifactId: 'shop' } });
    expect(s.ok).toBe(true);
    expect(Array.isArray(s.directories)).toBe(true);
    expect(Array.isArray(s.files)).toBe(true);
    expect(s.files.length).toBeGreaterThan(0);
    for (const f of s.files) {
      expect(typeof f.path).toBe('string');
      expect(typeof f.content).toBe('string');
    }
    // 变量渲染生效：groupPath 派生、占位符已替换
    const app = s.files.find((f) => f.path.endsWith('Application.java'));
    expect(app.path).toContain('com/acme');
    expect(app.content).toContain('package com.acme');
  });

  test('scaffold 文件集与里程碑覆盖的原始文件一一对应(数量一致)', () => {
    const a = catalog.getArchetype('ssm');
    const milestoneFileCount = (a.milestones || []).reduce((n, m) => n + (m.files || []).length, 0);
    const s = blueprint.scaffold('ssm', {});
    expect(s.files.length).toBe(milestoneFileCount);
  });
});

describe('ProjectBlueprintTool — 只读与各模式', () => {
  const Tool = require('../src/tools/ProjectBlueprintTool');
  const t = new Tool();

  test('全模式只读、非破坏', () => {
    expect(t.isReadOnly({ mode: 'scaffold' })).toBe(true);
    expect(t.isReadOnly({ mode: 'milestone' })).toBe(true);
    expect(t.isDestructive({ mode: 'scaffold' })).toBe(false);
  });

  test('catalog/match/plan/milestone/concept/scaffold 各 execute 成功', async () => {
    expect((await t.execute({ mode: 'catalog' })).success).toBe(true);

    const matched = await t.execute({ mode: 'match', target: '做个SSM项目' });
    expect(matched.success).toBe(true);
    expect(matched.kind).toBe('archetype');

    const plan = await t.execute({ mode: 'plan', target: 'ssm' });
    expect(plan.success).toBe(true);
    expect(typeof plan.report).toBe('string');

    const ms = await t.execute({ mode: 'milestone', target: 'ssm', index: 0, contextWindow: 8000 });
    expect(ms.success).toBe(true);
    expect(ms.text.length).toBeLessThanOrEqual(ms.charBudget);

    const concept = await t.execute({ mode: 'concept', target: 'rag' });
    expect(concept.success).toBe(true);
    expect(concept.id).toBe('rag');

    const scaffold = await t.execute({ mode: 'scaffold', target: 'ssm', variables: { artifactId: 'x' } });
    expect(scaffold.success).toBe(true);
    expect(Array.isArray(scaffold.files)).toBe(true);
  });

  test('工具经注册表可被发现', () => {
    const registry = require('../src/tools');
    registry.loadTools && registry.loadTools();
    expect(registry.get('ProjectBlueprint')).toBeTruthy();
  });
});
