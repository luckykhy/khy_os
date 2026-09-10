'use strict';
const { rankSlashCommands } = require('./slashCommandFilter');
// Sample command table for testing
const SAMPLE_COMMANDS = [
  { cmd: '/model', label: '模型', desc: '切换 AI 模型' },
  { cmd: '/subscribe', label: '订阅', desc: '管理订阅' },
  { cmd: '/config', label: '配置', desc: '系统配置' },
  { cmd: '/help', label: '帮助', desc: '显示帮助信息' },
  { cmd: '/new', label: '新会�?, desc: '新建会话' },
];
// ── rankSlashCommands ────────────────────────────────────────────────────────
describe('Slash Command Filter', () => {
  test('rankSlashCommands: "/" only �?returns all commands', () => {
    const result = rankSlashCommands(SAMPLE_COMMANDS, '/');
    expect(result.length).toBe(SAMPLE_COMMANDS.length);
  });
  
  test('rankSlashCommands: empty filter �?returns all commands', () => {
      const result = rankSlashCommands(SAMPLE_COMMANDS, '');
      expect(result.length).toBe(SAMPLE_COMMANDS.length);
  });

  test('rankSlashCommands: prefix match scores highest', () => {
      const result = rankSlashCommands(SAMPLE_COMMANDS, '/mo');
      expect(result[0].cmd).toBe('/model');
  });

  test('rankSlashCommands: substring match scores second', () => {
      const result = rankSlashCommands(SAMPLE_COMMANDS, '/sub');
      expect(result[0].cmd).toBe('/subscribe');
  });

  test('rankSlashCommands: label match scores third', () => {
      const result = rankSlashCommands(SAMPLE_COMMANDS, '模型');
      expect(result[0].cmd).toBe('/model');
  });

  test('rankSlashCommands: desc match scores third (same as label)', () => {
      const result = rankSlashCommands(SAMPLE_COMMANDS, '帮助');
      expect(result[0].cmd).toBe('/help');
  });

  test('rankSlashCommands: no match �?empty array', () => {
      const result = rankSlashCommands(SAMPLE_COMMANDS, '/xyz');
      expect(result).toEqual([]);
  });

  test('rankSlashCommands: case insensitive matching', () => {
      const result = rankSlashCommands(SAMPLE_COMMANDS, '/MODEL');
      expect(result[0].cmd).toBe('/model');
  });

  test('rankSlashCommands: stable sort preserves original order for same score', () => {
      const cmds = [
        { cmd: '/alpha', label: 'test', desc: 'desc' },
        { cmd: '/beta', label: 'test', desc: 'desc' },
      ];
      const result = rankSlashCommands(cmds, 'test');
      expect(result[0].cmd).toBe('/alpha');
      expect(result[1].cmd).toBe('/beta');
  });

  test('rankSlashCommands: non-array cmds �?empty array', () => {
      expect(rankSlashCommands(null).toEqual('/mo'), []);
      expect(rankSlashCommands('string').toEqual('/mo'), []);
      expect(rankSlashCommands(123).toEqual('/mo'), []);
  });

  test('rankSlashCommands: empty cmds array �?empty array', () => {
      expect(rankSlashCommands([]).toEqual('/mo'), []);
  });

  test('rankSlashCommands: prefix match ranks above substring', () => {
      const cmds = [
        { cmd: '/model', label: '模型', desc: '切换模型' },
        { cmd: '/subscribe', label: '订阅', desc: '订阅管理' },
      ];
      // '/m' is prefix of '/model' but substring of '/subscribe'
      const result = rankSlashCommands(cmds, '/m');
      expect(result[0].cmd).toBe('/model');
  });

});

