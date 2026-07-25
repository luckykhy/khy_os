'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 黑盒验证 getSystemPrompt 的装配顺序:reorder / relocation 门控开时,易变段(env_info)与按需
// 能力胶囊(# File operations 等)被移到系统提示尾部(在 baseSecurity 之后);门控关时逐字节回退
// 今日顺序(易变段在动态区靠前、胶囊在 behavioralSections 静态区,均在 baseSecurity 之前)。
//
// 用 env_info(`# Environment`,任何 cwd 都在)+ 调用方注入的 baseSecurity 唯一标记做位置锚点,
// 避免依赖 git 仓库 / skills / CLAUDE.md 等按 cwd 存在与否的段。

const SECURITY_MARK = '@@KHY_SECURITY_SENTINEL_9137@@';
const CODING_MSG =
  '修复 backend 登录 bug,先搜索 router 和 service,再修改文件并运行 npm test 验证。';
const CODING_TOOLS = ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep'];

async function withEnv(overrides, fn) {
  const saved = {};
  for (const k of Object.keys(overrides)) {
    saved[k] = Object.prototype.hasOwnProperty.call(process.env, k) ? process.env[k] : undefined;
    if (overrides[k] === undefined) delete process.env[k];
    else process.env[k] = overrides[k];
  }
  try { return await fn(); }   // 必须 await:否则 finally 在 fn 返回 promise 时即恢复 env,
  finally {                     // 异步的 getSystemPrompt 读到的已是被还原的默认值(门控失效)。
    for (const k of Object.keys(overrides)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

async function buildPrompt(cwd) {
  const { getSystemPrompt, assembleSystemPrompt } = require('../src/constants/prompts');
  const { clearSectionCache } = require('../src/constants/prompts');
  clearSectionCache(); // 防止跨门控用例复用缓存段导致串扰
  const sections = await getSystemPrompt({
    cwd,
    enabledTools: CODING_TOOLS,
    userMessage: CODING_MSG,
    taskScale: 'medium',
    baseSecurity: SECURITY_MARK,
  });
  return assembleSystemPrompt(sections);
}

describe('prompt cache stable ordering', () => {
  // 三个场景合并进一个 test:getSystemPrompt 读全局 process.env,分开成多个并发 test 会因
  // process.env 互相覆盖而串扰(实测 OFF 用例被并发 ON 用例删除门控污染)。串行执行消除竞态。
  test('reorder / relocation 门控:OFF 今日顺序、ON 易变段+胶囊移到 baseSecurity 之后', async () => {
    // ── OFF:两门控关 → 今日顺序(env_info 与胶囊都在 baseSecurity 之前)──────────────
    {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-cacheorder-off-'));
      try {
        const prompt = await withEnv(
          { KHY_PROMPT_CACHE_ORDER: 'off', KHY_ONDEMAND_OUT_OF_PREFIX: 'off' },
          () => buildPrompt(tmp),
        );
        const iEnv = prompt.indexOf('# Environment');
        const iSec = prompt.indexOf(SECURITY_MARK);
        const iCapsule = prompt.indexOf('# File operations');
        assert.ok(iEnv > -1, 'env_info 段应在');
        assert.ok(iSec > -1, 'baseSecurity 标记应在');
        assert.ok(iCapsule > -1, '编码消息应触发 # File operations 胶囊');
        assert.ok(iEnv < iSec, `OFF:env_info 应在 baseSecurity 之前(env=${iEnv} sec=${iSec})`);
        assert.ok(iCapsule < iSec, `OFF:胶囊应在 baseSecurity 之前(cap=${iCapsule} sec=${iSec})`);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    }

    // ── ON(默认开):env_info 与按需胶囊移到 baseSecurity 之后(dead-last)──────────────
    {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-cacheorder-on-'));
      try {
        const prompt = await withEnv(
          { KHY_PROMPT_CACHE_ORDER: undefined, KHY_ONDEMAND_OUT_OF_PREFIX: undefined },
          () => buildPrompt(tmp),
        );
        const iEnv = prompt.indexOf('# Environment');
        const iSec = prompt.indexOf(SECURITY_MARK);
        const iCapsule = prompt.indexOf('# File operations');
        assert.ok(iEnv > -1 && iSec > -1 && iCapsule > -1, '三锚点均应在');
        assert.ok(iEnv > iSec, `ON:env_info 应在 baseSecurity 之后(env=${iEnv} sec=${iSec})`);
        assert.ok(iCapsule > iSec, `ON:胶囊应在 baseSecurity 之后(cap=${iCapsule} sec=${iSec})`);
        assert.ok(iCapsule > iEnv, `ON:胶囊在 env_info 之后(绝对尾部)(cap=${iCapsule} env=${iEnv})`);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    }
  });
});
