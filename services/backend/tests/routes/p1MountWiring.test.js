'use strict';

/**
 * Phase 1 mount wiring —— 后端两个「挂错服务」陷阱的机器化防线。
 *
 * `/api/cross-platform` 与 `/api/proxy-egress` 曾经各断过一次：前者在 services/backend/server.js
 * 里漏了挂载（源码 checkout 起的服务全部 404），后者曾被误判为「无后端」。
 * 这两条测试把正确归属钉住，防止下一个人顺手又挪回错的服务。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const BACKEND = path.resolve(__dirname, '..', '..');
const SERVER = path.join(BACKEND, 'server.js');
const SERVER_SRC = fs.readFileSync(SERVER, 'utf8');
const SERVER_LINES = SERVER_SRC.split(/\r?\n/);
// 归一化空白再匹配,否则多行解构/换行风格一变,用例就会因格式而非语义而红。
const DAEMON_SRC = fs.readFileSync(path.join(BACKEND, 'src', 'services', 'aiManagementServer.js'), 'utf8');
const DAEMON_FLAT = DAEMON_SRC.replace(/\s+/g, ' ');

describe('server.js：跨端 REST 必须挂在源仓库的 Express 服务上', () => {
  test('/api/cross-platform 挂载点在位', () => {
    assert.match(SERVER_SRC, /app\.use\('\/api\/cross-platform', require\('\.\/src\/routes\/crossPlatform'\)\)/);
  });

  test('/api/config-sync 挂载点在位 —— 客户端只认 Express,漏挂即静默降级本地', () => {
    assert.match(SERVER_SRC, /app\.use\('\/api\/config-sync', require\('\.\/src\/routes\/configSync'\)\)/);
  });
});

describe('proxy-egress 归属：只允许出现在 ai-management 守护进程', () => {
  test('Express server.js 里没有任何 proxy-egress 挂载或分派', () => {
    const offenders = SERVER_LINES
      .map((l, i) => [i + 1, l])
      .filter(([, l]) => /proxy-egress/.test(l) && !/^\s*\/\//.test(l))
      .map(([i, l]) => `${i}: ${l.trim()}`);
    assert.deepEqual(offenders, [], 'proxy-egress 分派应留在 aiManagementServer.js：express 上没有它');
  });

  test('aiManagementServer 分派三路且处理器真被引入', () => {
    for (const name of ['handleGetProxyEgressStatus', 'handleEnableProxyEgress', 'handleDisableProxyEgress']) {
      // 引入侧:叶子模块的解构成员。
      assert.match(DAEMON_FLAT, new RegExp(`${name},`), `缺引入 ${name}`);
      // 分派侧:routeRequest 里的调用点。
      assert.match(DAEMON_FLAT, new RegExp(`${name}\\(req, res\\)`), `缺分派 ${name}`);
    }
    assert.match(DAEMON_FLAT, /require\('\.\/aiManagementProxyEgress'\)/, '叶子未 require');
    assert.match(DAEMON_FLAT, /setProxyEgressDeps\(\{/, '依赖注入未接线');
  });
});
