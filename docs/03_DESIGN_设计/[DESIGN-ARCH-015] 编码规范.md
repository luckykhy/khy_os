<!-- 文档分类: DESIGN-ARCH-015 | 阶段: 设计 | 原路径: docs/设计模式/编码规范.md -->
# GoF 23 设计模式标注规范

## 项目级设计模式 — Facade（外观模式）

**Khy-OS 整体 = Facade**

```
                        用户
                         │
                    ┌────▼────┐
                    │  Facade │
                    │ khy CLI │
                    │ Web UI  │
                    │REST API │
                    └────┬────┘
         ┌───────┬───────┼───────┬──────────┐
      Kernel   AI网关  量化引擎  插件系统   前端UI
      (C/ASM) (Node.js) (Python) (packages) (Vue)
```

Khy-OS 对外暴露单一入口（`khy` 命令 / Web UI / REST API），将内核、AI 网关、量化引擎、插件系统、前端 UI 等异构子系统的全部复杂性封装在一个统一外观之后。用户无需了解底层子系统的存在即可操作整个平台，这正是 Facade 模式的核心定义。

## 概述

本项目要求每个源文件（排除测试、构建产物、node_modules）都必须至少归属一种 GoF 23 设计模式。

- **标注方式**: 文件头部 JSDoc 注释中使用 `@pattern` 标签
- **机器映射**: `docs/design-patterns/pattern-registry.json` 存储全量映射
- **CI 验证**: `scripts/ci/check-pattern-coverage.js` 确保 100% 覆盖

## @pattern 标签规范

在文件头部注释中添加（已有头部注释则追加，无则新建）：

```js
/**
 * @pattern Strategy, Facade
 */
```

```c
/**
 * @pattern Singleton, Builder
 */
```

```python
# @pattern Template Method, Command
```

```vue
<!-- @pattern Composite, Observer -->
```

```asm
; @pattern Template Method
```

```sh
# @pattern Command, Template Method
```

### 规则

1. 一个文件可以标注多个模式，用英文逗号分隔
2. 模式名使用英文全称（见下表）
3. 标注必须有代码结构支撑，不为模式而模式
4. `pattern-registry.json` 是权威来源，注释是辅助

## 23 种设计模式名称映射

### 创建型（5种）— 口诀：单工抽建原

| 英文名 | 中文名 | 助记 | 典型场景 |
|--------|--------|------|----------|
| Singleton | 单例模式 | 单 | 模块级单例状态、注册表、管理器、Pinia stores |
| Factory Method | 工厂方法模式 | 工 | 工具注册工厂、agent 创建、技能加载器 |
| Abstract Factory | 抽象工厂模式 | 抽 | 插件上下文工厂、适配器系列创建 |
| Builder | 建造者模式 | 建 | prompt 构建、配置构建、GDT/IDT 构建 |
| Prototype | 原型模式 | 原 | agent 上下文 fork、进程 fork、模板克隆 |

### 结构型（7种）— 口诀：适桥组装外享代

| 英文名 | 中文名 | 助记 | 典型场景 |
|--------|--------|------|----------|
| Adapter | 适配器模式 | 适 | gateway adapters、平台适配、硬件驱动、格式转换 |
| Bridge | 桥接模式 | 桥 | 协议转换层、SDK transport、远程审批桥 |
| Composite | 组合模式 | 组 | Vue 组件树、菜单树、文件系统树、agent 组合 |
| Decorator | 装饰器模式 | 装 | 日志增强、审计追踪、性能剖析、中间件包装 |
| Facade | 外观模式 | 外 | 服务入口、API 层、仪表盘、数据聚合服务 |
| Flyweight | 享元模式 | 享 | 常量/配置共享、类型定义、别名表、共享缓存 |
| Proxy | 代理模式 | 代 | 中间件守卫、限流代理、沙箱、资源守护 |

### 行为型（11种）— 口诀：责命解迭中备观状策模访

| 英文名 | 中文名 | 助记 | 典型场景 |
|--------|--------|------|----------|
| Chain of Responsibility | 责任链模式 | 责 | 中间件链、钩子执行链、权限检查链 |
| Command | 命令模式 | 命 | 工具文件、路由处理器、CLI handler、系统调用 |
| Interpreter | 解释器模式 | 解 | TDX 公式引擎、ELF/PE 解析、指令解析 |
| Iterator | 迭代器模式 | 迭 | 流解析(SSE/NDJSON)、round-robin、CSV 解析 |
| Mediator | 中介者模式 | 中 | REPL 协调、消息路由、设备配对、IPC |
| Memento | 备忘录模式 | 备 | 状态持久化、崩溃恢复、会话快照、localStorage |
| Observer | 观察者模式 | 观 | Vue 响应式、SSE 事件流、WebSocket、钩子注册 |
| State | 状态模式 | 状 | 断路器、任务状态机、进程状态机、连接状态 |
| Strategy | 策略模式 | 策 | 算法选择、调度模式、限流策略、渲染策略 |
| Template Method | 模板方法模式 | 模 | 工具执行骨架、启动流程、脚本、迁移 |
| Visitor | 访问者模式 | 访 | 文档树遍历、CI 文件检查、任务思维导图渲染 |

## 分类优先级

当一个文件可归属多种模式时，按以下优先级选择主模式（可同时标注多个）：

1. **最具结构特征的模式**（如文件实现了 Adapter 接口 → 首选 Adapter）
2. **核心职责对应的模式**（如文件是状态机 → 首选 State）
3. **次要特征模式**（如同时使用了 Singleton → 追加 Singleton）

## CI 验证

```bash
node scripts/ci/check-pattern-coverage.js
```

- 覆盖率必须 = 100%
- 每种模式至少使用 1 次
- 文件不在 registry 中视为未覆盖
