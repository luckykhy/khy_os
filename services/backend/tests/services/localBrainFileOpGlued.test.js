'use strict';
/**
 * localBrainFileOpGlued �?file_op 粘连连接符自然中文形单测(node:test,确定�?�?
 *
 * 缺口:「把 X 移到 Y」「把 X 复制�?Y」「将 X 拷贝�?Y」此前在所有层(file_op
 * �?cooperative:false)都返�?NULL �?只出兜底菜单,�?KHY 自家 describeApis 广告示例
 * 「把 a.txt 移到 backup/」都不命中。根�?_FILE_OP_RE 要求连接符「到/�?至」前有空�?
 * 而自然中文里「移�?移动�?复制�?拷贝到」连接符与动词粘连�?
 *
 * 本测试锁�?
 *   - 粘连形被识别�?file_op,�?copy/move 判定正确;
 *   - 既有「移�?X �?Y�?空格分隔连接�?路径行为不变;
 *   - 门控 KHY_FILE_OP_GLUED=off �?粘连形字节回退�?NULL(与历史一�?;
 *   - �?localBrainService Tier-1 注册表分�?file_op �?cooperative:false,有无模型都拦�?�?
 */
const lb = require('../../src/services/localBrainService');
function detect(text, opts) {
  return lb.detectDeterministic(text, opts || {});
}

describe('Local Brain File Op Glued', () => {
  test('粘连连接�?�?�?X 移到/移动�?复制�?拷贝�?Y �?file_op,copy/move 判定正确', () => {
      const cwd = '/tmp/fo-test';
      const move = detect('�?a.txt 移到 backup/', { cwd });
      expect(move && move.type === 'file_op').toBeTruthy();
      expect(move.op).toBe('move');
    
      const move2 = detect('�?a.txt 移动�?backup/', { cwd });
      expect(move2 && move2.type === 'file_op').toBeTruthy();
      expect(move2.op).toBe('move');
    
      const copy = detect('�?a.txt 复制�?backup/', { cwd });
      expect(copy && copy.type === 'file_op').toBeTruthy();
      expect(copy.op).toBe('copy');
    
      const copy2 = detect('�?x.log 拷贝�?logs/', { cwd });
      expect(copy2 && copy2.type === 'file_op').toBeTruthy();
      expect(copy2.op).toBe('copy');
  });

  test('既有空格分隔连接符形为不�?回归保护)', () => {
      const cwd = '/tmp/fo-test';
      const m = detect('移动 a.txt �?backup/', { cwd });
      expect(m && m.type === 'file_op').toBeTruthy();
      expect(m.op).toBe('move');
    
      const c = detect('复制 a.txt �?b.txt', { cwd });
      expect(c && c.type === 'file_op').toBeTruthy();
      expect(c.op).toBe('copy');
    
      const r = detect('重命�?a.txt �?b.txt', { cwd });
      expect(r && r.type === 'file_op').toBeTruthy();
      expect(r.op).toBe('rename');
  });

  test('门控 KHY_FILE_OP_GLUED=off �?粘连形字节回退�?NULL', () => {
      const prev = process.env.KHY_FILE_OP_GLUED;
      try {
        process.env.KHY_FILE_OP_GLUED = 'off';
        expect(detect('�?a.txt 移到 backup/', { cwd: '/tmp/fo-test' })).toBe(null);
        // 但既有空格分隔形不受门控影响,仍命�?
        const m = detect('移动 a.txt �?backup/', { cwd: '/tmp/fo-test' });
        expect(m && m.type === 'file_op').toBeTruthy();
        // 默认(未设�?�?开
        delete process.env.KHY_FILE_OP_GLUED;
        const g = detect('�?a.txt 移到 backup/', { cwd: '/tmp/fo-test' });
        expect(g && g.type === 'file_op').toBeTruthy();
      } finally {
        if (prev === undefined) delete process.env.KHY_FILE_OP_GLUED;
        else process.env.KHY_FILE_OP_GLUED = prev;
      }
  });

  test('src/dest 解析:dest �?/ 结尾保留原文件名', () => {
      const plan = detect('�?a.txt 移到 backup/', { cwd: '/tmp/fo-test' });
      expect(plan.dest.endsWith('/backup/a.txt') || plan.dest.endsWith('\\backup\\a.txt')).toBeTruthy();
      expect(plan.src.endsWith('/a.txt') || plan.src.endsWith('\\a.txt')).toBeTruthy();
  });

});

