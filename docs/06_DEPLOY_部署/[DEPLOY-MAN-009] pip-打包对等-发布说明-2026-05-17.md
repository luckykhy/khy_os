<!-- 文档分类: DEPLOY-MAN-009 | 阶段: 部署 | 原路径: docs/报告/pip-打包对等-发布说明-2026-05-17.md -->
# 发布说明：Pip 打包对等性（2026-05-17）

## 变更内容

我们修复了一个打包对等性缺陷，该缺陷导致安装行为因产物路径不同而存在差异：

- 从预构建的 wheel 执行 `pip install` 时，行为符合预期。
- 从 sdist 重新构建的 wheel 可能会遗漏捆绑的运行时资源。

现在两条路径都能产出等价的安装载荷。

## 用户影响

从 sdist 重新构建的安装现在会保留所需的运行时文件，包括：

- `khy_os/bundled/frontend/dist/**`
- `khy_os/bundled/backend/bin/ollama-runner/**`
- `khy_os/bundled/backend/bin/llama-cpp/**`

这避免了因缺失 Web 资源或本地 LLM 二进制文件而导致的安装质量下降。

## 打包规则更新

- `MANIFEST.in` 现在包含重新构建捆绑载荷所需的完整源码树。
- `frontend/dist` 保留在 sdist 输入中。
- `khy_os/bundled` 从 sdist 中剔除，以避免载荷重复和体积膨胀。

## 校验快照

- 直接 wheel：`~83MB`
- sdist：`~83MB`
- 从 sdist 重新构建的 wheel：`~83MB`
- 对等性检查：文件数量与未压缩总字节数一致（`1336` 个文件，`175717621` 字节）。

## 参考

完整的根因分析与验证步骤，请参见：

- [pip-打包对等-发现-2026-05-17.md](/home/kodehu03/Khy-OS/docs/06_DEPLOY_部署/[DEPLOY-MAN-010] pip-打包对等-发现-2026-05-17.md)
