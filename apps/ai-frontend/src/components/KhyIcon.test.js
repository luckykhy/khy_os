import { describe, it, expect } from 'vitest';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import KhyIcon from './KhyIcon.vue';

// 这组断言守的是一个静默失效:ICONS 的值是单条 path 字符串,而 v-for 对字符串会
// 逐字符迭代,曾导致每个图标渲染成几十个 d="M" 的非法 path——构建照样通过,页面上
// 却什么都画不出来,所有图标看起来完全一样。

async function renderIcon(props) {
  return renderToString(createSSRApp(KhyIcon, props));
}

function pathData(html) {
  return [...html.matchAll(/\sd="([^"]*)"/g)].map((m) => m[1]);
}

describe('KhyIcon', () => {
  it('每个图标只渲染一条完整 path,而不是逐字符拆开', async () => {
    const ds = pathData(await renderIcon({ kind: 'key' }));
    expect(ds).toHaveLength(1);
    // 逐字符退化时每条 d 只有 1 个字符;真实图标 path 远长于此。
    expect(ds[0].length).toBeGreaterThan(20);
    expect(ds[0].startsWith('M')).toBe(true);
  });

  it('不同 kind 渲染出不同图形', async () => {
    const kinds = ['key', 'cpu', 'compass', 'lock', 'grid', 'data'];
    const drawn = await Promise.all(
      kinds.map(async (kind) => pathData(await renderIcon({ kind }))[0])
    );
    expect(new Set(drawn).size).toBe(kinds.length);
  });

  it('未知 kind 回退到 info 图标', async () => {
    const unknown = pathData(await renderIcon({ kind: 'no-such-icon' }));
    const info = pathData(await renderIcon({ kind: 'info' }));
    expect(unknown).toEqual(info);
  });
});
