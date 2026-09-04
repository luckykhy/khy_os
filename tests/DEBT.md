# 测试债务登记 (Test Debt Register)

> **定位**：登记当前已知失败的测试用例，防止"非阻塞"变成"永久忽略"。
> **规则**：
> - 每个失败用例必须登记，包含分类、负责人、预计修复日期
> - 只有 `@env-skip` 类可永久跳过，`@flaky` 和 `@bug` 必须修复
> - 3 个月后：`@bug` 类用例失败时阻断 PR
> - 6 个月后：所有用例阻断 PR
> - 门禁升级路径见 `.github/workflows/pr-gate.yml` 的 `test-baseline` job
> **最后更新**：2026-09-03

## 统计

| 分类 | 数量 | 说明 |
|------|------|------|
| @env-skip | 0 | 环境依赖，可永久跳过 |
| @flaky | 0 | 竞态条件，需重试机制 |
| @bug | 9 | 真实 bug，必须修复 |
| **总计** | **9** | |

## 失败用例清单

> 以下为实测基线（tests/cli + tests/utils，58 个 suite 取样）。
> 每个用例需补充：失败原因、负责人、预计修复日期。

### tests/cli 区域

| # | 用例路径 | 分类 | 失败原因 | 负责人 | 预计修复 | 关联 Issue |
|---|----------|------|---------|--------|---------|-----------|
| 1 | `tests/cli/...` | @bug | 待诊断 | 未分配 | TBD | #TBD |
| 2 | `tests/cli/...` | @bug | 待诊断 | 未分配 | TBD | #TBD |
| 3 | `tests/cli/...` | @bug | 待诊断 | 未分配 | TBD | #TBD |
| 4 | `tests/cli/...` | @bug | 待诊断 | 未分配 | TBD | #TBD |

### tests/utils 区域

| # | 用例路径 | 分类 | 失败原因 | 负责人 | 预计修复 | 关联 Issue |
|---|----------|------|---------|--------|---------|-----------|
| 5 | `tests/utils/...` | @bug | 待诊断 | 未分配 | TBD | #TBD |
| 6 | `tests/utils/...` | @bug | 待诊断 | 未分配 | TBD | #TBD |
| 7 | `tests/utils/...` | @bug | 待诊断 | 未分配 | TBD | #TBD |
| 8 | `tests/utils/...` | @bug | 待诊断 | 未分配 | TBD | #TBD |
| 9 | `tests/utils/...` | @bug | 待诊断 | 未分配 | TBD | #TBD |

## 门禁升级路径

| 阶段 | 时间 | 行为 |
|------|------|------|
| Phase 1 (当前) | 2026-09-03 | `continue-on-error`，仅报告 |
| Phase 2 | 2026-12-03 (3个月后) | `@env-skip` 跳过，`@bug` 阻断 |
| Phase 3 | 2027-03-03 (6个月后) | 所有用例阻断 |

## 如何诊断失败用例

```powershell
# 运行单个失败的测试文件
npm run test:one -- tests/cli/<file>.test.js

# 查看详细错误
cd services/backend
node --test --test-name-pattern="<test name>" tests/cli/<file>.test.js
```

## 如何登记新发现的失败用例

1. 在上方表格追加一行
2. 分类为 `@env-skip` / `@flaky` / `@bug`
3. 诊断失败原因并记录
4. 分配负责人和预计修复日期
5. 创建关联 Issue

## 修复完成后

1. 运行测试验证通过
2. 从表格中删除该用例
3. 更新统计数字
4. 关闭关联 Issue
