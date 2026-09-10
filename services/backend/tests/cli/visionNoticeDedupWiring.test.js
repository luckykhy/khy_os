'use strict';
/**
 * visionNoticeDedupWiring �?源级断言:REPL assistant_message 分支确实接线了回合内去重叶�?
 *
 * replSession.js �?god-file(数千�?�?raw-mode 终端 / 计时�?/ 交互�?,无法�?node:test �?
 * 干净实例化其 onChunk 闭包。故沿用仓库既有 wiring 断言范式(readFileSync + regex,�?
 * useWorkflow.wiring.test.js):对源文本断言接线点存在且形状正确,守住「叶被真正消费」这座桥�?
 *
 * 断言:
 *   �?回合作用域声明了 _visionNoticeSeen = new Set()(闭包变量,横跨工具迭代)�?
 *   �?assistant_message 渲染分支�?shouldRender(_visionNoticeSeen, msgText, process.env) �?gate�?
 *   �?require 路径为同目录 './visionNoticeDedup'�?
 *   �?�?Set 声明落在 _turnAckIndex(回合作用域锚�?附近,不是误落工具迭代作用域�?
 *
 * node:test�?
 */
const fs = require('node:fs');
const path = require('node:path');
const SRC = fs.readFileSync(
  path.resolve(__dirname, '../../src/cli/replSession.js'),
  'utf8',
);

describe('Vision Notice Dedup Wiring', () => {
  test('�?回合作用域声�?_visionNoticeSeen = new Set()', () => {
      expect(SRC).toMatch(/const\s+_visionNoticeSeen\s*=\s*new Set\(\)/);
  });

  test('�?assistant_message 分支�?shouldRender(_visionNoticeSeen, msgText, ...) �?gate', () => {
      assert.match(
        SRC,
        /if\s*\(\s*msgText\s*&&\s*require\(['"]\.\/visionNoticeDedup['"]\)\.shouldRender\(\s*_visionNoticeSeen\s*,\s*msgText\s*,\s*process\.env\s*\)\s*\)/,
        'assistant_message 渲染守卫应接�?shouldRender(回合�? msgText, env)',
      );
  });

  test('�?require 路径为同目录 ./visionNoticeDedup(非跨目录/错拼)', () => {
      expect(SRC).toMatch(/require\(['"]\.\/visionNoticeDedup['"]\)/);
      // 叶文件确实与 replSession 同目录�?
      assert.ok(
        fs.existsSync(path.resolve(__dirname, '../../src/cli/visionNoticeDedup.js')),
        '叶文件应�?replSession.js 同目�?src/cli/)',
      );
  });

  test('�?_visionNoticeSeen 声明落在 _turnAckIndex 回合锚点附近(回合作用�?非工具迭代作用域)', () => {
      const anchorIdx = SRC.indexOf('_turnAckIndex = (_replTurnAckSeq++)');
      const setIdx = SRC.indexOf('const _visionNoticeSeen = new Set()');
      expect(anchorIdx >= 0).toBeTruthy();
      expect(setIdx >= 0).toBeTruthy();
      // 紧邻锚点之后(同一回合作用域块�?几行之内)�?
      expect(setIdx > anchorIdx && setIdx - anchorIdx < 800).toBeTruthy();
  });

  test('�?一次�?去重接线只在 assistant_message 分支出现一�?不误�?one-shot 路径)', () => {
      const matches = SRC.match(/require\(['"]\.\/visionNoticeDedup['"]\)\.shouldRender/g) || [];
      expect(matches.length).toBe(1);
  });

});

