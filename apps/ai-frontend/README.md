# Khy AI Frontend

AI 平台管理前端 - Vue 3 + Vite + Element Plus

## 技术栈

- Vue 3 (Composition API)
- Vite
- Vue Router
- Pinia (状态管理)
- Element Plus (UI 组件库)
- ECharts (数据可视化)
- Axios (HTTP 客户端)

## 开发

```bash
# 安装依赖
npm install

# 启动开发服务器
npm run dev

# 构建生产版本
npm run build

# 预览生产构建
npm run preview
```

## 项目结构

```
src/
├── main.js           # 应用入口
├── App.vue           # 根组件
├── router/           # 路由配置
├── stores/           # Pinia 状态管理
├── views/            # 页面组件
├── components/       # 通用组件
├── utils/            # 工具函数
└── assets/           # 静态资源
```

## API 代理

开发模式下，`/api` 请求会代理到 `http://localhost:5000`。

生产环境需要配置 Nginx 或其他反向代理。
