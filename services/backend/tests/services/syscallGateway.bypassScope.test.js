'use strict';

/**
 * syscallGateway.bypassScope.test.js — 旁路探测「字段作用域化」回归。
 *
 * 背景(用户报 2026-07·Windows)：`Write(...\.khy\skills\yt-dlp\prompt.md)` 被
 * 「系统调用网关拦截 [L2/已熔断]: 检测到旁路注入标记 flag:-f，熔断并拒绝」硬拒，连审批都
 * 不弹出。根因=detectBypassMarkers 把**文件内容**里合法出现的 yt-dlp 格式选项 `-f`(裸单字符)
 * 当成「跳过审批」旁路注入，一次即熔断。
 *
 * 修复两拍(门控 KHY_GATEWAY_BYPASS_SCOPED 默认开)：
 *   ① CLI flag 字面量只在**命令承载字段**里扫，数据载荷字段(content/new_string/text…)不扫不下钻；
 *   ② 从 flag 集里剔除高度重载的裸 `-f`/`-y`(命令自身语义，由动作分级照常审批)。
 * 保住红线：`force:true` 键(_BYPASS_KEY_PATTERNS 任意层级)、`--skip-approval` /
 * `--dangerously-skip-permissions`(指向智能体审批系统本身的长 flag)仍一次即判旁路。
 * 收窄(用户报 2026-07·Windows·`npx --yes asar ls` 锁死整会话)：子进程自有确认 flag
 * `--yes`/`--force`/`--no-confirm`/`--assume-yes` 从 scoped 名单剔除——子进程位于网关下方，
 * 其确认 flag 绕不过上方 Khy 审批，真实风险(INSTALL/DELETE)由动作分级照常审批。
 */
const { describe, test, expect } = require('@jest/globals');
const { detectBypassMarkers } = require('../../src/services/syscallGateway/intentSchema');

const GATE = 'KHY_GATEWAY_BYPASS_SCOPED';
function withGate(value, fn) {
  const prev = process.env[GATE];
  if (value === undefined) delete process.env[GATE];
  else process.env[GATE] = value;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env[GATE];
    else process.env[GATE] = prev;
  }
}

describe('旁路探测作用域化 — 真缺陷：文件内容里的 -f 不再误判', () => {
  test('Write 内容含 yt-dlp -f 格式选项 → 不判旁路(默认门控开)', () => {
    const params = {
      path: 'C:/Users/25789/.khy/skills/yt-dlp/prompt.md',
      content: 'Use `yt-dlp -f best` to pick the best format. Also try -f 22 or --format mp4.',
    };
    expect(detectBypassMarkers(params)).toEqual([]);
  });

  test('new_string / text / patch 等数据字段里的 -f/--force 不判旁路', () => {
    expect(detectBypassMarkers({ new_string: 'rm -rf --force build' })).toEqual([]);
    expect(detectBypassMarkers({ text: 'push --force to remote' })).toEqual([]);
    expect(detectBypassMarkers({ patch: '- old --yes\n+ new -f' })).toEqual([]);
    expect(detectBypassMarkers({ body: 'docs mention -y for apt' })).toEqual([]);
  });

  test('命令承载字段里合法的裸 -f/-y 不再熔断(命令语义由分级层审批)', () => {
    expect(detectBypassMarkers({ command: 'yt-dlp -f best https://x' })).toEqual([]);
    expect(detectBypassMarkers({ command: 'tar -xf archive.tar' })).toEqual([]);
    expect(detectBypassMarkers({ command: 'apt install pkg -y' })).toEqual([]);
    expect(detectBypassMarkers({ args: ['-f', 'best'] })).toEqual([]);
  });

  test('子进程自有确认 flag(--yes/--force/--no-confirm) 不再熔断整会话', () => {
    // 用户报 2026-07·Windows：`npx --yes asar ls` / `python ... --yes` 触发
    // 「检测到旁路注入标记 flag:--yes，熔断并拒绝」锁死整会话。这些是子进程语义，
    // 由动作分级(INSTALL/PROCESS…)按风险走审批，不作旁路红线。
    expect(detectBypassMarkers({ command: 'npx --yes asar ls resources/app.asar' })).toEqual([]);
    expect(detectBypassMarkers({ command: 'python -c "import zipfile" --yes' })).toEqual([]);
    expect(detectBypassMarkers({ command: 'npm install pkg --force' })).toEqual([]);
    expect(detectBypassMarkers({ command: 'apt-get install pkg --assume-yes' })).toEqual([]);
    expect(detectBypassMarkers({ command: 'git push --no-confirm' })).toEqual([]);
    expect(detectBypassMarkers({ args: ['--yes', '--force'] })).toEqual([]);
  });
});

describe('旁路探测作用域化 — 红线不弱化：真旁路仍一次即命中', () => {
  test('force:true / skipApproval 等键在任意字段仍命中', () => {
    expect(detectBypassMarkers({ force: true }).length).toBeGreaterThan(0);
    expect(detectBypassMarkers({ skipApproval: true }).length).toBeGreaterThan(0);
    expect(detectBypassMarkers({ dangerouslySkipPermissions: true }).length).toBeGreaterThan(0);
    // 嵌套在命令 opts 里也逃不掉。
    expect(detectBypassMarkers({ opts: { autoApprove: 1 } }).length).toBeGreaterThan(0);
  });

  test('force:false / 空值不算旁路', () => {
    expect(detectBypassMarkers({ force: false })).toEqual([]);
    expect(detectBypassMarkers({ force: '' })).toEqual([]);
    expect(detectBypassMarkers({ force: null })).toEqual([]);
  });

  test('命令字段里指向审批系统本身的长 flag 仍命中', () => {
    expect(detectBypassMarkers({ command: 'do it --dangerously-skip-permissions' }).length).toBeGreaterThan(0);
    expect(detectBypassMarkers({ args: ['--skip-approval'] }).length).toBeGreaterThan(0);
  });

  test('数据字段里的 --force 长 flag 也不误判(数据不是命令)', () => {
    // 关键取舍：连长 flag 也只在命令字段生效，数据载荷一律放行——文件内容里写文档描述
    // `--force` 是合法数据，不该熔断。
    expect(detectBypassMarkers({ content: 'The --force flag skips checks.' })).toEqual([]);
  });
});

describe('旁路探测作用域化 — 门控关字节回退旧行为', () => {
  test('KHY_GATEWAY_BYPASS_SCOPED=off → 内容里的裸 -f 复现旧的误判', () => {
    withGate('off', () => {
      const hits = detectBypassMarkers({ content: 'yt-dlp -f best' });
      expect(hits).toContain('flag:-f'); // 旧行为：全字符串扫、含裸 -f
    });
  });

  test('门控开(默认/显式 1) → 同输入不再误判', () => {
    expect(detectBypassMarkers({ content: 'yt-dlp -f best' })).toEqual([]);
    withGate('1', () => {
      expect(detectBypassMarkers({ content: 'yt-dlp -f best' })).toEqual([]);
    });
  });

  test('门控关 → --force 全字符串扫描仍命中(旧行为不丢)', () => {
    withGate('0', () => {
      expect(detectBypassMarkers({ command: 'rm x --force' }).length).toBeGreaterThan(0);
    });
  });
});
