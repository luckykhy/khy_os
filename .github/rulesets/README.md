# 分支保护 / ruleset-as-code

本目录把仓库的保护规则以 JSON 版本化，避免「只有点过网页的人才知道规则是什么」。
每个文件对应一个 GitHub Ruleset，用 `gh api` 应用。

| 文件 | 作用 |
| --- | --- |
| `default-branch-protection.json` | 保护默认分支：必须走 PR、必须过状态检查、禁止强推与删除 |
| `release-tag-immutability.json` | `v*` 标签不可删除、不可重指向 —— 已发布的版本号不能被换掉 |

---

## 前置条件

1. 仓库已有远端。**当前本地仓库没有配置任何 remote**（`git remote -v` 为空），
   规则只能作用于 GitHub 上的仓库，因此第一步是：

   ```bash
   git remote add origin https://github.com/kodehu03/khy-os.git
   git push -u origin master
   ```

2. `gh` CLI 已登录且对该仓库有 admin 权限：

   ```bash
   gh auth status
   ```

3. **默认分支上已经存在这些 workflow 文件。** 状态检查是按名字匹配的，
   如果 `pr-gate.yml` 还没进默认分支，规则里列的 check 永远不会上报，PR 会一直卡在
   "Expected — waiting for status to be reported"。所以顺序必须是：
   先合并 CI 配置，再应用规则。

---

## 应用

```bash
# 逐个创建
gh api --method POST repos/kodehu03/khy-os/rulesets \
  --input .github/rulesets/default-branch-protection.json

gh api --method POST repos/kodehu03/khy-os/rulesets \
  --input .github/rulesets/release-tag-immutability.json
```

## 查看 / 更新 / 删除

```bash
# 列出现有 ruleset 及其 id
gh api repos/kodehu03/khy-os/rulesets --jq '.[] | "\(.id)\t\(.name)\t\(.enforcement)"'

# 导出线上规则，和本目录对比，确认没有人在网页上偷偷改过
gh api repos/kodehu03/khy-os/rulesets/<id> > /tmp/live.json

# 更新（PUT 是整体替换，不是合并）
gh api --method PUT repos/kodehu03/khy-os/rulesets/<id> \
  --input .github/rulesets/default-branch-protection.json

# 删除
gh api --method DELETE repos/kodehu03/khy-os/rulesets/<id>
```

## 先干跑再启用

不确定规则会不会挡住正常工作时，把 `enforcement` 改成 `"evaluate"` 再创建 ——
GitHub 会记录「本来会被拦」但不真的拦。观察几天后改回 `"active"`。

> `evaluate` 模式需要 GitHub Team / Enterprise 计划。免费计划下只有 `active` 与
> `disabled` 可用；如果创建时报 `enforcement` 无效，说明当前计划不支持干跑模式。

---

## 设计说明

### 为什么用 `~DEFAULT_BRANCH` 而不写死 `master`

仓库当前主干名是 `master`，但 workflow 已同时监听 `main` 与 `master`。
用 `~DEFAULT_BRANCH` 这个内置占位符，将来重命名主干不需要改规则。

### 必需的状态检查为什么只列 3 个

| 检查 | 是否必需 | 原因 |
| --- | --- | --- |
| `Contract checks` | ✅ | 确定性检查，实测全绿 |
| `Python syntax` | ✅ | 纯语法，只查变更文件，零误伤 |
| `Lint ratchet` | ✅ | 只对**新增**文件零容忍，存量文件仅报告 |
| `Test baseline (non-blocking)` | ❌ | 现存 9 个已知失败用例，设为必需等于所有 PR 无法合并 |
| `Verify CODEOWNERS` | ❌ | **带 `paths:` 过滤器**。路径过滤的 workflow 在不相关的 PR 上根本不会运行，也就永远不上报状态 —— 一旦设为必需，这类 PR 会永久停在等待状态。这是分支保护最常见的自锁方式。 |
| `AI frontend` / `KhyQuant frontend` | ❌ | 同上，`frontend-ci.yml` 带 `paths:` 过滤器。此外 KhyQuant 的 lint 步骤当前必失败（缺 `eslint-plugin-vue` 依赖），已标为报告态。 |
| CodeQL | ❌ | 矩阵作业的 check 名随语言变化（`Analyze (javascript)` 之类），钉死名字容易在改矩阵时静默失效；先观察实际上报名，确认后再加 |

check 的名字就是 workflow 里 job 的 `name:` 字段。改了 job 名字，规则必须同步改 ——
否则规则会静默地不再生效（GitHub 不会因为找不到 check 而报错，只会一直等）。
改完可用下面这条对照：

```bash
# 看某个 PR 实际上报了哪些 check 名
gh pr checks <pr-number> --json name,state
```

### 为什么开 `required_linear_history` + squash

保持主干一条直线，`git bisect` 才有意义。配合 `strict_required_status_checks_policy`
（合并前分支必须已是最新），代价是需要更频繁 rebase —— 对本仓库这种改动规模上限
20 个文件、鼓励短分支的流程，这个代价是可接受的。

### bypass_actors 故意留空

没有任何人可以绕过。如果紧急修复确实需要绕过，显式加上并写清原因，例如：

```json
"bypass_actors": [
  { "actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "pull_request" }
]
```

（`actor_id: 5` 是 Admin 角色；`bypass_mode: "pull_request"` 表示仅在 PR 场景可绕过，
比 `"always"` 收敛。）**加了就要在 PR 里说明**，不要静默放开。

### 关于 `allowed_merge_methods`

这是较新加入 rulesets API 的参数。如果创建时 GitHub 报未知参数错误，
删掉 `default-branch-protection.json` 里的这一行即可，其余规则不受影响；
合并方式改到仓库 Settings → General → Pull Requests 里限制。

---

## 应用后的自检

```bash
# 1. 规则确实存在且为 active
gh api repos/kodehu03/khy-os/rulesets --jq '.[] | "\(.name): \(.enforcement)"'

# 2. 直推默认分支应当被拒
git commit --allow-empty -m "chore: protection probe" && git push origin master
#    预期：remote 拒绝，提示 "Changes must be made through a pull request"
git reset --hard HEAD~1

# 3. CODEOWNERS 是否被 GitHub 认可（无效 owner 会被静默忽略）
gh api repos/kodehu03/khy-os/codeowners/errors
```
