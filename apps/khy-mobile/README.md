# Khy Mobile

khy-os 移动端伴侣应用，基于 Vue 3 + Capacitor 构建。

## 项目概述

Khy Mobile 是 khy-os 项目的移动端应用，提供以下功能：

- AI 对话与助手
- 量化交易监控
- 策略管理
- 实时行情
- 推送通知

## 技术栈

- **框架**: Vue 3 (Composition API)
- **构建工具**: Vite
- **原生能力**: Capacitor
- **UI 组件**: 自定义组件 + Tailwind CSS
- **状态管理**: Pinia
- **样式**: CSS Variables + 森林治愈系设计风格

## 项目结构

```
src/
├── api/                # API 接口
├── assets/             # 静态资源
├── components/         # 组件
│   ├── base/          # 基础组件
│   ├── business/      # 业务组件
│   └── native/        # 原生组件
├── composables/        # 组合式函数
├── config/             # 配置文件
├── plugins/            # Capacitor 插件
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

### 构建 Android 应用

```bash
# 构建 Web 资源
npm run build

# 同步到 Android 项目
npx cap sync android

# 打开 Android Studio
npx cap open android
```

### 构建 iOS 应用

```bash
# 构建 Web 资源
npm run build

# 同步到 iOS 项目
npx cap sync ios

# 打开 Xcode
npx cap open ios
```

## 开发规范

### 代码风格

- 使用 ESLint 进行代码格式化
- 遵循 Vue 3 Composition API 最佳实践
- 使用 CSS Variables 定义设计令牌

### 组件规范

- 组件使用 PascalCase 命名：`UserProfile.vue`
- 基础组件以 `Khy` 前缀：`KhyButton.vue`
- 业务组件使用描述性名称：`TradingChart.vue`
- 原生组件以 `Native` 前缀：`NativeCamera.vue`

### 设计风格

采用森林治愈系设计风格：

- **主色调**: 嫩叶绿 (#6fa978)
- **背景色**: 奶白 (#f4f1e6)
- **强调色**: 湖蓝 (#6ea4b8)
- **圆角**: 14-20px，药丸形状
- **字体**: Quicksand / SF Pro Rounded + PingFang/Noto Sans SC

### 状态管理

- 使用 Pinia 进行状态管理
- 按功能模块划分 store
- 使用 composables 封装可复用逻辑

## 原生功能

### Capacitor 插件

- **Camera**: 相机拍照
- **Filesystem**: 文件系统访问
- **Geolocation**: 地理位置
- **Push Notifications**: 推送通知
- **Screen Capture**: 屏幕截图
- **Shizuku**: Android 系统级权限

### 权限管理

```javascript
import { Camera } from '@capacitor/camera';

// 请求相机权限
const requestCameraPermission = async () => {
  const permission = await Camera.requestPermissions();
  return permission.camera === 'granted';
};
```

## 测试

```bash
# 运行单元测试
npm run test

# 运行测试并监听变化
npm run test:watch
```

## 部署

### Android 部署

1. 构建应用：`npm run build`
2. 同步到 Android：`npx cap sync android`
3. 打开 Android Studio：`npx cap open android`
4. 在 Android Studio 中构建 APK

### iOS 部署

1. 构建应用：`npm run build`
2. 同步到 iOS：`npx cap sync ios`
3. 打开 Xcode：`npx cap open ios`
4. 在 Xcode 中构建 IPA

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `VITE_API_BASE_URL` | API 基础地址 | `http://localhost:3000` |
| `VITE_APP_TITLE` | 应用标题 | `Khy Mobile` |
| `VITE_APP_VERSION` | 应用版本 | `1.0.0` |

## 相关文档

- [前端页面规范](../../docs/03_DESIGN_设计/[DESIGN-FE-001]%20前端页面规范.md)
- [前端组件库规范](../../docs/03_DESIGN_设计/[DESIGN-FE-002]%20前端组件库规范.md)
- [前端快速参考卡](../../docs/03_DESIGN_设计/[DESIGN-FE-003]%20前端快速参考卡.md)

## 许可证

MIT License

---

*本项目由 khy-os 团队维护*