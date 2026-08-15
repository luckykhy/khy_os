'use strict';

/**
 * modelFeatureRegistry + styleMatchers 的单元测试(Jest)。
 *
 * 重点覆盖四件事,对应任务的「特别关注」:
 *   1. 零构建   —— 直接 require 源码即可跑,无编译步骤(本文件本身就是证明)。
 *   2. 实时生效 —— 改文件后**不重启、不调 reload()**,下一次 get() 就拿到新值。
 *   3. 性能     —— 每请求 statSync 闸门的实测开销(会打印数值)。
 *   4. 向后兼容 —— 配置缺失/写坏/模型未登记,都降级返回完整画像,绝不抛错。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const flagRegistry = require('../src/services/flagRegistry');
const {
  ModelFeatureRegistry,
  isEnabled,
  makeModelFeatureRegistry,
  resolveTtlMs,
} = require('../src/services/modelFeatureRegistry');
const styles = require('../src/utils/styleMatchers');

const REPO_CONFIG = path.resolve(__dirname, '..', 'config', 'models', 'features.json');

let tmpDir = '';

function tmpFile(name) {
  return path.join(tmpDir, name);
}

function writeJson(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
}

/** 用仓库真实配置 + 一个不存在的用户覆盖文件构造实例。 */
function realRegistry(env) {
  return makeModelFeatureRegistry({
    env: Object.assign({}, env),
    filePath: REPO_CONFIG,
    homeFilePath: tmpFile('no-such-home-override.json'),
  });
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-mfr-'));
});

afterAll(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响结论 */
  }
});

describe('styleMatchers（纯叶子：零 IO / 确定性 / 不抛错）', () => {
  it('11 个能力维度全部补齐并 clamp 到 0-5', () => {
    const m = styles.normalizeCapabilityMatrix({ code: 99, reasoning: -5, bogus: 3 }, null);

    expect(Object.keys(m).sort()).toEqual(styles.CAPABILITY_DIMS.slice().sort());
    expect(m.code).toBe(5);
    expect(m.reasoning).toBe(0);
    expect(m.bogus).toBeUndefined();
    expect(m.text).toBe(3);
  });

  it('非法枚举值回退默认,不抛错', () => {
    const sp = styles.normalizeStyleProfile(
      { prompt_preference: 'MOOD', response_style: 'DIRECT', scaffolding_comfort_level: 42 },
      null
    );

    expect(sp.prompt_preference).toBe('structured');
    expect(sp.response_style).toBe('direct');
    expect(sp.scaffolding_comfort_level).toBe(10);
    expect(sp.tool_usage_tendency).toBe('balanced');
  });

  it('calculateSpecialtyMatch: 基线 0.2 / 命中强项 +0.5 / 命中弱项 -0.3 / clamp[0,1]', () => {
    const p = { specialty_areas: { strengths: ['code'], weaknesses: ['reasoning'] } };

    expect(styles.calculateSpecialtyMatch(p, 'code')).toBeCloseTo(0.7, 10);
    expect(styles.calculateSpecialtyMatch(p, 'reasoning')).toBeCloseTo(0, 10);
    expect(styles.calculateSpecialtyMatch(p, 'unheard-of-task')).toBeCloseTo(0.2, 10);
    expect(styles.calculateSpecialtyMatch(null, 'code')).toBeCloseTo(0.2, 10);
    expect(styles.calculateSpecialtyMatch(p, '')).toBeCloseTo(0.2, 10);
  });

  it('mergeProfiles 的数组语义：并集 / 追加去重 / 整体替换', () => {
    const base = {
      specialty_areas: { strengths: ['code'] },
      prompt_templates: {
        section_boost_rules: [{ id: 'a', boost: ['x'] }],
        nudge_preferences: [{ id: 'n1', text: 'old' }],
      },
      other_list: [1, 2, 3],
    };
    const out = styles.mergeProfiles(base, {
      specialty_areas: { strengths: ['reasoning', 'code'] },
      prompt_templates: {
        section_boost_rules: [{ id: 'b', boost: ['y'] }],
        nudge_preferences: [{ id: 'n1', text: 'new' }],
      },
      other_list: [9],
    });

    expect(out.specialty_areas.strengths).toEqual(['code', 'reasoning']);
    expect(out.prompt_templates.section_boost_rules.map((r) => r.id)).toEqual(['a', 'b']);
    expect(out.prompt_templates.nudge_preferences).toEqual([{ id: 'n1', text: 'new' }]);
    expect(out.other_list).toEqual([9]);
    // 不修改入参
    expect(base.other_list).toEqual([1, 2, 3]);
  });

  it('matchWhen: 空条件恒命中；未识别的条件键被忽略而非误判', () => {
    const ctx = { taskType: 'code', tier: 'T3', contextTokens: 20000, capabilities: { code: 2 } };

    expect(styles.matchWhen({}, ctx)).toBe(true);
    expect(styles.matchWhen(undefined, ctx)).toBe(true);
    expect(styles.matchWhen({ task_type: ['code', 'chat'] }, ctx)).toBe(true);
    expect(styles.matchWhen({ task_type: 'chat' }, ctx)).toBe(false);
    expect(styles.matchWhen({ context_tokens_gt: 16000 }, ctx)).toBe(true);
    expect(styles.matchWhen({ context_tokens_gt: 30000 }, ctx)).toBe(false);
    expect(styles.matchWhen({ max_capability: { code: 3 } }, ctx)).toBe(true);
    expect(styles.matchWhen({ min_capability: { code: 4 } }, ctx)).toBe(false);
    expect(styles.matchWhen({ future_condition_we_dont_know: 1 }, ctx)).toBe(true);
  });
});

describe('开关登记（默认关，父关子必关）', () => {
  it('KHY_MODEL_ADAPT 已登记为 opt-in 且默认关', () => {
    expect(flagRegistry.isFlagEnabled('KHY_MODEL_ADAPT', {})).toBe(false);
    expect(flagRegistry.isFlagEnabled('KHY_MODEL_ADAPT', { KHY_MODEL_ADAPT: '1' })).toBe(true);
    expect(isEnabled({})).toBe(false);
    expect(isEnabled({ KHY_MODEL_ADAPT: 'true' })).toBe(true);
  });

  it('总闸关 → 子门必关；总闸开 → 子门恢复各自默认', () => {
    const children = ['KHY_DYNAMIC_PROMPT', 'KHY_ENHANCED_MODEL_SELECT', 'KHY_MODEL_ADAPT_PIPELINE'];

    for (const name of children) {
      expect(flagRegistry.isFlagEnabled(name, {})).toBe(false);
      expect(flagRegistry.isFlagEnabled(name, { KHY_MODEL_ADAPT: '1' })).toBe(true);
    }

    // discovery 会真的花钱：总闸开了仍需单独 opt-in。
    expect(flagRegistry.isFlagEnabled('KHY_MODEL_DISCOVERY', { KHY_MODEL_ADAPT: '1' })).toBe(false);
    expect(
      flagRegistry.isFlagEnabled('KHY_MODEL_DISCOVERY', {
        KHY_MODEL_ADAPT: '1',
        KHY_MODEL_DISCOVERY: '1',
      })
    ).toBe(true);
  });

  it('TTL 默认 0（严格实时），可调且被 clamp', () => {
    expect(resolveTtlMs({})).toBe(0);
    expect(resolveTtlMs({ KHY_MODEL_FEATURES_TTL_MS: '2000' })).toBe(2000);
    expect(resolveTtlMs({ KHY_MODEL_FEATURES_TTL_MS: '99999999' })).toBe(3600000);
    expect(resolveTtlMs({ KHY_MODEL_FEATURES_TTL_MS: 'nonsense' })).toBe(0);
  });
});

describe('仓库真实配置的分层解析', () => {
  it('config/models/features.json 是合法 JSON 且带 $schemaVersion', () => {
    const doc = JSON.parse(fs.readFileSync(REPO_CONFIG, 'utf8'));

    expect(doc.$schemaVersion).toBe(1);
    expect(styles.isPlainObject(doc.defaults)).toBe(true);
    expect(Array.isArray(doc.patterns)).toBe(true);
  });

  it('patterns 里每条正则都能编译（写坏的正则会静默失效，必须挡在测试里）', () => {
    const doc = JSON.parse(fs.readFileSync(REPO_CONFIG, 'utf8'));

    for (const rule of doc.patterns) {
      expect(() => new RegExp(rule.match, 'i')).not.toThrow();
    }
  });

  it('完全未登记的模型也返回完整画像（不依赖静态预设）', () => {
    const reg = realRegistry();
    const p = reg.get('some-vendor/brand-new-model-v9-2027');

    expect(p).toBeTruthy();
    expect(Object.keys(p.capability_matrix).sort()).toEqual(styles.CAPABILITY_DIMS.slice().sort());
    expect(styles.PROMPT_PREFERENCES).toContain(p.style_profile.prompt_preference);
    expect(p.dynamic_params.max_tools_per_turn).toBeGreaterThan(0);
    expect(p._meta.known).toBe(false);
    expect(p._meta.tier).toMatch(/^T[0-3]$/);
    expect(p._meta.layers).toContain('defaults');
  });

  it('空 modelId 不炸，退到 T2 中庸档', () => {
    const reg = realRegistry();

    expect(reg.get('')._meta.tier).toBe('T2');
    expect(reg.get(null)._meta.modelId).toBe('');
    expect(reg.get(undefined).capability_matrix.text).toBeGreaterThanOrEqual(0);
  });

  it('家族正则命中：六大系列都拿到差异化画像', () => {
    const reg = realRegistry();
    const cases = [
      ['claude-sonnet-4-5', 'code'],
      ['deepseek-chat', 'code'],
      ['kimi-latest', 'long_context'],
      ['doubao-pro-32k', 'conversation'],
      ['glm-4-plus', 'tool_use'],
      ['gpt-4.1', 'reasoning'],
    ];

    for (const [id, expectedStrength] of cases) {
      const p = reg.get(id);

      expect(p._meta.layers.some((l) => l.startsWith('pattern:'))).toBe(true);
      expect(p.specialty_areas.strengths).toContain(expectedStrength);
    }
  });

  it('弱模型走 T3 档：脚手架强、工具保守、并发收紧', () => {
    const reg = realRegistry();
    const weak = reg.get('doubao-lite-4k');
    const strong = reg.get('claude-opus-5');

    expect(weak._meta.tier).toBe('T3');
    expect(weak.style_profile.scaffolding_comfort_level).toBeGreaterThanOrEqual(8);
    expect(weak.style_profile.tool_usage_tendency).toBe('conservative');
    expect(weak.dynamic_params.parallel_tool_allowance).toBe(1);
    // 前沿模型相反：少脚手架、多并发。
    expect(strong.style_profile.scaffolding_comfort_level).toBeLessThan(
      weak.style_profile.scaffolding_comfort_level
    );
    expect(strong.dynamic_params.max_tools_per_turn).toBeGreaterThan(
      weak.dynamic_params.max_tools_per_turn
    );
  });

  it('精确条目覆盖家族规则', () => {
    const reg = realRegistry();
    const p = reg.get('claude-opus-5');

    expect(p._meta.known).toBe(true);
    expect(p._meta.layers).toContain('models');
    expect(p.routing_priority.always_prefer_for).toContain('architecture');
    expect(p.dynamic_params.max_tools_per_turn).toBe(16);
  });

  it('精确条目的 tier 覆盖旧模型名正则,并选中对应 tierDefaults', () => {
    // modelTier 的静态表尚未认识 opus-5,直接 resolve 会落到 T2；画像里的显式 tier
    // 必须同时驱动 _meta 与 tierDefaults,不能只改显示值。
    const reg = realRegistry();
    const p = reg.get('claude-opus-5');

    expect(p._meta.tier).toBe('T0');
    expect(p._meta.layers).toContain('tierDefaults:T0');
    expect(p.style_profile.scaffolding_comfort_level).toBe(2);
    expect(p.style_profile.prompt_preference).toBe('concise');
  });

  it('配置压过推断：tierDefaults 不被 harnessProfile 静默覆盖', () => {
    // 回归守卫：曾把 harnessProfile 推断层排在 tierDefaults 之后，导致配置里
    // 写的 tier 级 prompt_preference 永远失效（sonnet 配 structured 却拿到 detailed）。
    const reg = realRegistry();
    const p = reg.get('claude-sonnet-4-5');

    expect(p._meta.tier).toBe('T1');
    expect(p.style_profile.prompt_preference).toBe('structured');
    expect(p._meta.layers.indexOf('harnessProfile')).toBeLessThan(
      p._meta.layers.indexOf('tierDefaults:T1')
    );
  });

  it('describeModelFeatures 输出可读摘要且不抛错', () => {
    const reg = realRegistry();
    const text = reg.describeModelFeatures('claude-sonnet-4-5');

    expect(text).toContain('tier=');
    expect(text).toContain('layers=');
    // 恶意入参（toString 自身抛错）也只降级，不冒泡异常。
    const hostile = {
      toString() {
        throw new Error('boom');
      },
    };

    expect(() => reg.describeModelFeatures(hostile)).not.toThrow();
    expect(typeof reg.describeModelFeatures(hostile)).toBe('string');
    expect(() => reg.get(hostile)).not.toThrow();
    expect(reg.get(hostile)._meta.modelId).toBe('');
  });
});

describe('实时生效（零重启、零构建）', () => {
  it('改文件保存后，下一次 get() 直接看到新值（不调用 reload、不重启）', () => {
    const file = tmpFile('live.json');

    writeJson(file, {
      $schemaVersion: 1,
      defaults: { capability_matrix: { code: 1 } },
      models: { 'live-model': { style_profile: { prompt_preference: 'concise' } } },
    });

    const reg = makeModelFeatureRegistry({
      env: {},
      filePath: file,
      homeFilePath: tmpFile('none.json'),
    });

    expect(reg.get('live-model').capability_matrix.code).toBe(1);
    expect(reg.get('live-model').style_profile.prompt_preference).toBe('concise');

    // ——— 运维在这里编辑了配置文件并保存 ———
    writeJson(file, {
      $schemaVersion: 1,
      defaults: { capability_matrix: { code: 5 } },
      models: {
        'live-model': {
          style_profile: { prompt_preference: 'detailed', scaffolding_comfort_level: 9 },
        },
      },
    });

    const after = reg.get('live-model');

    expect(after.capability_matrix.code).toBe(5);
    expect(after.style_profile.prompt_preference).toBe('detailed');
    expect(after.style_profile.scaffolding_comfort_level).toBe(9);
  });

  it('文件长度不变、只有 mtime 变化时也能感知', () => {
    const file = tmpFile('same-size.json');
    const mk = (score) => ({ $schemaVersion: 1, defaults: { capability_matrix: { code: score } } });

    writeJson(file, mk(1));

    const reg = makeModelFeatureRegistry({
      env: {},
      filePath: file,
      homeFilePath: tmpFile('none.json'),
    });

    expect(reg.get('x').capability_matrix.code).toBe(1);

    writeJson(file, mk(4));
    // 显式把 mtime 推后 1 秒，模拟"长度相同"的编辑（本用例里长度本来就相同）。
    const st = fs.statSync(file);

    fs.utimesSync(file, st.atime, new Date(st.mtimeMs + 1000));

    expect(reg.get('x').capability_matrix.code).toBe(4);
  });

  it('连续两次「同长度」编辑也不会被漏掉（mtime 太新则不信任 stat 闸门）', () => {
    // 这是实测抓到过的真实缺陷：两次写入长度相同且落在同一个文件系统时间戳刻度里，
    // 纯 mtime+size 闸门会判定"没变"而沿用过期配置。修法见 MTIME_TRUST_MS。
    const file = tmpFile('same-tick.json');
    const mk = (score) => ({ $schemaVersion: 1, defaults: { capability_matrix: { code: score } } });

    writeJson(file, mk(1));

    const reg = makeModelFeatureRegistry({
      env: {},
      filePath: file,
      homeFilePath: tmpFile('none.json'),
    });

    expect(reg.get('x').capability_matrix.code).toBe(1);

    for (const score of [2, 3, 4, 5]) {
      writeJson(file, mk(score)); // 长度恒定、间隔极短
      expect(reg.get('x').capability_matrix.code).toBe(score);
    }
  });

  it('内容没变（仅被 touch）不会触发无谓的重新合并', () => {
    const file = tmpFile('touch-only.json');

    writeJson(file, { $schemaVersion: 1, defaults: { capability_matrix: { code: 3 } } });

    const reg = makeModelFeatureRegistry({
      env: {},
      filePath: file,
      homeFilePath: tmpFile('none.json'),
    });

    reg.get('x');

    const gen = reg.getStatus().generation;
    const st = fs.statSync(file);

    fs.utimesSync(file, st.atime, new Date(st.mtimeMs + 5000));
    reg.get('x');

    expect(reg.getStatus().generation).toBe(gen);
    expect(reg.getStatus().repo.loads).toBe(1);
  });

  it('TTL > 0 时在窗口内缓存，reload() 可强制立即生效', () => {
    const file = tmpFile('ttl.json');
    let clock = 1000;

    writeJson(file, { $schemaVersion: 1, defaults: { capability_matrix: { code: 1 } } });

    const reg = makeModelFeatureRegistry({
      env: { KHY_MODEL_FEATURES_TTL_MS: '60000' },
      filePath: file,
      homeFilePath: tmpFile('none.json'),
      now: () => clock,
    });

    expect(reg.get('x').capability_matrix.code).toBe(1);

    writeJson(file, { $schemaVersion: 1, defaults: { capability_matrix: { code: 5 } } });

    // 时钟未推进 → 仍在 TTL 窗口内 → 看到旧值（这是 TTL 的定义，不是 bug）。
    expect(reg.get('x').capability_matrix.code).toBe(1);

    // HTTP 热重载端点走的就是这条路径。
    const status = reg.reload({ reason: 'http-endpoint' });

    expect(status.lastReload.reason).toBe('http-endpoint');
    expect(reg.get('x').capability_matrix.code).toBe(5);

    // 时钟推过 TTL 后自然生效。
    writeJson(file, { $schemaVersion: 1, defaults: { capability_matrix: { code: 2 } } });
    clock += 60001;
    expect(reg.get('x').capability_matrix.code).toBe(2);
  });
});

describe('向后兼容与降级（绝不因配置问题让请求失败）', () => {
  it('配置文件完全不存在 → 仍返回完整画像', () => {
    const reg = makeModelFeatureRegistry({
      env: {},
      filePath: tmpFile('absent-a.json'),
      homeFilePath: tmpFile('absent-b.json'),
    });
    const p = reg.get('claude-sonnet-4-5');

    expect(p.capability_matrix.text).toBeGreaterThanOrEqual(0);
    expect(p.style_profile.scaffolding_comfort_level).toBeGreaterThanOrEqual(1);
    expect(reg.getStatus().repo.exists).toBe(false);
  });

  it('JSON 写坏 → 沿用上一份好数据 + getStatus 报错，不抛异常', () => {
    const file = tmpFile('broken.json');

    writeJson(file, { $schemaVersion: 1, defaults: { capability_matrix: { code: 4 } } });

    const reg = makeModelFeatureRegistry({
      env: {},
      filePath: file,
      homeFilePath: tmpFile('none.json'),
    });

    expect(reg.get('x').capability_matrix.code).toBe(4);

    fs.writeFileSync(file, '{ this is not json', 'utf8');

    expect(() => reg.get('x')).not.toThrow();
    expect(reg.get('x').capability_matrix.code).toBe(4); // 上一份好数据仍在生效
    expect(reg.getStatus().repo.error).toBeTruthy();
    expect(reg.getStatus().counters.parseErrors).toBeGreaterThan(0);

    // 修好之后自动恢复，不需要重启。
    writeJson(file, { $schemaVersion: 1, defaults: { capability_matrix: { code: 2 } } });
    expect(reg.get('x').capability_matrix.code).toBe(2);
    expect(reg.getStatus().repo.error).toBeNull();
  });

  it('patterns 里有写坏的正则 → 跳过该条，其余规则照常生效', () => {
    const file = tmpFile('bad-regex.json');

    writeJson(file, {
      $schemaVersion: 1,
      patterns: [
        { id: 'broken', match: '([unclosed', features: { capability_matrix: { code: 0 } } },
        { id: 'good', match: 'zzz', features: { capability_matrix: { code: 5 } } },
      ],
    });

    const reg = makeModelFeatureRegistry({
      env: {},
      filePath: file,
      homeFilePath: tmpFile('none.json'),
    });

    expect(reg.get('zzz-1').capability_matrix.code).toBe(5);
    expect(reg.get('zzz-1')._meta.layers).toContain('pattern:good');
  });

  it('内联 env JSON 优先级最高；写坏时被忽略而非崩溃', () => {
    const file = tmpFile('inline-base.json');

    writeJson(file, { $schemaVersion: 1, models: { m1: { capability_matrix: { code: 1 } } } });

    const ok = makeModelFeatureRegistry({
      env: { KHY_MODEL_FEATURES_JSON: JSON.stringify({ models: { m1: { capability_matrix: { code: 5 } } } }) },
      filePath: file,
      homeFilePath: tmpFile('none.json'),
    });

    expect(ok.get('m1').capability_matrix.code).toBe(5);
    expect(ok.get('m1')._meta.layers).toContain('inline:models');

    const bad = makeModelFeatureRegistry({
      env: { KHY_MODEL_FEATURES_JSON: '{oops' },
      filePath: file,
      homeFilePath: tmpFile('none.json'),
    });

    expect(bad.get('m1').capability_matrix.code).toBe(1);
  });

  it('用户主目录覆盖压过仓库配置，运行时覆盖再压过它', () => {
    const repo = tmpFile('layer-repo.json');
    const home = tmpFile('layer-home.json');

    writeJson(repo, { $schemaVersion: 1, models: { m2: { capability_matrix: { code: 1 } } } });
    writeJson(home, { models: { m2: { capability_matrix: { code: 3 } } } });

    const reg = makeModelFeatureRegistry({ env: {}, filePath: repo, homeFilePath: home });

    expect(reg.get('m2').capability_matrix.code).toBe(3);

    expect(reg.saveTemporarily('m2', { capability_matrix: { code: 5 } }, { note: 'A/B 探测' })).toBe(
      true
    );
    expect(reg.get('m2').capability_matrix.code).toBe(5);
    expect(reg.get('m2').confidence).toBe('low');
    expect(reg.listTemporary()[0].note).toBe('A/B 探测');

    expect(reg.clearTemporary('m2')).toBe(true);
    expect(reg.get('m2').capability_matrix.code).toBe(3);
  });

  it('saveTemporarily 拒绝非法入参且不抛错', () => {
    const reg = realRegistry();

    expect(reg.saveTemporarily('', { a: 1 })).toBe(false);
    expect(reg.saveTemporarily('m', null)).toBe(false);
    expect(reg.saveTemporarily(null, {})).toBe(false);
    expect(reg.clearTemporary('never-saved')).toBe(false);
  });

  it('ModelFeatureRegistry 可直接 new（无隐藏初始化步骤，零构建）', () => {
    expect(() => new ModelFeatureRegistry()).not.toThrow();
    expect(new ModelFeatureRegistry().getStatus().generation).toBe(0);
  });
});

describe('性能：每请求解析开销', () => {
  it('TTL=0（每次 statSync）下的单次 get() 开销可忽略', () => {
    const reg = realRegistry();
    const N = 2000;

    reg.get('claude-sonnet-4-5'); // 预热，排除首次读盘

    const t0 = process.hrtime.bigint();

    for (let i = 0; i < N; i += 1) {
      reg.get('claude-sonnet-4-5');
    }

    const perCallUs = Number(process.hrtime.bigint() - t0) / 1000 / N;
    const status = reg.getStatus();

    // 每次 get 都走了 stat 闸门（2 个文件层 × N 次）。
    expect(status.counters.statCalls).toBeGreaterThanOrEqual(N * 2);
    // 命中已解析缓存，没有重复合并画像。
    expect(status.counters.cacheHits).toBeGreaterThanOrEqual(N - 1);
    // 阈值取得很宽松（含 Windows 文件系统抖动）；真实数值打印出来供 PR 记录。
    expect(perCallUs).toBeLessThan(1000);

    process.stdout.write(
      `[perf] modelFeatureRegistry.get() TTL=0: ${perCallUs.toFixed(1)} µs/次 ` +
        `(${N} 次，statCalls=${status.counters.statCalls})\n`
    );
  });

  it('TTL>0 时不再 stat，开销降为纯内存查表', () => {
    const reg = realRegistry({ KHY_MODEL_FEATURES_TTL_MS: '60000' });

    reg.get('claude-sonnet-4-5');

    const before = reg.getStatus().counters.statCalls;

    for (let i = 0; i < 500; i += 1) {
      reg.get('claude-sonnet-4-5');
    }

    expect(reg.getStatus().counters.statCalls).toBe(before);
  });
});
