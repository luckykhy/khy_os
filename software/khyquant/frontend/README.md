# KhyQuant Frontend

量化交易终端前端应用，基于 Vue 3 + Vite + Element Plus 构建。

## 项目概述

KhyQuant 是 khy-os 项目的量化交易终端，提供完整的量化交易功能，包括：

- 实时行情监控
- 策略管理与回测
- 交易执行
- 风险管理
- 数据分析与可视化

## 技术栈

- **框架**: Vue 3 (Composition API)
- **构建工具**: Vite
- **UI 组件库**: Element Plus
- **状态管理**: Pinia
- **图表库**: Lightweight Charts
- **PWA**: vite-plugin-pwa
- **样式**: CSS Variables + SCSS

## 项目结构

```
src/
├── api/                # API 接口
├── assets/             # 静态资源
├── components/         # 组件
│   ├── base/          # 基础组件
│   ├── business/      # 业务组件
│   └── layout/        # 布局组件
├── composables/        # 组合式函数
├── config/             # 配置文件
├── router/             # 路由
├── stores/             # Pinia 状态
├── styles/             # 样式
├── utils/              # 工具函数
└── views/              # 页面视图
```

## 快速开始

### 安装依赖

```bash
npm install
# 或
pnpm install
```

### 开发环境

```bash
npm run dev
```

访问 http://localhost:5173

### 构建生产版本

```bash
npm run build
```

### 预览生产版本

```bash
npm run preview
```

## 开发规范

### 代码风格

- 使用 ESLint + Prettier 进行代码格式化
- 遵循 Vue 3 Composition API 最佳实践
- 使用 CSS Variables 定义设计令牌

### 组件规范

- 组件使用 PascalCase 命名：`UserProfile.vue`
- 基础组件以 `Khy` 前缀：`KhyButton.vue`
- 业务组件使用描述性名称：`TradingChart.vue`

### 状态管理

- 使用 Pinia 进行状态管理
- 按功能模块划分 store
- 使用 composables 封装可复用逻辑

### 样式规范

- 使用 CSS Variables 定义颜色、间距、字体等
- 遵循 BEM 命名规范
- 支持深色/浅色主题切换

## 测试

```bash
# 运行单元测试
npm run test

# 运行测试并监听变化
npm run test:watch

# 生成覆盖率报告
npm run test:coverage
```

## 部署

### PWA 支持

项目支持 PWA，可以安装为桌面应用：

1. 构建生产版本：`npm run build`
2. 部署到 HTTPS 服务器
3. 用户访问时会提示安装

### Docker 部署

```dockerfile
FROM node:18-alpine as build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/nginx.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
```

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `VITE_API_BASE_URL` | API 基础地址 | `http://localhost:3000` |
| `VITE_APP_TITLE` | 应用标题 | `KhyQuant` |
| `VITE_APP_VERSION` | 应用版本 | `1.0.0` |

## 相关文档

- [前端页面规范](../../../docs/03_DESIGN_设计/[DESIGN-FE-001]%20前端页面规范.md)
- [前端组件库规范](../../../docs/03_DESIGN_设计/[DESIGN-FE-002]%20前端组件库规范.md)
- [前端快速参考卡](../../../docs/03_DESIGN_设计/[DESIGN-FE-003]%20前端快速参考卡.md)

## 许可证

MIT License

---

*本项目由 khy-os 团队维护*