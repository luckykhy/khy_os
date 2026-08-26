# GitHub / Gitee 双仓同步

## 本机提交后自动同步

安装受管 hook：

```powershell
node scripts/lib/ext-run.js khy-installer hooks
```

为当前仓库配置 Gitee 远端（地址只保存仓库 URL，不保存令牌）：

```powershell
git remote add gitee https://gitee.com/OWNER/REPOSITORY.git
```

令牌交给 Git Credential Manager 保存。首次推送时按提示输入 Gitee 用户名和令牌；也可以使用 SSH 远端：

```powershell
git remote set-url gitee git@gitee.com:OWNER/REPOSITORY.git
```

hook 会依次推送 `origin` 和 `gitee`，任一远端失败都保留本地提交，并把这次欠账记进补推队列（见下节）。

## 断网 / 令牌失效：本地留账，恢复后补推

`post-commit` hook 里的推送必然会撞上断网和令牌过期。失败**不只是打一行警告**，而是写进
`.khy/sync/mirror-queue.json`（在 `.khy/`，不入库），下一次提交或一次手动 retry 会自动补齐。

```powershell
npm run sync:mirrors           # 补推队列 + 推当前分支（手动等价于 hook）
npm run sync:mirrors:retry     # 只补推队列：网络恢复、令牌更新后执行这一条
npm run sync:mirrors:status    # 只看欠账，不发起任何推送（加 --json 取机器可读输出）
```

失败被分成四类，决定「能不能自动重试」：

| 种类 | 触发 | 行为 |
| --- | --- | --- |
| `network` | 域名解析失败、连接超时/重置、TLS 握手失败、RPC 中断 | 记账；下次提交或 retry 自动重推 |
| `auth` | 认证失败、401/403、令牌过期或被吊销、终端提示被禁用 | 记账；**更新令牌后** retry 才会成功 |
| `diverged` | `non-fast-forward`、远端已领先 | 记账但不盲目重放；`git fetch && git rebase` 后本地 tip 变化会自动放行一次（`--force` 可强制重放） |
| `unknown` | 未归类的失败 | 记账并保留最近几行原始报错，retry 时重试 |

要点：

- **hook 用 `--non-interactive`**：令牌缺失或过期时立刻失败并记账，绝不弹凭据框把 `git commit` 挂住。
  首次配置凭据请手动跑一次 `npm run sync:mirrors:retry`（交互模式，可正常输入用户名/令牌）。
- **队列以 `(远端, 分支)` 为主键**，同一分支只留一条并累加 `attempts`：补推的是分支当前 tip，
  一次成功就把之前所有欠账一起清掉。
- **推送成功即清账**；本地分支已被删除或历史被重写掉的条目在下次执行时自动移除，不会永久刷警告。
- **落盘前抹除凭据**：git 报错会原样回显远端 URL，其中可能内联 `https://user:token@host/...`；
  写队列前统一过 `redactSecrets()`。
- **空闲窗口守护**：单次 `git push` 静默超过 45 秒判定卡死并软终止（本地提交与队列不受影响），
  不用固定总时长硬杀，所以大仓的慢推送不会被误伤。
- 退出码默认 0（hook 绝不能把成功的本地提交变成失败的提交）；CI 里想让失败亮红灯加 `--strict`。

代码位置：纯逻辑（失败分类 / 队列 reducer / 文案）在 `scripts/lib/mirrorSyncQueue.js`，
契约测试在 `scripts/tests/mirrorSyncQueue.test.js`；IO 与 git 调用在 `scripts/sync/mirror-sync.js`，
`scripts/sync/push-mirrors.sh` 只是保持向后兼容的薄封装。

## GitHub Actions 兜底

`.github/workflows/sync-gitee.yml` 会在 `main` / `master` 更新后从 GitHub 拉取同一提交并推送到 Gitee。仓库设置中配置：

- Actions secret：`GITEE_TOKEN`
- Actions variable：`GITEE_USER`（Gitee 用户名）
- Actions variable：`GITEE_REPOSITORY`（例如 `OWNER/REPOSITORY`）

完成配置后，即使本机离线或 hook 未安装，GitHub 仍会把主干同步到 Gitee。工作流也支持手动运行，用于补齐历史落后分支。

注意这层兜底只覆盖「已经推到 GitHub 的提交」：本机对 GitHub 的推送本身失败时（断网、令牌过期），
补齐工作仍然由上面的本地补推队列负责。
