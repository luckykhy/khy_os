'use strict';

/**
 * weipuxiezuo 引擎测试 —— 不变量驱动（对照 contextDiagnostics「健康会话零假阳性」）。
 *
 * 核心断言不是「某段分数恰好=N」（脆弱），而是方法论的**判别不变量**：
 *   1. AI 模板文（文档改写前样例）AIGC 高分、判不合格、命中多模式。
 *   2. 人类化用文（文档改写后样例）AIGC 低分、学术达标、gate 通过。
 *   3. 干净的人类口语短句零假阳性（不被误判为 AI）。
 *   4. 模式定位准确（理论起笔/段末套句/三元并列/泛化结尾/模糊归因）。
 *   5. 模糊归因有邻近真实引用时不再判命中。
 *   6. mode=full 强制 15 篇引用；fragment 不判引用不足。
 *   7. 分数确定性：同输入多次调用结果恒定。
 */

const path = require('path');
const ROOT = path.join(__dirname, '..', 'src', 'services', 'weipuxiezuo');
const weipu = require(path.join(ROOT, 'index'));
const detector = require(path.join(ROOT, 'detector'));
const textStats = require(path.join(ROOT, 'textStats'));
const rules = require(path.join(ROOT, 'rules'));

const AI_TEMPLATE = '本研究基于框架理论对新媒体环境下的政治传播进行了深入探讨。依据框架理论，媒体通过选择和强调特定信息，引导受众对政治议题形成特定认知。该方案基于三重考量：首先，现有数据库覆盖范围有限，难以支撑全面分析；其次，人工标注成本较高，不适合大规模研究；再次，算法偏差问题不容忽视。研究表明，框架效应在短视频平台尤为显著。综上所述，本研究具有重要的理论意义，为后续研究提供了新的思路，未来可期。';

const HUMAN_REWRITE = '政治传播研究里，框架理论算是一个成熟的分析工具，但它在短视频平台上的适用性，此前少有人认真检验过。Entman（1993）最初提出框架概念时，面对的是传统大众媒体的语境，那时没人能预见算法分发会如何重塑信息的选择与强调机制。笔者在抓取了三个月的抖音政治类短视频后发现，平台的推荐逻辑本身就是一层隐形的框架——它先于编辑的选择，决定了哪些议题能进入用户视野。\n\n结果有一处让笔者意外：抖音的情感框架比例远高于微博，差距比预期大得多。回头想想，短视频的叙事逻辑本来就依赖情绪调动，没有情感钩子的内容根本传不出去，这倒也说得通。';

const CLEAN_HUMAN = '昨天下了一整天雨，我没带伞，回家路上淋得透湿。到家先冲了个热水澡，又煮了碗面，整个人才缓过来。窗外的雨还在下，倒也不急着出门了。';

describe('weipuxiezuo · 判别不变量', () => {
  beforeEach(() => rules._resetCache());

  test('AI 模板文：AIGC 高分 + 判不合格 + 多模式命中', () => {
    const { scores, detection, gate } = weipu.analyze(AI_TEMPLATE, { mode: 'fragment' });
    expect(scores.aigc.score).toBeGreaterThan(rules.thresholds.aigcPass);
    expect(scores.aigc.pass).toBe(false);
    expect(detection.findings.length).toBeGreaterThanOrEqual(4);
    expect(gate.pass).toBe(false);
  });

  test('人类化用文：AIGC 低分 + 学术达标 + gate 通过', () => {
    const { scores, gate } = weipu.analyze(HUMAN_REWRITE, { mode: 'fragment' });
    expect(scores.aigc.pass).toBe(true);
    expect(scores.aigc.score).toBeLessThanOrEqual(rules.thresholds.aigcPass);
    expect(scores.academic.pass).toBe(true);
    expect(gate.pass).toBe(true);
  });

  test('AI 模板文 AIGC 明显高于人类化用文（判别力）', () => {
    const a = weipu.analyze(AI_TEMPLATE).scores.aigc.score;
    const b = weipu.analyze(HUMAN_REWRITE).scores.aigc.score;
    expect(a - b).toBeGreaterThan(25);
  });

  test('干净人类口语短句：零假阳性（不误判为 AI）', () => {
    const { detection, scores } = weipu.analyze(CLEAN_HUMAN, { mode: 'fragment' });
    expect(detection.totals.weighted).toBe(0);
    expect(scores.aigc.pass).toBe(true);
  });
});

describe('weipuxiezuo · 模式定位', () => {
  beforeEach(() => rules._resetCache());

  const ids = (text) => detector.detect(text).findings.map((f) => f.id);

  test('理论起笔（模式1）命中且 theoryOpenerRatio>0', () => {
    const d = detector.detect('依据建构主义理论，知识是社会协商的产物。');
    expect(d.findings.some((f) => f.id === 1)).toBe(true);
    expect(d.totals.theoryOpenerRatio).toBeGreaterThan(0);
  });

  test('段末套句（模式2/7）命中且标 atEnd', () => {
    const d = detector.detect('译者选择了意译。此案例印证了目的论的核心观点。');
    const f2 = d.findings.find((f) => f.id === 2);
    expect(f2).toBeTruthy();
    expect(f2.matches[0].atEnd).toBe(true);
  });

  test('三元并列编号链（模式3）命中', () => {
    expect(ids('方案有三重考量：首先，数据有限；其次，成本太高；再次，偏差明显。')).toContain(3);
  });

  test('泛化结尾（模式10）命中且 gate 泛化结尾不为 0', () => {
    const d = detector.detect('本研究意义深远，为后续工作提供了新的思路，前景广阔。');
    expect(d.findings.some((f) => f.id === 10)).toBe(true);
  });

  test('模糊归因（模式8）：无引用时命中', () => {
    expect(ids('研究表明，社交媒体加剧了信息茧房。')).toContain(8);
  });

  test('模糊归因（模式8）：邻近有真实引用时不命中', () => {
    const withCite = '研究表明（Sunstein, 2017），社交媒体加剧了信息茧房。';
    expect(ids(withCite)).not.toContain(8);
  });
});

describe('weipuxiezuo · 统计与节奏', () => {
  test('CV（突发性）：均一句长 → 低 CV', () => {
    const uniform = '我吃了饭。我看了书。我睡了觉。我起了床。';
    const cv = textStats.compute(uniform).rhythm.cv;
    expect(cv).toBeLessThan(0.2);
  });

  test('CV：长短交错 → 较高 CV', () => {
    const varied = '行。今天我去了很远的地方办了一件拖了很久始终没能解决的麻烦事。累。';
    const cv = textStats.compute(varied).rhythm.cv;
    expect(cv).toBeGreaterThan(0.3);
  });

  test('naturalLength 剥离加粗/角标/URL', () => {
    const n = textStats.naturalLength('这是**重点**内容<sup>[1]</sup>见 https://a.com/x 链接');
    // 仅「这是重点内容见链接」计入（标记与 URL 不计）
    expect(n).toBe('这是重点内容见链接'.length);
  });
});

describe('weipuxiezuo · 引用约束（mode 相关）', () => {
  beforeEach(() => rules._resetCache());

  test('mode=full：引用不足 15 篇 → citationCount 不过', () => {
    const text = '这是一段没有足够引用的全文。研究有结论<sup>[1]</sup>。';
    const { gate } = weipu.analyze(text, { mode: 'full' });
    const item = gate.items.find((it) => it.key === 'citationCount');
    expect(item.pass).toBe(false);
    expect(gate.failedKeys).toContain('citationCount');
  });

  test('mode=fragment：1-2 处角标不判引用不足（advisory）', () => {
    const text = '一个片段，含一处角标<sup>[1]</sup>，正常。';
    const { gate } = weipu.analyze(text, { mode: 'fragment' });
    const item = gate.items.find((it) => it.key === 'citationCount');
    expect(item.advisory).toBe(true);
    expect(gate.failedKeys).not.toContain('citationCount');
  });
});

describe('weipuxiezuo · 确定性与门面契约', () => {
  test('同输入多次调用：分数恒定', () => {
    const a = weipu.analyze(AI_TEMPLATE);
    const b = weipu.analyze(AI_TEMPLATE);
    expect(a.scores.aigc.score).toBe(b.scores.aigc.score);
    expect(a.scores.academic.score).toBe(b.scores.academic.score);
  });

  test('analyze 返回完整契约字段', () => {
    const r = weipu.analyze(AI_TEMPLATE);
    expect(r).toHaveProperty('mode');
    expect(r).toHaveProperty('detection');
    expect(r).toHaveProperty('scores');
    expect(r).toHaveProperty('gate');
    expect(r).toHaveProperty('brief');
    expect(r).toHaveProperty('report');
    expect(typeof r.report).toBe('string');
    expect(r.brief.tasks.length).toBeGreaterThan(0);
  });

  test('brief：高优先级任务排在前', () => {
    const { brief } = weipu.analyze(AI_TEMPLATE);
    const firstHigh = brief.tasks.findIndex((t) => t.priority === rules.PRIORITY.HIGH);
    const firstLow = brief.tasks.findIndex((t) => t.priority === rules.PRIORITY.LOW);
    if (firstHigh !== -1 && firstLow !== -1) expect(firstHigh).toBeLessThan(firstLow);
  });

  test('空文本：analyze 不抛，findings 为空', () => {
    const r = weipu.analyze('');
    expect(r.detection.findings.length).toBe(0);
    expect(r.scores.aigc.score).toBe(0);
  });
});

describe('WeipuRewriteTool · 工具契约', () => {
  const WeipuRewriteTool = require(path.join(__dirname, '..', 'src', 'tools', 'WeipuRewriteTool'));

  test('静态元信息正确（只读/safe/analysis）', () => {
    expect(WeipuRewriteTool.toolName).toBe('WeipuRewrite');
    expect(WeipuRewriteTool.category).toBe('analysis');
    expect(WeipuRewriteTool.risk).toBe('safe');
    expect(new WeipuRewriteTool().isReadOnly()).toBe(true);
  });

  test('execute(view=report)：返回 passed + report', async () => {
    const t = new WeipuRewriteTool();
    const r = await t.execute({ text: AI_TEMPLATE, view: 'report' });
    expect(r.success).toBe(true);
    expect(r.passed).toBe(false);
    expect(typeof r.report).toBe('string');
  });

  test('execute(view=full)：含 findings + gate + brief', async () => {
    const t = new WeipuRewriteTool();
    const r = await t.execute({ text: AI_TEMPLATE, view: 'full' });
    expect(Array.isArray(r.findings)).toBe(true);
    expect(Array.isArray(r.gate)).toBe(true);
    expect(r.brief).toBeTruthy();
  });

  test('execute：空文本返回 success=false', async () => {
    const t = new WeipuRewriteTool();
    const r = await t.execute({ text: '   ' });
    expect(r.success).toBe(false);
  });
});
