<!-- 文档分类: DEPLOY-MAN-013 | 阶段: 部署 | 原路径: docs/指南/pypi-发布手册-0.1.17-0.1.18.md -->
# PyPI 发布手册（0.1.17 补丁 + 0.1.18 多平台）

> ⚠️ **已归档 / 被取代**：本手册针对 0.1.17–0.1.18 的发布流程，已被最新的发布说明取代。当前发布流程请参阅 [发布说明-0.1.27.md](%5BDEPLOY-MAN-014%5D%20发布说明-0.1.27.md)。本文仅作历史记录保留。

## 1. 范围

本文档记录：

1. 为什么 `0.1.17` 起初只是部分支持跨平台。
2. 如何通过上传缺失的 Windows wheel 来为 `0.1.17` 打补丁。
3. 如何正确发布 `0.1.18`，使 `pip` 能按平台自动选择构件。

日期：2026-05-20

## 2. 事故摘要（0.1.17）

### 2.1 现象

1. PyPI 接受了 `sdist` 和 Linux wheel，但 Windows 用户仍可能回退到源码构建。
2. 一个标记为 `linux_x86_64` 的 Linux wheel 被 PyPI 拒绝。
3. 部分 Windows 安装尝试在从源码构建依赖时失败（例如 `cffi` 需要 MSVC）。

### 2.2 根因

1. Linux wheel 的标签与 PyPI 不兼容。
2. Windows wheel 已在本地构建，但尚未上传。
3. 在某些环境中，pip 命令的用法混用了仅源码安装与未预装 wheel 依赖。

### 2.3 已采取的修复

1. 更新了 `setup.py` 中的 wheel 平台标签映射：
   - `linux_x86_64` -> `manylinux2014_x86_64`
   - `linux_aarch64` / `linux_arm64` -> `manylinux2014_aarch64`
2. `MANIFEST.in` 已包含 `scripts/release`，以保证源码分发构建的一致性。
3. 发布脚本现在同时支持 Windows 上的 `py` 和 `python` 启动器。

## 3. 0.1.17 当前构件状态

已发布到 PyPI：

1. `khy_os-0.1.17.tar.gz`
2. `khy_os-0.1.17-py3-none-manylinux2014_x86_64.whl`

已校验、待补丁上传的 Windows wheel：

1. 文件：`khy_os-0.1.17-py3-none-win_amd64.whl`
2. SHA256：`44410aeb5e42e2d0d99626cd9b5d7b0c934090761797bcaf4f279d410d6a4a8f`
3. `twine check`：通过

## 4. 0.1.17 的补丁上传（Windows Wheel）

### 4.1 安全优先

如果任何 token 曾在聊天/日志/终端截图中暴露，请立即吊销并创建新的 PyPI token。

### 4.2 上传命令（非交互式）

```bash
TWINE_USERNAME=__token__ TWINE_PASSWORD='pypi-<NEW_TOKEN>' \
python3 -m twine upload /home/kodehu03/Downloads/khy_os-0.1.17-py3-none-win_amd64.whl
```

### 4.3 校验

```bash
python3 - <<'PY'
import json, urllib.request
u = 'https://pypi.org/pypi/khy-os/0.1.17/json'
data = json.load(urllib.request.urlopen(u, timeout=20))
for f in data['urls']:
    print(f['filename'])
PY
```

预期输出必须包含全部 3 个文件：

1. `khy_os-0.1.17.tar.gz`
2. `khy_os-0.1.17-py3-none-manylinux2014_x86_64.whl`
3. `khy_os-0.1.17-py3-none-win_amd64.whl`

## 5. 0.1.18 的标准多平台发布

### 5.0 打包策略（推荐）

采用**默认轻量化**打包方式：

1. 默认 wheel 不包含捆绑的本地运行时二进制（`backend/bin/ollama-runner`、`backend/bin/llama-cpp`）。
2. 本地运行时仍作为可选能力保留，通过系统 Ollama / 外部运行时配置启用。
3. 这样可避免 wheel 过大以及 PyPI 上传被拒。

构建开关：

1. 默认（轻量化）：无需任何环境变量。
2. 含运行时构建：在构建前设置 `KHY_INCLUDE_LOCAL_RUNTIME=1`。

### 5.1 版本同步（强制）

将以下三个文件全部更新为 `0.1.18`：

1. `pyproject.toml`
2. `khy_platform/__init__.py`
3. `backend/package.json`

### 5.2 构建矩阵

1. 轻量化模式（推荐）：
   - 构建一次并发布通用 wheel（`py3-none-any`）+ sdist。
2. 含运行时模式（可选的内部分发）：
   - Linux 构建机：`manylinux2014_x86_64` wheel + sdist。
   - Windows 构建机：`win_amd64` wheel。

### 5.3 上传顺序

推荐顺序：

1. 上传 `sdist`
2. 上传 Linux wheel
3. 上传 Windows wheel

示例：

```bash
TWINE_USERNAME=__token__ TWINE_PASSWORD='pypi-<NEW_TOKEN>' \
python3 -m twine upload dist/khy_os-0.1.18.tar.gz

TWINE_USERNAME=__token__ TWINE_PASSWORD='pypi-<NEW_TOKEN>' \
python3 -m twine upload dist/khy_os-0.1.18-py3-none-manylinux2014_x86_64.whl

TWINE_USERNAME=__token__ TWINE_PASSWORD='pypi-<NEW_TOKEN>' \
python3 -m twine upload /path/to/khy_os-0.1.18-py3-none-win_amd64.whl
```

轻量化模式构建命令示例：

```bash
rm -rf dist build khy_os.egg-info
python3 setup.py sdist bdist_wheel
ls -lh dist
```

含运行时模式构建命令示例：

```bash
rm -rf dist build khy_os.egg-info
KHY_INCLUDE_LOCAL_RUNTIME=1 python3 setup.py sdist bdist_wheel
ls -lh dist
```

### 5.4 发布后验收

在 Windows 上：

```powershell
python -m pip install -U khy-os==0.1.18
khy --version
khy gateway status
```

在 Linux 上：

```bash
python3 -m pip install -U khy-os==0.1.18
khy --version
khy gateway status
```

## 6. 常见陷阱与修复

1. `Expand-Archive` 报告找不到文件：
   - 根因：路径错误或复制命令时引入了换行。
   - 修复：将完整路径赋给变量并使用 `-LiteralPath`。
2. Windows 上找不到 `py` 命令：
   - 改用 `python`。
3. `twine upload` 交互式索要 token：
   - 在同一条命令中使用 `TWINE_USERNAME` 和 `TWINE_PASSWORD`。
4. 试图“把 0.1.17 wheel 重命名为 0.1.18”：
   - 无效。wheel 内部的版本元数据必须与构件版本一致。
5. Windows wheel 过大导致 PyPI 返回 `HTTP 400`：
   - 切换到轻量化模式（默认）并重新构建。

## 7. 操作者最小检查清单

上传前：

1. `python -m twine check <artifact>`
2. `sha256sum <artifact>`（或在 PowerShell 上用 `Get-FileHash`）
3. 确认 3 个项目文件中的版本已同步。

上传后：

1. 通过 PyPI JSON API 检查目标版本的文件列表。
2. 在干净的 Windows 与 Linux 环境中安装。
3. 验证 `khy --version` 和 `khy gateway status`。
