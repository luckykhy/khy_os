# [DESIGN-FE-011] 组件质量保证规范

> **定位**：代码质量、测试覆盖率、性能监控三道质量门。
> **隶属**：本文是 [`[DESIGN-FE-002]` 前端组件库规范]([DESIGN-FE-002] 前端组件库规范.md) 的**子篇**；主篇是唯一入口与 scope 裁决真源，本文只承载细则。
> **状态**：随主篇——主篇 §0 声明为「目标态、非现状」，本文同样在组件库真正落地后才生效；在此之前一切以 [`[DESIGN-FE-001]` 前端页面规范]([DESIGN-FE-001] 前端页面规范.md) 为准。

---


### 7.1 代码质量

**ESLint 规则**：
```javascript
// .eslintrc.js
module.exports = {
  extends: [
    'eslint:recommended',
    'plugin:vue/vue3-recommended',
    'prettier'
  ],
  rules: {
    'vue/multi-word-component-names': 'off',
    'vue/no-v-html': 'warn',
    'vue/require-default-prop': 'error',
    'vue/require-prop-types': 'error'
  }
};
```

**Prettier 配置**：
```json
{
  "printWidth": 100,
  "tabWidth": 2,
  "singleQuote": true,
  "trailingComma": "es5",
  "arrowParens": "always",
  "endOfLine": "lf"
}
```

### 7.2 测试覆盖率

**覆盖率要求**：
```javascript
// vitest.config.js
export default {
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['node_modules/', 'src/__tests__/'],
      thresholds: {
        branches: 80,
        functions: 80,
        lines: 80,
        statements: 80
      }
    }
  }
};
```

### 7.3 性能监控

**Bundle 大小**：
```javascript
// rollup.config.js
export default {
  output: {
    file: 'dist/khy-components.esm.js',
    format: 'esm',
    sourcemap: true
  },
  plugins: [
    visualizer({
      open: true,
      gzipSize: true
    })
  ]
};
```

**性能预算**：
```json
{
  "budgets": [
    {
      "type": "initial",
      "maximumWarning": "500kb",
      "maximumError": "1mb"
    },
    {
      "type": "anyComponentStyle",
      "maximumWarning": "2kb",
      "maximumError": "4kb"
    }
  ]
}
```

---
