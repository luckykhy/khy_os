'use strict';

/**
 * dynamicPromptAssembler 单元测试(Jest)。
 *
 * 覆盖任务书 Goal 2 的四个承诺:
 *   1. 每请求现场装配 —— 同一个模型在不同请求上拿到**不同**的提示词。
 *   2. 零构建 / 实时可修改 —— 改 style_templates.js 存盘后,下一次调用即生效(不重启)。
 *   3. 差异化 —— 强模型少脚手架、弱模型多脚手架;boost/suppress 规则真的生效。
 *   4. 向后兼容 —— 门控关 = appendix 为空串(拼接结果逐字节不变);写坏配置只降级不抛错。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const assembler = require('../src/services/dynamicPromptAssembler');
const { makeModelFeatureRegistry } = require('../src/services/modelFeatureRegistry');

const ON = { KHY_MODEL_ADAPT: '1' };
const REPO_CONFIG = path.resolve(__dirname, '..', 'config', 'models', 'features.json');

let tmpDir = '';

function tmpFile(name) {
  return path.join(tmpDir, name);
}

/** 用仓库真实 features.json(或指定文件)构造 registry。 */
function registryFor(filePath) {
  return makeModelFeatureRegistry({
    env: {},
    filePath: filePath || REPO_CONFIG,
    homeFilePath: tmpFile('no-home-override.json'),
  });
}

function assemble(ctx) {
  return assembler.assemblePromptForModel(
    Object.assign({ env: ON, registry: registryFor() }, ctx)
  );
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-dpa-'));
});

afterAll(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响结论 */
  }
});

describe('门控与向后兼容', () => {
  it('门控关 → inert 结果,appendix 为空串(拼接后逐字节不变)', () => {
    const r = assembler.assemblePromptForModel({ env: {}, modelId: 'claude-sonnet-4-5' });

    expect(r.meta.enabled).toBe(false);
    expect(r.meta.degraded).toBe('flag-off');
    expect(r.sections).toEqual([]);
    expect(r.tailoredNudges).toEqual([]);
    expect(r.appendix).toBe('');
    expect(r.scaffoldingLevel).toBeNull();
  });

  it('总闸开 → 启用;子门单独关掉仍然回退', () => {
    expect(assembler.isEnabled(ON)).toBe(true);
    expect(assembler.isEnabled({})).toBe(false);
    expect(assembler.isEnabled({ KHY_MODEL_ADAPT: '1', KHY_DYNAMIC_PROMPT: '0' })).toBe(false);
  });

  it('恶意 / 缺省入参都不抛错', () => {
    expect(() => assembler.assemblePromptForModel()).not.toThrow();
    expect(() => assembler.assemblePromptForModel(null)).not.toThrow();
    expect(() => assemble({ modelId: null, contextTokens: NaN, taskType: 42 })).not.toThrow();

    const hostile = {
      toString() {
        throw new Error('boom');
      },
    };

    expect(() => assemble({ modelId: hostile })).not.toThrow();
    expect(typeof assembler.describeAssembly({ env: ON, modelId: 'x' })).toBe('string');
  });
});

describe('每请求差异化(同模型不同请求 → 不同提示词)', () => {
  it('用户偏好 concise vs detailed → 段落文案与数量都不同', () => {
    const lean = assemble({ modelId: 'doubao-lite-4k', userPreference: 'concise' });
    const rich = assemble({ modelId: 'doubao-lite-4k', userPreference: 'detailed' });

    expect(lean.meta.promptPreference).toBe('concise');
    expect(rich.meta.promptPreference).toBe('detailed');
    expect(lean.scaffoldingLevel).toBeLessThan(rich.scaffoldingLevel);
    expect(lean.appendix).not.toBe(rich.appendix);
    expect(lean.appendix.length).toBeLessThan(rich.appendix.length);
  });

  it('不带工具时不注入工具相关段落', () => {
    const withTools = assemble({ modelId: 'glm-4-plus', hasTools: true });
    const noTools = assemble({ modelId: 'glm-4-plus', hasTools: false });
    const ids = (r) => r.sections.map((s) => s.id);

    expect(ids(withTools)).toContain('tool_protocol');
    expect(ids(noTools)).not.toContain('tool_protocol');
    expect(ids(noTools)).not.toContain('safety_reminders');
  });

  it('长上下文触发导航段落,并收紧工具并发', () => {
    const short = assemble({ modelId: 'kimi-latest', contextTokens: 2000 });
    const long = assemble({ modelId: 'kimi-latest', contextTokens: 120000 });

    expect(short.sections.map((s) => s.id)).not.toContain('long_context_navigation');
    expect(long.sections.map((s) => s.id)).toContain('long_context_navigation');
    expect(long.dynamicParams.parallel_tool_allowance).toBeLessThanOrEqual(
      short.dynamicParams.parallel_tool_allowance
    );
  });

  it('任务命中强项 → 脚手架下调;命中弱项 → 上调', () => {
    const reg = registryFor();

    reg.saveTemporarily('probe-model', {
      style_profile: { scaffolding_comfort_level: 5 },
      specialty_areas: { strengths: ['code'], weaknesses: ['reasoning'] },
    });

    const base = { env: ON, registry: reg, modelId: 'probe-model' };
    const good = assembler.assemblePromptForModel(Object.assign({}, base, { taskType: 'code' }));
    const bad = assembler.assemblePromptForModel(
      Object.assign({}, base, { taskType: 'reasoning' })
    );

    expect(good.scaffoldingLevel).toBeLessThan(bad.scaffoldingLevel);
    expect(bad.meta.steps.some((s) => s.step === 'calibrateScaffolding')).toBe(true);
  });

  it('未显式传 taskType 时按关键词表推断', () => {
    const r = assemble({ modelId: 'gpt-4.1', userText: '这个函数报错了，帮我排查一下 traceback' });

    expect(r.meta.steps[1].step).toBe('analyzeTask');
    expect(r.meta.steps[1].inferred).toBe(true);
    expect(['debug', 'code']).toContain(r.taskType);

    // 推断不出来 → conversation,不猜。
    expect(assembler.inferTaskType('', {})).toBe('');
    expect(assemble({ modelId: 'gpt-4.1', userText: '你好' }).taskType).toBe('conversation');
  });
});

describe('强弱模型差异化', () => {
  // 注意用 claude-opus-4-5 而不是 -5:modelTier 的表还不认识 opus-5,resolveTier 给它 T2。
  // 这正好说明配置层的价值(features.json 里的精确条目照样给它前沿参数),但要验证
  // 「T0 档位行为」就必须用一个真的解析成 T0 的 id。见报告里的 modelTier 缺口一条。
  const T0_MODEL = 'claude-opus-4-5';

  it('T3 弱模型比 T0 前沿模型拿到更多脚手架', () => {
    const weak = assemble({ modelId: 'doubao-lite-4k', taskType: 'code' });
    const strong = assemble({ modelId: T0_MODEL, taskType: 'code' });

    expect(weak.tier).toBe('T3');
    expect(strong.tier).toBe('T0');
    expect(weak.scaffoldingLevel).toBeGreaterThan(strong.scaffoldingLevel);
    expect(weak.sections.length).toBeGreaterThanOrEqual(strong.sections.length);
    expect(weak.appendix.length).toBeGreaterThan(strong.appendix.length);
  });

  it('T0 的 harnessProfile.nudges=false → 本轮不发即时提醒', () => {
    const strong = assemble({ modelId: T0_MODEL });

    expect(strong.tailoredNudges).toEqual([]);
  });

  it('弱模型拿到高强度兜底提醒', () => {
    const reg = registryFor();

    reg.saveTemporarily('very-weak', { style_profile: { scaffolding_comfort_level: 10 } });

    const r = assembler.assemblePromptForModel({ env: ON, registry: reg, modelId: 'very-weak' });

    expect(r.scaffoldingLevel).toBeGreaterThanOrEqual(8);
    expect(r.tailoredNudges.join(' ')).toContain('验证');
  });
});

describe('boost / suppress 规则', () => {
  it('suppress 砍段落、boost 强制保留(无视 minScaffolding)', () => {
    const reg = registryFor();

    reg.saveTemporarily('rule-model', {
      style_profile: { scaffolding_comfort_level: 2, prompt_preference: 'structured' },
      prompt_templates: {
        section_boost_rules: [
          { id: 'force-examples', boost: ['examples'] },
          { id: 'drop-format', suppress: ['output_format'] },
        ],
      },
    });

    const r = assembler.assemblePromptForModel({ env: ON, registry: reg, modelId: 'rule-model' });
    const ids = r.sections.map((s) => s.id);

    // examples 的 minScaffolding=7,等级只有 2,靠 boost 才能进来。
    expect(ids).toContain('examples');
    expect(ids).not.toContain('output_format');
    expect(r.meta.steps.find((s) => s.step === 'applyBoostRules').boosted).toContain('examples');
    expect(r.meta.steps.find((s) => s.step === 'applyBoostRules').suppressed).toContain(
      'output_format'
    );
  });

  it('规则的 when 条件按任务类型生效', () => {
    const reg = registryFor();

    reg.saveTemporarily('cond-model', {
      prompt_templates: {
        section_boost_rules: [
          { id: 'only-code', when: { task_type: 'code' }, boost: ['self_check'] },
        ],
      },
    });

    const hit = assembler.assemblePromptForModel({
      env: ON,
      registry: reg,
      modelId: 'cond-model',
      taskType: 'code',
    });
    const miss = assembler.assemblePromptForModel({
      env: ON,
      registry: reg,
      modelId: 'cond-model',
      taskType: 'creative',
    });

    // 断言 reason 而不是 rulesApplied:配置里的 tierDefaults 本身也带 boost 规则,
    // 计数会把它们算进去。reason 能精确指认「是我这条规则让它进来的」。
    expect(hit.sections.find((s) => s.id === 'self_check').reason).toBe('boost:only-code');

    const missSelfCheck = miss.sections.find((s) => s.id === 'self_check');

    expect(missSelfCheck === undefined || missSelfCheck.reason !== 'boost:only-code').toBe(true);
  });

  it('同一段落同时被 boost 与 suppress → suppress 胜(明确关闭的意图优先)', () => {
    const reg = registryFor();

    reg.saveTemporarily('conflict-model', {
      prompt_templates: {
        section_boost_rules: [
          { id: 'a', boost: ['self_check'] },
          { id: 'b', suppress: ['self_check'] },
        ],
      },
    });

    const r = assembler.assemblePromptForModel({
      env: ON,
      registry: reg,
      modelId: 'conflict-model',
    });

    expect(r.sections.map((s) => s.id)).not.toContain('self_check');
  });

  it('稳定前缀已提供的段落默认不重复输出，被 boost 时才输出', () => {
    const plain = assemble({ modelId: 'glm-4-plus' });

    expect(plain.sections.map((s) => s.id)).not.toContain('coding_standards');

    const reg = registryFor();

    reg.saveTemporarily('dup-model', {
      prompt_templates: { section_boost_rules: [{ id: 'r', boost: ['coding_standards'] }] },
    });

    const boosted = assembler.assemblePromptForModel({
      env: ON,
      registry: reg,
      modelId: 'dup-model',
    });

    expect(boosted.sections.map((s) => s.id)).toContain('coding_standards');
  });

  it('画像里的 system_overview 成品文案优先于目录里的变体', () => {
    const reg = registryFor();

    reg.saveTemporarily('custom-overview', {
      style_profile: { prompt_preference: 'concise' },
      prompt_templates: {
        system_overview: { concise_version: '只说结论，不解释。' },
      },
    });

    const r = assembler.assemblePromptForModel({
      env: ON,
      registry: reg,
      modelId: 'custom-overview',
    });

    expect(r.sections.find((s) => s.id === 'system_overview').body).toBe('只说结论，不解释。');
  });
});

describe('段落预算(体积控制)', () => {
  it('脚手架等级越低,注入段落越少', () => {
    const reg = registryFor();

    reg.saveTemporarily('lvl-low', { style_profile: { scaffolding_comfort_level: 1 } });
    reg.saveTemporarily('lvl-high', { style_profile: { scaffolding_comfort_level: 10 } });

    const low = assembler.assemblePromptForModel({ env: ON, registry: reg, modelId: 'lvl-low' });
    const high = assembler.assemblePromptForModel({ env: ON, registry: reg, modelId: 'lvl-high' });

    expect(low.sections.length).toBeLessThanOrEqual(assembler.SECTION_BUDGET[low.scaffoldingLevel]);
    expect(low.sections.length).toBeLessThan(high.sections.length);
  });

  it('nudge 条数封顶', () => {
    const reg = registryFor();

    reg.saveTemporarily('many-nudges', {
      prompt_templates: {
        nudge_preferences: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
      },
    });

    const r = assembler.assemblePromptForModel({ env: ON, registry: reg, modelId: 'many-nudges' });

    expect(r.tailoredNudges.length).toBeLessThanOrEqual(assembler.MAX_NUDGES);
  });
});

describe('style_templates.js 实时可修改(零构建、零重启)', () => {
  const writeTemplates = (file, body) => {
    fs.writeFileSync(
      file,
      `'use strict';\nmodule.exports = ${JSON.stringify(body, null, 2)};\n`,
      'utf8'
    );
  };

  it('改模板文件存盘后,下一次装配即生效', () => {
    const file = tmpFile('tpl-live.js');

    writeTemplates(file, {
      SECTION_CATALOG: [
        { id: 'only_one', title: '第一版', priority: 50, minScaffolding: 0, variants: { structured: '原始正文' } },
      ],
      DEFAULT_NUDGES: {},
      HIGH_SCAFFOLD_NUDGES: [],
      TASK_KEYWORDS: {},
    });

    const env = { KHY_MODEL_ADAPT: '1', KHY_STYLE_TEMPLATES_FILE: file };
    const ctx = { env, registry: registryFor(), modelId: 'glm-4-plus' };
    const before = assembler.assemblePromptForModel(ctx);

    expect(before.sections.map((s) => s.id)).toEqual(['only_one']);
    expect(before.appendix).toContain('原始正文');

    // ——— 运维在这里编辑了模板文件并保存 ———
    writeTemplates(file, {
      SECTION_CATALOG: [
        { id: 'only_one', title: '第二版', priority: 50, minScaffolding: 0, variants: { structured: '改过的正文' } },
        { id: 'brand_new', title: '新增段落', priority: 40, minScaffolding: 0, variants: { structured: '这段是新加的' } },
      ],
      DEFAULT_NUDGES: {},
      HIGH_SCAFFOLD_NUDGES: [],
      TASK_KEYWORDS: {},
    });

    const after = assembler.assemblePromptForModel(ctx);

    expect(after.sections.map((s) => s.id)).toEqual(['only_one', 'brand_new']);
    expect(after.appendix).toContain('改过的正文');
    expect(after.appendix).toContain('这段是新加的');
    expect(after.appendix).not.toContain('原始正文');
  });

  it('模板文件写坏 → 沿用上一份好数据 + 记录错误,不抛错', () => {
    const file = tmpFile('tpl-broken.js');

    writeTemplates(file, {
      SECTION_CATALOG: [
        { id: 'keep_me', title: '保留', priority: 50, minScaffolding: 0, variants: { structured: '好数据' } },
      ],
      DEFAULT_NUDGES: {},
      HIGH_SCAFFOLD_NUDGES: [],
      TASK_KEYWORDS: {},
    });

    const env = { KHY_MODEL_ADAPT: '1', KHY_STYLE_TEMPLATES_FILE: file };
    const ctx = { env, registry: registryFor(), modelId: 'glm-4-plus' };

    expect(assembler.assemblePromptForModel(ctx).appendix).toContain('好数据');

    fs.writeFileSync(file, 'module.exports = { this is not valid javascript', 'utf8');

    expect(() => assembler.assemblePromptForModel(ctx)).not.toThrow();

    const degraded = assembler.assemblePromptForModel(ctx);

    expect(degraded.appendix).toContain('好数据');
    expect(degraded.meta.templatesError).toBeTruthy();

    // 修好后自动恢复。
    writeTemplates(file, {
      SECTION_CATALOG: [
        { id: 'fixed', title: '修好了', priority: 50, minScaffolding: 0, variants: { structured: '新好数据' } },
      ],
      DEFAULT_NUDGES: {},
      HIGH_SCAFFOLD_NUDGES: [],
      TASK_KEYWORDS: {},
    });

    expect(assembler.assemblePromptForModel(ctx).appendix).toContain('新好数据');
  });

  it('模板文件不存在 → 退回内置目录,请求照常', () => {
    const env = { KHY_MODEL_ADAPT: '1', KHY_STYLE_TEMPLATES_FILE: tmpFile('nope.js') };
    const r = assembler.assemblePromptForModel({
      env,
      registry: registryFor(),
      modelId: 'glm-4-plus',
    });

    expect(r.meta.enabled).toBe(true);
    expect(r.sections.length).toBeGreaterThan(0);
    expect(assembler.getTemplatesStatus().error).toBeTruthy();
  });

  it('仓库自带的 style_templates.js 结构合法', () => {
    const t = assembler.loadTemplates({});

    expect(Array.isArray(t.SECTION_CATALOG)).toBe(true);
    expect(t.SECTION_CATALOG.length).toBeGreaterThan(0);

    for (const def of t.SECTION_CATALOG) {
      expect(typeof def.id).toBe('string');
      expect(def.id.trim().length).toBeGreaterThan(0);
      // 至少要有一个非空变体,否则这段永远渲染不出来。
      expect(Object.values(def.variants).some((v) => typeof v === 'string' && v.trim())).toBe(true);
    }
  });
});

describe('纯函数步骤单测', () => {
  it('analyzeTask 归一各字段', () => {
    const t = assembler.analyzeTask({ contextTokens: 20000, userPreference: 'CONCISE' }, {});

    expect(t.taskType).toBe('conversation');
    expect(t.contextTokens).toBe(20000);
    expect(t.longContext).toBe(true);
    expect(t.hasTools).toBe(true);
    expect(t.userPreference).toBe('concise');
    expect(assembler.analyzeTask({ userPreference: 'nonsense' }, {}).userPreference).toBe('');
  });

  it('calibrateScaffolding 的加减项可解释且被 clamp 到 0-10', () => {
    const profile = {
      style_profile: { scaffolding_comfort_level: 9 },
      specialty_areas: { strengths: [], weaknesses: ['code'] },
    };
    const out = assembler.calibrateScaffolding(
      profile,
      { taskType: 'code', longContext: true, userPreference: 'detailed' },
      { promptVerbosity: 'full' }
    );

    expect(out.level).toBe(10);
    expect(out.adjustments.map((a) => a.by)).toContain('taskInWeaknesses');

    const lean = assembler.calibrateScaffolding(profile, { taskType: '' }, {
      promptVerbosity: 'lean',
      shortContext: true,
    });

    expect(lean.level).toBe(4);
  });

  it('selectSections 丢掉结构不合法的条目', () => {
    const out = assembler.selectSections(
      [null, {}, { id: '  ' }, { id: 'ok', priority: 'x', minScaffolding: 99 }],
      {}
    );

    expect(out.map((s) => s.id)).toEqual(['ok']);
    expect(out[0].priority).toBe(50);
    expect(out[0].minScaffolding).toBe(10);
  });

  it('renderAppendix 无内容时返回空串', () => {
    expect(assembler.renderAppendix({ sections: [], tailoredNudges: [] })).toBe('');
    expect(assembler.renderAppendix(null)).toBe('');
    expect(assembler.renderAppendix({ sections: [{ id: 'a', title: 'A', body: 'x' }] })).toContain(
      '## A'
    );
  });
});
