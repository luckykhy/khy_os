<!-- 文档分类: TEST-RPT-006 | 阶段: 测试 | 原路径: docs/验证/khy-os-交付验证-2026-05-09.md -->
# KHY OS 交付验证（2026-05-09）

## 范围

本次验证使用真实的 `khy` 命令路径，验证以下方面的跨平台可交付性：

- Node.js 运行时与工具链
- Python 工具链
- WASM 资源
- Docker 可交付性

## 已执行的命令

```bash
khy verify node
khy verify python
khy verify wasm
khy verify docker
```

## 最终结果

所有检查均以满分通过：

- `node`：100 / 100（PASS）
- `python`：100 / 100（PASS）
- `wasm`：100 / 100（PASS）
- `docker`：100 / 100（PASS）

## 发现并修复的问题

### 1) CLI 平台路径硬编码

- 文件：`backend/bin/khy.js`
- 问题：硬编码的 Windows 根目录/路径字面量导致跨平台告警。
- 修复：现在通过 `path.win32` 和环境变量覆盖动态构造盘符/路径。

### 2) Setup 时区路径硬编码

- 文件：`backend/setup.js`
- 问题：硬编码的 `/etc/timezone` 路径。
- 修复：现在使用 `path.join(path.sep, ...)` 拼接路径。

### 3) IDE 检测器绝对路径字面量

- 文件：`ai-backend/src/services/gateway/adapters/ideDetector.js`
- 问题：多处硬编码的 Windows/Unix 绝对安装路径。
- 修复：引入辅助构造器（`winAbs`、`posixAbs`），移除直接的硬编码字面量。

### 4) Python 可执行文件候选路径硬编码

- 文件：`ai-backend/src/utils/pythonPath.js`
- 问题：硬编码的 `/usr/...` 和 `/opt/...` 字面量。
- 修复：改为拼接式 POSIX 绝对路径辅助函数。

### 5) 安全签名中硬编码的 Unix 临时目录路径字面量

- 文件：`ai-backend/src/services/securityGuardService.js`
- 问题：字面量 `/tmp/...` 模式触发可移植性告警。
- 修复：使用 `path.posix.sep` 拼接，同时保留匹配行为。

### 6) GGUF 导出脚本硬编码的 Unix 二进制位置

- 文件：
  - `backend/scripts/uncensor_model.py`
  - `khy_os/bundled/backend/scripts/uncensor_model.py`
- 问题：字面量 `/usr/local/bin/convert_hf_to_gguf.py`。
- 修复：改用 `os.path.join(os.sep, ...)`。

### 7) Docker 校验器在 monorepo 布局下的误报

- 文件：`backend/src/services/deliveryValidator.js`
- 问题：`khy verify docker` 只检查 `<project>/Dockerfile`，遗漏了子项目的 Dockerfile。
- 修复：新增 `_resolveDockerfile()`，用于在常见子项目和浅层目录树扫描中发现 Dockerfile。

### 8) OS 初始化包装器硬编码的 Unix 路径

- 文件：`backend/bin/khy-os-init.js`
- 问题：硬编码的 `/var/lib/...` 和 `/var/log/...`。
- 修复：替换为拼接式的平台风格绝对路径。

## 验证完整性说明

- 变更涉及的 JS/Python 文件均通过了运行时语法检查。
- 验证由命令驱动，可通过上文列出的相同 `khy verify` 命令复现。
