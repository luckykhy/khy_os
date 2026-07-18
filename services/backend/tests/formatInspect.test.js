'use strict';

/**
 * formatInspect.test.js — 文件格式精确识别 + 文本精确定位替换 的红线测试。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const det = require('../src/services/formatInspect/fileFormatDetector');
const ta = require('../src/services/formatInspect/textAddress');

describe('fileFormatDetector — 扩展名画像', () => {
  test('代码扩展名映射正确（含 .moon/.mbt/.java/.c/.cpp）', () => {
    assert.equal(det.fromExtension('.c').language, 'c');
    assert.equal(det.fromExtension('.cpp').language, 'cpp');
    assert.equal(det.fromExtension('.java').language, 'java');
    assert.equal(det.fromExtension('.moon').language, 'moonbit');
    assert.equal(det.fromExtension('.mbt').language, 'moonbit');
    assert.equal(det.fromExtension('.cpp').category, 'code');
  });
  test('文档扩展名映射（md/docx/pdf）', () => {
    assert.equal(det.fromExtension('.md').format, 'markdown');
    assert.equal(det.fromExtension('.docx').format, 'docx');
    assert.equal(det.fromExtension('.pdf').format, 'pdf');
    assert.equal(det.fromExtension('.md').category, 'document');
  });
  test('未登记扩展名 → unknown', () => {
    assert.equal(det.fromExtension('.zzz').format, 'unknown');
  });
});

describe('fileFormatDetector — 魔数嗅探', () => {
  test('PDF 魔数', () => {
    const buf = Buffer.from('%PDF-1.7\n...', 'latin1');
    assert.equal(det.detectByMagic(buf).format, 'pdf');
  });
  test('PNG 魔数', () => {
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.equal(det.detectByMagic(buf).format, 'png');
  });
  test('docx：zip + wordprocessingml 标识', () => {
    const buf = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.from('....[Content_Types].xml....word/document.xml....', 'latin1'),
    ]);
    assert.equal(det.detectByMagic(buf).format, 'docx');
  });
  test('裸 zip（无 OOXML 标识）→ zip', () => {
    const buf = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('foo.txt', 'latin1')]);
    assert.equal(det.detectByMagic(buf).format, 'zip');
  });
  test('纯文本 → 魔数 null', () => {
    assert.equal(det.detectByMagic(Buffer.from('hello world', 'utf8')), null);
  });
});

describe('fileFormatDetector — 调和扩展名与内容', () => {
  test('.txt 实为 PDF → mismatch 标记，且以真实格式为准', () => {
    const buf = Buffer.from('%PDF-1.4 fake-named-txt', 'latin1');
    const r = det.detectBuffer(buf, 'report.txt');
    assert.equal(r.format, 'pdf');
    assert.equal(r.confidence, 'magic');
    assert.equal(r.mismatch, true);
    assert.equal(r.extFormat, 'text');
    assert.equal(r.magicFormat, 'pdf');
  });
  test('.docx 命名 + docx 内容 → 不算 mismatch', () => {
    const buf = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('word/document.xml', 'latin1')]);
    const r = det.detectBuffer(buf, 'a.docx');
    assert.equal(r.format, 'docx');
    assert.equal(r.mismatch, false);
  });
  test('.c 源码（无魔数）→ 按扩展名，confidence=extension', () => {
    const r = det.detectBuffer(Buffer.from('int main(){return 0;}', 'utf8'), 'main.c');
    assert.equal(r.format, 'c');
    assert.equal(r.confidence, 'extension');
    assert.equal(r.isBinary, false);
  });
  test('isBinary：含 NUL', () => {
    assert.equal(det.looksBinary(Buffer.from([0x41, 0x00, 0x42])), true);
    assert.equal(det.looksBinary(Buffer.from('plain text', 'utf8')), false);
  });
});

describe('textAddress — 段落/句子偏移保真切分', () => {
  const doc = '第一段第一句。第一段第二句。\n\n第二段第一句话。第二段第二句话。第二段第三句。';
  test('段落切分', () => {
    const ps = ta.splitParagraphs(doc);
    assert.equal(ps.length, 2);
    assert.ok(ps[1].text.startsWith('第二段第一句'));
    // 偏移保真：用区间还原即原文片段
    assert.equal(doc.slice(ps[0].start, ps[0].end), '第一段第一句。第一段第二句。');
  });
  test('句子切分（CJK 句号边界，保留标点）', () => {
    const ps = ta.splitParagraphs(doc);
    const sents = ta.splitSentences(doc.slice(ps[1].start, ps[1].end), ps[1].start);
    assert.equal(sents.length, 3);
    assert.equal(sents[1].text, '第二段第二句话。');
    assert.equal(doc.slice(sents[1].start, sents[1].end), '第二段第二句话。');
  });
  test('西文小数不被误切', () => {
    const sents = ta.splitSentences('Pi is 3.14 today. Next one.');
    assert.equal(sents.length, 2);
    assert.equal(sents[0].text, 'Pi is 3.14 today.');
  });
});

describe('textAddress — 精确定位替换（核心诉求）', () => {
  // 「值」出现 4 次；要求只替换第二段第二句里的那个
  const doc = '系统的值很重要。值不能丢。\n\n第二段提到值的概念。这里的值需要被替换。最后再说值。';

  test('按「第二段第二句」精确替换，仅动目标处', () => {
    const r = ta.replaceAtLocation(doc, { paragraph: 2, sentence: 2, word: '值', replacement: 'VALUE' });
    assert.equal(r.ok, true);
    assert.equal(r.replaced, 1);
    // 目标句被替换
    assert.ok(r.text.includes('这里的VALUE需要被替换'));
    // 其它出现保持不变
    assert.ok(r.text.includes('系统的值很重要'));
    assert.ok(r.text.includes('值不能丢'));
    assert.ok(r.text.includes('第二段提到值的概念'));
    assert.ok(r.text.includes('最后再说值'));
    // 全文只多了一个 VALUE，值从 5 个减为 4 个
    assert.equal((r.text.match(/值/g) || []).length, 4);
    assert.equal((r.text.match(/VALUE/g) || []).length, 1);
  });

  test('段范围 occurrence=2：替换该段第 2 次出现', () => {
    const r = ta.replaceAtLocation(doc, { paragraph: 2, word: '值', occurrence: 2, replacement: 'X' });
    assert.equal(r.ok, true);
    assert.equal(r.replaced, 1);
    assert.ok(r.text.includes('这里的X需要'));
  });

  test('occurrence="all" 仅在范围内全替', () => {
    const r = ta.replaceAtLocation(doc, { paragraph: 1, word: '值', occurrence: 'all', replacement: 'V' });
    assert.equal(r.replaced, 2);
    // 第二段不动
    assert.ok(r.text.includes('第二段提到值的概念'));
  });

  test('词不在该位置：报错并提示全文出现次数', () => {
    const r = ta.replaceAtLocation(doc, { paragraph: 1, sentence: 1, word: '不存在词', replacement: 'x' });
    assert.equal(r.ok, false);
    assert.ok(/未找到/.test(r.error));
  });

  test('词在别处但不在该句：明确提示', () => {
    const r = ta.replaceAtLocation(doc, { paragraph: 1, sentence: 2, word: '系统', replacement: 'x' });
    assert.equal(r.ok, false);
    assert.ok(/全文共出现/.test(r.hint));
  });

  test('段越界报错带可用段数', () => {
    const r = ta.replaceAtLocation(doc, { paragraph: 9, word: '值', replacement: 'x' });
    assert.equal(r.ok, false);
    assert.equal(r.available.paragraphs, 2);
  });

  test('occurrence 超范围报错', () => {
    const r = ta.replaceAtLocation(doc, { paragraph: 2, word: '值', occurrence: 99, replacement: 'x' });
    assert.equal(r.ok, false);
    assert.equal(r.available.inScope, 3);
  });

  test('locateWord 列出每次出现的段/句坐标', () => {
    const locs = ta.locateWord(doc, '值');
    assert.equal(locs.length, 5);
    assert.deepEqual(locs[2], { paragraph: 2, sentence: 1, occurrenceInSentence: 1, offset: locs[2].offset });
  });
});

describe('fileFormatDetector — 纵深防卡死（非普通文件不挂起）', () => {
  const fs = require('node:fs');

  test('detectFile 遇字符设备 /dev/null（非普通文件）→ 免费 fstat 判型后即退空缓冲，绝不 readSync', () => {
    if (process.platform === 'win32') return; // /dev/null 是 POSIX 概念
    let st;
    try { st = fs.statSync('/dev/null'); } catch (_) { return; } // 环境无 /dev/null → 跳过
    assert.equal(st.isFile(), false, '前提：/dev/null 是字符设备而非普通文件');
    // openSync('/dev/null') 立即成功、fstat 立即成功；加固后 _readHeadTail 在 !isFile() 分支即
    // 退回空缓冲，绝不对设备节点/socket 等「open 成功但 read 可阻塞」的类型发起 readSync。
    const res = det.detectFile('/dev/null');
    assert.equal(res.size, 0, '非普通文件应报告空内容（buf 为空）');
    assert.equal(res.path, '/dev/null');
    // 普通文件路径逐字节等价：常规 .md 仍正常识别（与既有用例互为对照）。
    assert.equal(det.fromExtension('.md').format, 'markdown');
  });
});
