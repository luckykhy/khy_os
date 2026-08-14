<!-- 文档分类: DEPLOY-MAN-010 | 阶段: 部署 | 原路径: docs/报告/pip-打包对等-发现-2026-05-17.md -->
# Pip 打包对等性发现（2026-05-17）

## 摘要

我们发现了一个打包对等性问题：

- 直接从仓库构建 wheel 会生成完整包（约 `~83MB` 的 wheel）。
- 从已发布的 sdist 构建 wheel 则生成精简包（修复前约 `~3.3MB` 的 wheel）。

这意味着 `pip install` 的行为取决于安装方是直接使用 wheel，还是从 sdist 重新构建。

## 影响

修复前，从 sdist 重新构建的 wheel 缺失了关键的运行时资源：

- `khy_os/bundled/frontend/dist/**`（缺失）
- `khy_os/bundled/backend/bin/ollama-runner/**`（缺失）
- `khy_os/bundled/backend/bin/llama-cpp/**`（缺失）

结果：通过 sdist 重新构建进行的安装可能会丢失 Web 运行时资源和本地 LLM 二进制文件。

## 根本原因

两条规则之间产生了不良的相互作用：

1. `setup.py` 在构建 wheel 时总是从顶层 `backend/frontend/...` 重新生成 `khy_os/bundled`。
2. 用于 sdist 的 `MANIFEST.in` 使用了狭窄的扩展名过滤规则并裁剪掉了 `frontend/dist`，因此 sdist 内部的顶层源码并不完整。

因此，从 sdist 重新构建 wheel 时会重新生成一份更小的 bundled 负载。

## 已应用的修复

更新了 [`MANIFEST.in`](/home/kodehu03/Khy-OS/MANIFEST.in)：

1. 将顶层源码的包含方式切换为广义的整树包含：
   - `recursive-include backend *`
   - `recursive-include frontend *`
   - `recursive-include packages/shared *`
   - `recursive-include docs *`
2. 在 sdist 中保留 `frontend/dist`（移除了 `prune frontend/dist`）。
3. 添加 `prune khy_os/bundled` 以避免重复打包（顶层源码 + bundled 副本）。

这样既保留了重新构建所需的输入，又控制了 sdist 的体积。

## 验证

### 修复前

- 直接构建的 wheel：`~83MB`
- sdist：`~85MB`
- 从 sdist 重新构建的 wheel：`~3.3MB`
- 重新构建的 wheel 检查：
  - `frontend_dist`：`0`
  - `backend_bin_ollama`：`0`
  - `backend_bin_llama`：`0`

### 修复后

- 直接构建的 wheel：`~83MB`
- sdist：`~83MB`
- 从 sdist 重新构建的 wheel：`~83MB`

对等性检查（直接构建的 wheel vs 从 sdist 构建的 wheel）：

- 文件数量：`1336` vs `1336`
- 解压后总字节数：`175717621` vs `175717621`
- 存在性检查：
  - `frontend_dist`：存在（`76` 项）
  - `frontend_src`：存在（`137` 项）
  - `backend_bin_ollama`：存在（`9` 项）
  - `backend_bin_llama`：存在（`53` 项）
  - `backend_ml`：不存在（`0` 项，符合打包策略预期）

## 复现 / 验证命令

```bash
python3 -m build --wheel --no-isolation
python3 -m build --sdist --no-isolation

# Rebuild wheel from sdist in temp dir and inspect:
tmpdir=$(mktemp -d /tmp/khy_sdist_build_check_XXXXXX)
tar -xzf dist/khy_os-0.1.9.tar.gz -C "$tmpdir"
cd "$tmpdir/khy_os-0.1.9"
python3 -m build --wheel --no-isolation
```

## 发布说明

自本版本起及之后的版本，wheel 与 sdist 两种安装路径在 bundled 运行时负载上已保持一致。
