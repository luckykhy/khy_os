/**
 * unwrap SSOT wiring 断言(前端)。
 *
 * 历史上响应信封解包(`{success,data}` → data)被逐字复制到 13 个 composable/view
 * 里(名为 `unwrap` 或 `unwrapResponse`)。这已收敛到唯一真源 `@/api/unwrap`。
 * 这些文件 import Vue 和 `@/` 别名,无法在裸 Node 测试运行器里直接 import——
 * 因此在源码层断言接线:每个消费方都 import 了 SSOT,且不再本地定义信封函数。
 * 这正是未来某次编辑若把某处退回内联副本时会静默破掉的不变量。
 *
 * 零依赖——用内置 Node 测试运行器跑(apps/ai-frontend 是 type:module):
 *   node --test src/api/unwrap.wiring.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..'); // apps/ai-frontend/src

function read(rel) {
  return readFileSync(join(appRoot, rel), 'utf8');
}

// 全部 13 个消费方(12 composable + 1 view)。
const CONSUMERS = [
  'composables/usePromptLibrary.js',
  'composables/useGateway.js',
  'composables/useAccountPool.js',
  'composables/useAIMonitor.js',
  'composables/useAssetCustomer.js',
  'composables/useGatewayBilling.js',
  'composables/useWorkflow.js',
  'composables/useUserGateway.js',
  'composables/useProjects.js',
  'composables/useProxies.js',
  'composables/useChatConversations.js',
  'composables/useMarketplace.js',
  'views/AIMonitor.vue',
];

test('SSOT api/unwrap.js 存在且导出 unwrap', () => {
  const src = read('api/unwrap.js');
  assert.match(src, /export function unwrap\(res\)/, 'unwrap.js must export function unwrap(res)');
  // 信封判定的三个不变量:success 键 + data 键 + payload ?? res 兜底。
  assert.match(src, /hasOwnProperty\.call\(payload, 'success'\)/, 'must gate on success key');
  assert.match(src, /hasOwnProperty\.call\(payload, 'data'\)/, 'must gate on data key');
  assert.match(src, /return payload \?\? res/, 'must fall back to payload ?? res');
});

for (const rel of CONSUMERS) {
  test(`${rel} imports the unwrap SSOT`, () => {
    const src = read(rel);
    assert.match(src, /import \{ unwrap \} from '@\/api\/unwrap'/,
      `${rel} must import { unwrap } from '@/api/unwrap'`);
  });

  test(`${rel} no longer defines an inline envelope helper`, () => {
    const src = read(rel);
    assert.doesNotMatch(src, /function unwrap(Response)?\(res\)\s*\{/,
      `${rel} must not re-declare a local unwrap/unwrapResponse — use the SSOT`);
    // 也不得残留旧调用名。
    assert.doesNotMatch(src, /unwrapResponse\(/,
      `${rel} must not call unwrapResponse(...) — renamed to unwrap(...)`);
  });
}
