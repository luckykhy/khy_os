/**
 * Unit tests for the zero-dependency data-curation pipeline
 * (shingle dedup + DEITA scoring + train/val split + response similarity)
 * used by exportDataset and the multi-teacher distill path.
 */
const dc = require('../dataCuration');

const rec = (instruction, output) => ({ instruction, output, type: 'conversation' });

describe('dataCuration', () => {
  it('shingles produces a bounded unique N-gram set', () => {
    const s = dc.shingles('abcde', 2);
    expect(s).toEqual(['ab', 'bc', 'cd', 'de']);
    // whitespace is collapsed before shingling
    expect(dc.shingles('a  b', 2)).toEqual(dc.shingles('a b', 2));
  });

  it('jaccard of identical sets is 1, disjoint is 0', () => {
    expect(dc.jaccard(['a', 'b'], ['a', 'b'])).toBe(1);
    expect(dc.jaccard(['a'], ['b'])).toBe(0);
    expect(dc.jaccard([], ['a'])).toBe(0);
  });

  it('shingleDedupe drops near-duplicates and keeps the first occurrence', () => {
    const rs = [
      rec('什么是夏普比率', '夏普比率衡量每单位风险的超额收益。'),
      rec('什么是夏普比率', '夏普比率衡量每单位风险的超额收益。'), // exact dup
      rec('请写一个快速排序', 'def quick_sort(a): ...'), // different topic
    ];
    const { kept, dropped, report } = dc.shingleDedupe(rs, { threshold: 0.6 });
    expect(kept.length).toBe(2);
    expect(dropped.length).toBe(1);
    expect(dropped[0].index).toBe(1); // the exact dup is dropped
    expect(report.dropped).toBe(1);
  });

  it('deitaScore rewards complex, dense responses over short ones', () => {
    const simple = dc.deitaScore(rec('hi', '好的。'));
    const complex = dc.deitaScore(
      rec(
        '写代码',
        '```python\ndef f(x):\n    if x > 1:\n        return x * 0.5\n    return x * 2\n```\n夏普比率 2.5%, 年化波动率 18%'
      )
    );
    // complexity axis: code blocks + keywords + percentages must dominate a bare reply
    expect(complex.complexity).toBeGreaterThan(simple.complexity);
    // combined DEITA score (0.4 weight on complexity) should also be higher
    expect(complex.score).toBeGreaterThan(simple.score);
  });

  it('deitaScore diversity axis measures novelty vs. a baseline', () => {
    const novelty = new Set(dc.shingles('完全相同的文本内容重复重复重复'));
    const dup = dc.deitaScore(rec('完全相同的文本内容重复重复重复', '完全相同的文本内容重复重复重复'), novelty);
    const fresh = dc.deitaScore(rec('一段全新的不同话题内容', '另一段全新的不同话题内容'), novelty);
    expect(fresh.diversity).toBeGreaterThan(dup.diversity);
  });

  it('trainValSplit returns null val below minSize', () => {
    const rs = Array.from({ length: 5 }, (_, i) => ({ __score: i }));
    const { train, val } = dc.trainValSplit(rs, { minSize: 20 });
    expect(val).toBeNull();
    expect(train.length).toBe(5);
  });

  it('trainValSplit puts the top-scored samples in the val set', () => {
    const rs = Array.from({ length: 100 }, (_, i) => ({ __score: i, i }));
    const { train, val } = dc.trainValSplit(rs, { valRatio: 0.1, minSize: 20 });
    expect(val.length).toBe(10);
    expect(train.length).toBe(90);
    // val should hold the highest-scoring samples
    expect(Math.min(...val.map((r) => r.__score))).toBeGreaterThan(
      Math.max(...train.map((r) => r.__score))
    );
  });

  it('curateDataset dedups, scores, and splits in one call', () => {
    const rs = [
      rec('问题 A 什么是波动率', '波动率是标准差化的收益率。'),
      rec('问题 A 什么是波动率', '波动率是标准差化的收益率。'),
      rec('问题 B 写一个函数', '```js\nfunction add(a,b){return a+b}\n```'),
    ];
    const { train, val, report } = dc.curateDataset(rs, { minSize: 0 });
    expect(report.dedup.kept).toBe(2);
    expect(report.dedup.dropped).toBe(1);
    expect(report.qualityBuckets.high + report.qualityBuckets.mid + report.qualityBuckets.low).toBe(2);
    // below minSize for a meaningful val, both land in train
    expect(train.length + (val ? val.length : 0)).toBe(2);
  });

  it('responseSimilarity is high for near-identical teacher responses', () => {
    // Use longer, near-identical texts so shingle Jaccard is meaningful.
    const a = '夏普比率等于投资组合超额收益除以该组合收益率的标准差，数值越高代表风险调整后收益越好，一般以大于 1 为较优。';
    const b = '夏普比率等于投资组合超额收益除以该组合收益率的标准差，数值越高代表风险调整后收益越好，通常以大于 1 为较优。';
    const c = '今天天气不错，适合出去散步，顺便买点菜回来做晚饭。';
    const simAB = dc.responseSimilarity(a, b);
    const simAC = dc.responseSimilarity(a, c);
    expect(simAB).toBeGreaterThan(simAC); // near-dup beats unrelated topic
    expect(simAB).toBeGreaterThan(0.3); // absolute floor sanity check
  });
});
