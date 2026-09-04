# [DESIGN-A11Y-001] 可访问性规范

> 本文档定义 khy-os 项目的可访问性标准，确保所有用户都能使用。

---

## 1. 可访问性概述

### 1.1 设计原则

1. **可感知**：信息和界面组件必须以可感知的方式呈现
2. **可操作**：用户界面组件和导航必须可操作
3. **可理解**：信息和用户界面的操作必须可理解
4. **健壮性：内容必须足够健壮，能被各种用户代理解释

### 1.2 合规标准

- **WCAG 2.1 AA**：最低合规级别
- **WCAG 2.1 AAA**：推荐合规级别

---

## 2. 语义化 HTML

### 2.1 使用语义化标签

```vue
<template>
  <!-- ✅ 正确：使用语义化标签 -->
  <header>
    <nav aria-label="主导航">
      <ul>
        <li><a href="/">首页</a></li>
        <li><a href="/about">关于</a></li>
      </ul>
    </nav>
  </header>
  
  <main>
    <article>
      <h1>文章标题</h1>
      <section>
        <h2>章节标题</h2>
        <p>内容...</p>
      </section>
    </article>
    
    <aside aria-label="侧边栏">
      <h2>相关链接</h2>
      <!-- 内容 -->
    </aside>
  </main>
  
  <footer>
    <p>版权信息</p>
  </footer>
</template>
```

### 2.2 标题层级

```vue
<template>
  <!-- ✅ 正确：标题层级清晰 -->
  <h1>页面标题</h1>
  <h2>主要章节</h2>
  <h3>子章节</h3>
  <h4>小节</h4>
  
  <!-- ❌ 错误：跳级使用标题 -->
  <h1>页面标题</h1>
  <h4>子章节</h4>  <!-- 跳过了 h2 和 h3 -->
</template>
```

---

## 3. ARIA 属性

### 3.1 常用 ARIA 属性

**aria-label**：为元素提供标签
```vue
<button aria-label="关闭对话框">×</button>
```

**aria-labelledby**：引用其他元素作为标签
```vue
<h2 id="dialog-title">确认操作</h2>
<div role="dialog" aria-labelledby="dialog-title">
  <!-- 内容 -->
</div>
```

**aria-describedby**：引用其他元素作为描述
```vue
<input aria-describedby="password-hint" />
<p id="password-hint">密码至少需要 8 个字符</p>
```

**aria-live**：动态内容更新通知
```vue
<div aria-live="polite" aria-atomic="true">
  {{ statusMessage }}
</div>
```

### 3.2 ARIA 角色

```vue
<!-- 对话框 -->
<div role="dialog" aria-modal="true" aria-labelledby="dialog-title">
  <h2 id="dialog-title">确认操作</h2>
  <p>确定要删除吗？</p>
  <button>确定</button>
  <button>取消</button>
</div>

<!-- 提示消息 -->
<div role="alert" aria-live="assertive">
  操作成功！
</div>

<!-- 导航 -->
<nav aria-label="主导航">
  <ul role="menubar">
    <li role="none">
      <a role="menuitem" href="/">首页</a>
    </li>
  </ul>
</nav>

<!-- 表格 -->
<table role="grid">
  <thead>
    <tr role="row">
      <th role="columnheader">姓名</th>
      <th role="columnheader">邮箱</th>
    </tr>
  </thead>
  <tbody>
    <tr role="row">
      <td role="gridcell">张三</td>
      <td role="gridcell">zhangsan@example.com</td>
    </tr>
  </tbody>
</table>
```

---

## 4. 键盘导航

### 4.1 焦点管理

```vue
<template>
  <!-- 可聚焦元素 -->
  <button>可聚焦按钮</button>
  <a href="/">可聚焦链接</a>
  <input type="text" />
  
  <!-- 自定义可聚焦元素 -->
  <div tabindex="0" role="button" @click="handleClick" @keydown="handleKeyDown">
    自定义按钮
  </div>
</template>

<script setup>
const handleKeyDown = (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    handleClick();
  }
};
</script>
```

### 4.2 焦点陷阱（对话框）

```vue
<template>
  <div
    v-if="isOpen"
    class="dialog-overlay"
    @click.self="close"
  >
    <div
      ref="dialogRef"
      role="dialog"
      aria-modal="true"
      aria-labelledby="dialog-title"
      @keydown="handleKeyDown"
    >
      <h2 id="dialog-title">{{ title }}</h2>
      <slot />
    </div>
  </div>
</template>

<script setup>
import { ref, watch, nextTick } from 'vue';

const dialogRef = ref(null);

// 打开时聚焦到对话框
watch(() => isOpen, async (value) => {
  if (value) {
    await nextTick();
    dialogRef.value?.focus();
  }
});

// Tab 键焦点陷阱
const handleKeyDown = (event) => {
  if (event.key === 'Escape') {
    close();
    return;
  }
  
  if (event.key === 'Tab') {
    const focusableElements = dialogRef.value?.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    
    if (focusableElements?.length) {
      const firstElement = focusableElements[0];
      const lastElement = focusableElements[focusableElements.length - 1];
      
      if (event.shiftKey && document.activeElement === firstElement) {
        event.preventDefault();
        lastElement.focus();
      } else if (!event.shiftKey && document.activeElement === lastElement) {
        event.preventDefault();
        firstElement.focus();
      }
    }
  }
};
</script>
```

### 4.3 快捷键

| 快捷键 | 功能 |
|--------|------|
| Tab | 移动到下一个可聚焦元素 |
| Shift + Tab | 移动到上一个可聚焦元素 |
| Enter | 激活按钮/链接 |
| Space | 激活按钮/复选框 |
| Escape | 关闭对话框/菜单 |
| Arrow Keys | 在菜单/列表/标签页中导航 |

---

## 5. 颜色与对比度

### 5.1 对比度要求

| 级别 | 正文 | 大文本 | UI 组件 |
|------|------|--------|---------|
| AA | 4.5:1 | 3:1 | 3:1 |
| AAA | 7:1 | 4.5:1 | 3:1 |

### 5.2 颜色使用

```css
/* ✅ 正确：不仅依赖颜色传达信息 */
.status {
  display: flex;
  align-items: center;
  gap: 8px;
}

.status.success::before {
  content: '✓';
  color: #10b981;
}

.status.error::before {
  content: '✕';
  color: #ef4444;
}

/* ❌ 错误：仅依赖颜色 */
.status.success {
  color: #10b981;
}

.status.error {
  color: #ef4444;
}
```

### 5.3 动画偏好

```css
/* 尊重用户的动画偏好 */
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
```

---

## 6. 表单可访问性

### 6.1 标签关联

```vue
<template>
  <!-- ✅ 正确：使用 label 关联 -->
  <label for="username">用户名</label>
  <input id="username" type="text" />
  
  <!-- ✅ 正确：使用 aria-label -->
  <input aria-label="搜索" type="search" />
  
  <!-- ✅ 正确：使用 aria-labelledby -->
  <span id="search-label">搜索</span>
  <input aria-labelledby="search-label" type="search" />
</template>
```

### 6.2 错误提示

```vue
<template>
  <div>
    <label for="email">邮箱</label>
    <input
      id="email"
      type="email"
      :aria-invalid="hasError"
      :aria-describedby="hasError ? 'email-error' : undefined"
      v-model="email"
    />
    <p
      v-if="hasError"
      id="email-error"
      role="alert"
      class="error-message"
    >
      请输入有效的邮箱地址
    </p>
  </div>
</template>
```

### 6.3 必填字段

```vue
<template>
  <label for="username">
    用户名 <span aria-hidden="true">*</span>
  </label>
  <input
    id="username"
    type="text"
    required
    aria-required="true"
  />
</template>
```

---

## 7. 动态内容

### 7.1 加载状态

```vue
<template>
  <div aria-live="polite" aria-busy="isLoading">
    <span v-if="isLoading">加载中...</span>
    <ul v-else>
      <li v-for="item in items" :key="item.id">{{ item.name }}</li>
    </ul>
  </div>
</template>
```

### 7.2 通知消息

```vue
<template>
  <!-- 状态消息 -->
  <div role="status" aria-live="polite">
    {{ statusMessage }}
  </div>
  
  <!-- 警告消息 -->
  <div role="alert" aria-live="assertive">
    {{ errorMessage }}
  </div>
</template>
```

---

## 8. 测试清单

### 8.1 手动测试

- [ ] 仅使用键盘可以完成所有操作
- [ ] 焦点顺序符合逻辑
- [ ] 所有表单字段都有标签
- [ ] 错误消息清晰且有帮助
- [ ] 颜色对比度符合标准
- [ ] 动画可以禁用
- [ ] 内容可以缩放至 200%

### 8.2 自动化测试

- [ ] 使用 axe-core 进行自动化测试
- [ ] 集成到 CI/CD 流程
- [ ] 定期检查可访问性问题

---

## 9. 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0.0 | 2026-09-04 | 初始版本，定义可访问性规范 |

---

*本规范由 khy-os 可访问性团队维护*