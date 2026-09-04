'use strict';

/**
 * check-traffic-log.js — CI 检查：traffic-logger 模块结构与依赖合规。
 *
 * 验证：
 *   1. traffic-logger.js 存在且导出正确
 *   2. traffic-stream.js 存在且导出正确
 *   3. traffic-integration.js 存在且导出正确
 *   4. CLI handler traffic.js 存在
 *   5. 前端 TrafficMonitor 面板存在
 *   6. 路由注册包含 traffic
 *   7. 别名表包含流量相关别名
 *   8. 零外部依赖（无 npm 包依赖）
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const BACKEND = path.join(ROOT, 'services', 'backend', 'src');
const FRONTEND = path.join(ROOT, 'apps', 'ai-frontend', 'src');

const checks = [];
let errors = 0;

function check(name, fn) {
  try {
    fn();
    checks.push({ name, ok: true });
  } catch (err) {
    checks.push({ name, ok: false, error: err.message });
    errors++;
  }
}

function assertFile(relPath) {
  const full = path.join(ROOT, relPath);
  if (!fs.existsSync(full)) {
    throw new Error(`文件不存在: ${relPath}`);
  }
  return full;
}

function assertExport(filePath, name) {
  const mod = require(filePath);
  if (mod[name] === undefined) {
    throw new Error(`模块未导出 ${name}: ${filePath}`);
  }
}

// ── 检查 1: traffic-logger.js ───────────────────────────────────
check('traffic-logger.js 存在且导出正确', () => {
  const f = assertFile('services/backend/src/services/gateway/traffic-logger.js');
  assertExport(f, 'trafficLogger');
  assertExport(f, 'TrafficLogger');
  assertExport(f, 'sanitizeHeaders');
  assertExport(f, 'extractTokenUsage');
});

// ── 检查 2: traffic-stream.js ───────────────────────────────────
check('traffic-stream.js 存在且导出正确', () => {
  const f = assertFile('services/backend/src/services/gateway/traffic-stream.js');
  assertExport(f, 'TrafficStream');
  assertExport(f, 'getTrafficStream');
  assertExport(f, 'WS_PATH');
});

// ── 检查 3: traffic-integration.js ──────────────────────────────
check('traffic-integration.js 存在且导出正确', () => {
  const f = assertFile('services/backend/src/services/gateway/traffic-integration.js');
  assertExport(f, 'installTrafficRecording');
});

// ── 检查 4: CLI handler ─────────────────────────────────────────
check('CLI handler traffic.js 存在', () => {
  const f = assertFile('services/backend/src/cli/handlers/traffic.js');
  assertExport(f, 'handleTraffic');
});

// ── 检查 5: 前端面板 ────────────────────────────────────────────
check('前端 TrafficMonitor 面板存在', () => {
  assertFile('apps/ai-frontend/src/views/TrafficMonitor/index.vue');
});

// ── 检查 6: 路由注册 ────────────────────────────────────────────
check('路由注册包含 traffic', () => {
  const routerFile = assertFile('apps/ai-frontend/src/router/index.js');
  const content = fs.readFileSync(routerFile, 'utf8');
  if (!content.includes("'traffic'")) {
    throw new Error("路由中未找到 'traffic'");
  }
});

// ── 检查 7: 别名表 ──────────────────────────────────────────────
check('别名表包含流量相关别名', () => {
  const aliasesFile = assertFile('services/backend/src/cli/aliases.js');
  const content = fs.readFileSync(aliasesFile, 'utf8');
  if (!content.includes("'traffic'")) {
    throw new Error("别名表中未找到 'traffic'");
  }
});

// ── 检查 8: 零外部依赖 ──────────────────────────────────────────
check('traffic-logger 零外部依赖', () => {
  const f = assertFile('services/backend/src/services/gateway/traffic-logger.js');
  const content = fs.readFileSync(f, 'utf8');
  // 只允许 require('events') 和 require('crypto')（Node 内置）
  const requireMatches = content.match(/require\(['"]([^'"]+)['"]\)/g) || [];
  const allowed = ['events', 'crypto'];
  for (const req of requireMatches) {
    const mod = req.match(/require\(['"]([^'"]+)['"]\)/)[1];
    if (mod.startsWith('.') || allowed.includes(mod)) {
      continue;
    }
    throw new Error(`发现外部依赖: ${mod}`);
  }
});

// ── 输出结果 ────────────────────────────────────────────────────
console.log('\n  traffic-logger CI 检查\n');
for (const c of checks) {
  const glyph = c.ok ? '✓' : '✗';
  const color = c.ok ? '\x1b[32m' : '\x1b[31m';
  console.log(`  ${color}${glyph}\x1b[0m ${c.name}`);
  if (!c.ok) {
    console.log(`     ${c.error}`);
  }
}
console.log('');
if (errors > 0) {
  console.log(`  \x1b[31m${errors} 项检查失败\x1b[0m\n`);
  process.exit(1);
} else {
  console.log(`  \x1b[32m全部 ${checks.length} 项检查通过\x1b[0m\n`);
}
