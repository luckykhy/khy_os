# [DESIGN-I18N-001] 国际化规范

> 本文档定义 khy-os 项目的国际化（i18n）标准，包括多语言支持、翻译管理等。

---

## 1. 国际化概述

### 1.1 设计原则

1. **用户优先**：根据用户偏好显示语言
2. **易于扩展**：支持快速添加新语言
3. **一致性**：所有语言使用相同的术语
4. **可维护性**：翻译与代码分离

### 1.2 支持的语言

| 语言 | 代码 | 状态 |
|------|------|------|
| 简体中文 | zh-CN | ✅ 主要语言 |
| 英语 | en-US | ✅ 支持 |
| 繁体中文 | zh-TW | 🔄 计划中 |
| 日语 | ja-JP | 📋 待开发 |

---

## 2. 字符编码

### 2.1 编码标准

- **文件编码**：UTF-8（无 BOM）
- **数据库编码**：utf8mb4
- **HTTP 编码**：UTF-8

### 2.2 .editorconfig 配置

```ini
[*]
charset = utf-8
end_of_line = lf
insert_final_newline = true
```

---

## 3. 前端国际化

### 3.1 Vue I18n 配置

```javascript
// plugins/i18n.js
import { createI18n } from 'vue-i18n';
import zhCN from '@/locales/zh-CN.json';
import enUS from '@/locales/en-US.json';

const i18n = createI18n({
  legacy: false,
  locale: localStorage.getItem('locale') || 'zh-CN',
  fallbackLocale: 'en-US',
  messages: {
    'zh-CN': zhCN,
    'en-US': enUS
  }
});

export default i18n;
```

### 3.2 语言文件结构

```
src/
└── locales/
    ├── zh-CN.json      # 简体中文
    ├── en-US.json      # 英语
    └── zh-TW.json      # 繁体中文
```

### 3.3 语言文件格式

```json
{
  "common": {
    "save": "保存",
    "cancel": "取消",
    "delete": "删除",
    "edit": "编辑"
  },
  "auth": {
    "login": "登录",
    "logout": "退出",
    "register": "注册"
  },
  "error": {
    "networkError": "网络连接失败",
    "serverError": "服务器内部错误"
  }
}
```

### 3.4 使用示例

```vue
<template>
  <div>
    <h1>{{ $t('common.title') }}</h1>
    <button>{{ $t('common.save') }}</button>
    
    <!-- 带参数的翻译 -->
    <p>{{ $t('messages.welcome', { name: username }) }}</p>
    
    <!-- 复数形式 -->
    <p>{{ $tc('messages.items', itemCount) }}</p>
  </div>
</template>

<script setup>
import { useI18n } from 'vue-i18n';

const { t, tc, locale } = useI18n();

// 切换语言
const switchLanguage = (lang) => {
  locale.value = lang;
  localStorage.setItem('locale', lang);
};
</script>
```

### 3.5 复数规则

```json
{
  "messages": {
    "items": "没有项目 | 1 个项目 | {count} 个项目",
    "notifications": "没有通知 | 1 条通知 | {count} 条通知"
  }
}
```

### 3.6 日期和时间格式

```javascript
// 日期格式
const dateFormats = {
  'zh-CN': {
    short: 'YYYY-MM-DD',
    long: 'YYYY年MM月DD日',
    time: 'HH:mm:ss'
  },
  'en-US': {
    short: 'MM/DD/YYYY',
    long: 'MMMM DD, YYYY',
    time: 'HH:mm:ss A'
  }
};

// 使用
import dayjs from 'dayjs';
import 'dayjs/locale/zh-cn';
import 'dayjs/locale/en';

const formatDate = (date, format = 'short') => {
  return dayjs(date).locale(locale.value).format(dateFormats[locale.value][format]);
};
```

### 3.7 数字和货币格式

```javascript
// 数字格式
const numberFormats = {
  'zh-CN': {
    decimal: '.',
    thousands: ',',
    currency: '¥'
  },
  'en-US': {
    decimal: '.',
    thousands: ',',
    currency: '$'
  }
};

// 使用
const formatNumber = (num) => {
  return new Intl.NumberFormat(locale.value, {
    style: 'decimal',
    minimumFractionDigits: 2
  }).format(num);
};

const formatCurrency = (amount) => {
  return new Intl.NumberFormat(locale.value, {
    style: 'currency',
    currency: locale.value === 'zh-CN' ? 'CNY' : 'USD'
  }).format(amount);
};
```

---

## 4. 后端国际化

### 4.1 错误消息国际化

```javascript
// locales/zh-CN/errors.json
{
  "USER_NOT_FOUND": "用户不存在",
  "INVALID_PASSWORD": "密码错误",
  "EMAIL_EXISTS": "邮箱已被注册"
}

// locales/en-US/errors.json
{
  "USER_NOT_FOUND": "User not found",
  "INVALID_PASSWORD": "Invalid password",
  "EMAIL_EXISTS": "Email already exists"
}
```

### 4.2 错误消息中间件

```javascript
// middleware/i18n.js
const locales = {
  'zh-CN': require('../locales/zh-CN/errors.json'),
  'en-US': require('../locales/en-US/errors.json')
};

const i18nMiddleware = (req, res, next) => {
  const locale = req.headers['accept-language']?.split(',')[0] || 'zh-CN';
  req.locale = locale.startsWith('en') ? 'en-US' : 'zh-CN';
  req.t = (key) => locales[req.locale]?.[key] || key;
  next();
};

module.exports = i18nMiddleware;
```

### 4.3 使用示例

```javascript
router.post('/login', async (req, res) => {
  const user = await User.findOne({ where: { email: req.body.email } });
  
  if (!user) {
    return res.status(404).json({
      success: false,
      message: req.t('USER_NOT_FOUND')
    });
  }
});
```

---

## 5. 翻译管理

### 5.1 翻译流程

1. **提取**：从代码中提取需要翻译的字符串
2. **翻译**：翻译为目标语言
3. **审核**：审核翻译质量
4. **发布**：发布翻译文件

### 5.2 翻译提取工具

```bash
# 提取 Vue 文件中的翻译键
npx vue-i18n-extract

# 提取 JSON 文件中的翻译键
npx i18n-extract
```

### 5.3 翻译键命名规范

**格式**：`{module}.{feature}.{element}`

**示例**：
```
common.save
common.cancel
auth.login
auth.register
error.networkError
error.serverError
```

### 5.4 翻译质量控制

- **一致性**：相同术语使用相同翻译
- **准确性**：翻译准确表达原意
- **自然性**：翻译符合目标语言习惯

---

## 6. RTL（从右到左）语言支持

### 6.1 CSS 逻辑属性

```css
/* ✅ 正确：使用逻辑属性 */
.margin-start {
  margin-inline-start: 1rem;
}

.padding-end {
  padding-inline-end: 1rem;
}

.border-start {
  border-inline-start: 1px solid #ccc;
}

/* ❌ 错误：使用物理属性 */
.margin-left {
  margin-left: 1rem;
}
```

### 6.2 图标翻转

```css
/* RTL 模式下翻转图标 */
[dir="rtl"] .icon-arrow {
  transform: scaleX(-1);
}
```

---

## 7. 语言检测和切换

### 7.1 语言检测优先级

1. 用户显式选择的语言（localStorage）
2. URL 参数中的语言（?lang=zh-CN）
3. 浏览器语言设置
4. 默认语言（zh-CN）

### 7.2 语言切换实现

```javascript
// composables/useLanguage.js
import { ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';

export const useLanguage = () => {
  const { locale } = useI18n();
  const currentLanguage = ref(locale.value);
  
  const setLanguage = (lang) => {
    locale.value = lang;
    currentLanguage.value = lang;
    localStorage.setItem('locale', lang);
    document.documentElement.setAttribute('lang', lang);
  };
  
  // 初始化
  const initLanguage = () => {
    const saved = localStorage.getItem('locale');
    const browserLang = navigator.language;
    
    if (saved) {
      setLanguage(saved);
    } else if (browserLang.startsWith('en')) {
      setLanguage('en-US');
    } else {
      setLanguage('zh-CN');
    }
  };
  
  return {
    currentLanguage,
    setLanguage,
    initLanguage
  };
};
```

---

## 8. 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0.0 | 2026-09-04 | 初始版本，定义国际化规范 |

---

*本规范由 khy-os 国际化团队维护*