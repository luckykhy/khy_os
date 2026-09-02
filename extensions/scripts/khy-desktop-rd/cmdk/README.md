# kbar — Cmd+K Command Palette（React）

> 调研日期: 2026-08-31
> 仓库: <https://github.com/timc1/kbar>
> License: MIT

## 一、为什么列在这里

ZCode 截图里最显眼的特征之一是 **Ctrl+K 搜索覆盖层**——毛玻璃居中弹窗、4 个分类标签、键盘导航、模糊匹配。

要给 khy-os 桌面端复刻这个组件，最现成的范式是 **kbar**：
- 单一组件库，~30KB
- 完全无样式（自己控制视觉）
- 内置键盘导航（⌘P、⌘N、Backspace）
- 内置屏幕阅读器支持
- 支持 nested actions（多层菜单）
- 性能优化（千级 actions 不卡）

> 注意：kbar 是 React 组件库，**khy-os 是 Vue 项目**——需要找 Vue 等价方案或自己移植。调研同时记录了 `cmdk`（timc1 同作者的开源版）作为备选。

## 二、核心使用模式

```tsx
// app.tsx
import { KBarProvider, KBarPortal, KBarPositioner, KBarAnimator, KBarSearch, KBarResults, useMatches, NO_GROUP } from "kbar";

function MyApp() {
  const actions = [
    {
      id: "blog",
      name: "Blog",
      shortcut: ["b"],
      keywords: "writing words",
      perform: () => (window.location.pathname = "blog"),
    },
    // ...
  ];

  return (
    <KBarProvider actions={actions}>
      <KBarPortal>
        <KBarPositioner>
          <KBarAnimator>
            <KBarSearch />
            <RenderResults />
        </KBarAnimator>
      </KBarPositioner>
    </KBarPortal>
    <MyApp />
  </KBarProvider>;
}

function RenderResults() {
  const { results } = useMatches();
  return (
    <KBarResults
      items={results}
      onRender={({ item, active }) =>
        typeof item === "string"
          ? <div>{item}</div>
          : <div style={{ background: active ? "#f76b1c" : "transparent" }}>
              {item.name}
            </div>
      }
    />
  );
}
```

## 三、特性清单

- ✅ 内置动画 + 完全可定制组件
- ✅ 键盘导航（⌘N / ⌘P 切导航向导）
- ✅ 单字符快捷键（按 `b` 跳 Blog，按 `?` 调出文档搜索）
- ✅ 嵌套 actions（Backspace 回上一层）
- ✅ 千级 actions 不卡（性能优先）
- ✅ 历史管理（undo/redo）
- ✅ 屏幕阅读器支持
- ✅ 简单数据结构

## 四、给 khy-os 的启示

### 4.1 Vue 等价方案调研（待补）

khy-os 是 Vue 3，需要找 Vue 等价库。已知选项：

| 库 | 备注 |
|----|------|
| [vue-cmdk](https://github.com/receter/vue-cmdk) | Vue 3 端口，API 类似 kbar |
| [floating-vue + 搜索逻辑自写] | 灵活但工作量大 |
| 直接移植 kbar 到 Vue | 90 行核心代码可以重写 |

**khy-os 的最优路径**：
- 短期：在 Vue 中**自写** Cmd+K 覆盖层（基于 Element Plus el-dialog + 自定义搜索）
- 中期：评估引入 vue-cmdk 或移植 kbar

### 4.2 与 goose Quick Launcher 的关系

goose 用**独立透明 BrowserWindow**（`createLauncher()`）实现 Cmd+K，kbar 用**DOM 覆盖层**。两条路径：

| 维度 | DOM 覆盖层（kbar） | 独立窗口（goose） |
|------|---------------------|--------------------|
| 实现复杂度 | 低（前端组件） | 中（主进程 + IPC） |
| 失焦行为 | 自动隐藏 | 自动销毁 |
| 跨窗口支持 | 局限当前窗口 | 全局 |
| 视觉风格 | 与页面融为一体 | 像独立应用 |
| 与 ZCode 截图对比 | 接近（毛玻璃弹窗） | 也接近（独立窗口） |

**给 khy-os 的建议**：两种都支持——`Ctrl+K` 触发 DOM 覆盖层（kbar 风），`globalShortcut.register('CommandOrControl+K', ...)` 触发独立小窗口（goose 风）。

### 4.3 数据结构设计参考

kbar 的 actions 数据结构：

```typescript
type Action = {
  id: string;
  name: string;
  shortcut?: string[];
  keywords?: string;
  perform: () => void;
  section?: string;
  parent?: string;
  children?: Action[];
};
```

**给 khy-os 的启示**：khy-os 桌面端的命令可以按"section 分组 + parent/children 嵌套"组织：

```
功能分组：
  ├── AI 对话（New Chat / Clear History / Export Chat）
  ├── 工作流（New Workflow / Open Workflow / Sync）
  ├── 设置（Open Settings / Open Models / Open Skills）
  └── 主题（Light / Dark / Follow System）
```

## 五、本地文件

| 文件 | 来源 |
|------|------|
| `README.md` | 抓取自 <https://raw.githubusercontent.com/timc1/kbar/main/README.md> |

## 六、参考资料

- 官方演示: <https://kbar.vercel.app/docs>
- Vue 3 端口候选: <https://github.com/receter/vue-cmdk>